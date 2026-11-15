# pi-ucp-shop

OpenCode orchestrates → a pi-durable harness runs the agent loop → UCP reaches real Shopify
merchant catalogs. Every step the agent takes is committed to SQLite before it is shown, so an
interrupted run resumes instead of starting over.

```
OpenCode  /shop "blue Patagonia puffer, mens L, in Montreal"
   └─ .opencode/commands/shop.md
        └─ pi_shop tool  (.opencode/tools/pi_shop.ts)
             └─ node durable/run.ts --thread <id> --task "..."
                  ├─ Harness over .shop-state/<thread>.sqlite
                  │    model: llama.cpp at 127.0.0.1:8080 (durable/models.ts)
                  │    extension: shop — two tools, nothing else
                  ├─ shop_search  (durable/tools.ts → shop/core.ts)
                  │    └─ ucp catalog search --format json
                  │         └─ global catalog, filtered by ships_to / ships_from
                  └─ shop_stores  (same)
                       └─ ucp discover, then search_locations on the merchant's
                          own endpoint: https://<domain>/api/ucp/mcp
```

The logic lives once, in `shop/core.ts`. Two harnesses wrap it:

| path | adapter | what it adds |
|---|---|---|
| pi-durable (default) | `durable/tools.ts` | crash recovery, atomic commits, replay-safe tools |
| pi the CLI (still works) | `.pi/extensions/shop_search.ts` | a TUI you can sit in and watch |

## Surviving restarts

This is the point of the pi-durable leg. pi the CLI persists its session as JSONL, which is
*history*; pi-durable persists *execution*. The difference shows up only when something dies
mid-run.

Both tools are declared `replay: "safe"` because they are read-only HTTP GETs. A call the process
died during reruns on reopen; without that the model would get an `interrupted` result and have to
reason about a hole in its own transcript.

Measured, not assumed. A run was `SIGKILL`ed 25 s in and then resumed:

```
  7 seq  2 pi.user         BEFORE kill   the task
 10 seq  4 pi.system       BEFORE kill
 11 seq 11 pi.assistant    BEFORE kill   <call shop_search>      7.5s
 13 seq 14 pi.tool-result  BEFORE kill   the catalog round trip  0.9s
 15 seq 33 pi.assistant    BEFORE kill
 16 seq 49 pi.assistant    after kill    <call shop_stores> x3  15.2s
 ...
 32 seq116 pi.assistant    after kill    the answer             38.8s
```

The resumed process started at entry 16. It did not re-request the first model turn and did not
re-run `shop_search` — the 180 KB catalog fetch and 7.5 s of generation were already committed and
were reused. Reproduce the dump with `node durable/dump.ts --thread <id>`.

Three ways back in after an interruption:

```bash
# 1. Hand back the identical task: same requestId, so it rejoins the original submission.
node durable/run.ts --thread demo --task "the exact same wording"

# 2. Resume whatever is pending, when you no longer have the wording.
node durable/run.ts --thread demo --resume

# 3. Look without touching: opens read-only, recovers nothing, runs nothing.
node durable/run.ts --thread demo --inspect
```

Form 1 is what `pi_shop` tells OpenCode to do when a call is cut off, and it is idempotent:
verified after a kill, the thread held **one** submission and **one** `pi.user` entry, not two.

### The store-lookup budget is durable too

`shop_stores` costs a `ucp discover` round trip per merchant, so it is capped. Keeping that cap in
a process-level `Set` made it meaningless across a crash — a run killed after checking 4 merchants
could check 4 more on resume. It now lives in a conversation document (`durable/budget.ts`), and
the claim is one commit: `tx.doc()` hands back a mutable draft, so read-check-add is atomic and
two calls in the same round cannot both decide they are the last one.

Claiming a merchant already claimed must **succeed**, which is the part worth getting right. A
replay-safe tool rerunning after a crash asks again for a merchant it already paid for; refusing it
there would throw away the network spend that survived. One run proves both halves. With the budget
set to 2, it was killed at 28 s with 2 merchants claimed, and the model had asked for four lookups
in that round:

```
 15 pi.assistant    <call shop_stores> x4
 21 pi.tool-result  Store-lookup budget spent: 2 merchants already checked (...)
 22 pi.tool-result  Store-lookup budget spent: 2 merchants already checked (...)
 23 pi.tool-result  erniessports.myshopify.com does not advertise ...location.search
 24 pi.tool-result  ca-keenfootwear.myshopify.com does not advertise ...location.search
```

Two refused because the budget was already spent *before the kill*; the two already-claimed ones
reran and returned real results. The resumed run ended with the budget still at exactly 2, not 4.
`--inspect` and the runner's JSON both report `storeBudgetSpent`, so the cap is observable rather
than a matter of trust.

On the pi CLI path the budget is still `inProcessBudget()` from `shop/core.ts`, because pi has
nowhere durable to put it.

## Why it is read-only

The durable harness installs exactly one extension, `shop`, with two tools. There is no bash, read,
write, edit or codemode tool registered at all — `@earendil-works/pi-durable/tools` is never
imported, so cart and checkout are not hidden, they are absent. That is a stronger guarantee than
pi's `--tools` allowlist, which the pi path still uses:

```
--tools shop_search,shop_stores,mcp__none__*
```

The `mcp__none__*` entry is what makes `--tools` drop MCP tools too, since otherwise they survive an
allowlist. On that path `~/.pi/agent/mcp.json` also sets the `ucp` server to `exposure: "hidden"`
and re-exposes only the catalog tools, keeping `cart_*`, `checkout_*` and `order_*` unreachable.
Verify with `pi mcp list`.

Catalog access over UCP is unauthenticated. Checkout would additionally need a Catalog JWT from the
Shopify Developer Dashboard plus an agent profile at an HTTPS URL, neither of which is configured.

## Usage

```bash
cd ~/Documents/2026/pi-ucp-shop
opencode
```

Then in the TUI:

```
/shop merino wool beanie under $40
```

Or non-interactively:

```bash
opencode run --command shop "merino wool beanie under 40 dollars"
```

Or skip OpenCode and drive the agent directly:

```bash
node durable/run.ts --thread demo --task "merino wool beanie under 40 dollars"
```

One-time setup for the durable leg:

```bash
cd durable && npm install
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `SHOP_STATE_DIR` | `./.shop-state` | Where the per-thread SQLite files live |
| `SHOP_LLAMA_BASE_URL` | `http://127.0.0.1:8080/v1` | The llama.cpp server |
| `SHOP_MODEL_ID` | `qwen3.5-35b-a3b` | Model id as the server advertises it |
| `SHOP_MAX_TURNS` | `12` | Tool rounds one run may take |
| `SHOP_STORE_BUDGET` | `4` | Distinct merchants `shop_stores` may check per thread (durable) |
| `PI_SHOP_NODE` | `node` | Node used to run the harness (not `process.execPath`) |
| `PI_SHOP_TIMEOUT_MS` | `900000` | Kill the harness child after this long |
| `PI_SHOP_MAX_CHARS` | `4000` | Cap the digest handed back to OpenCode |

Threads default to the OpenCode session id, so a follow-up `/shop` in the same OpenCode session
continues the same durable conversation — and can resume it if the first attempt was cut off.

## Model requirements

Verified working end to end with **Qwen3.5-35B-A3B** (Q4_K_M, 18.5 GB) on both legs, served by
llama.cpp on the Radeon 890M via Vulkan. `/shop "a warm merino beanie under 40 dollars that ships
to Canada"` returns three real products, price-sorted, in **91 s** through the full OpenCode chain;
the durable harness on its own answers the same query in **63 s**.

A 1.7B model is not enough for either leg. As the orchestrator it hallucinated merchants and prices
outright; as the shopping agent it mangled the tool payload.

Serve the model with two slots, or the orchestrator and the delegate deadlock waiting for each other:

```bash
llama-server -m ~/.cache/llama.cpp/Qwen3.5-35B-A3B-UD-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 -c 49152 --parallel 2 -ngl 99 --jinja \
  --alias qwen3.5-35b-a3b
```

## Three things worth knowing

**Do not make the model parse the protocol.** The first version exposed the ucp MCP tools and told
the model to write a codemode script that extracted the products. It worked for simple queries and
fell apart on a real one ("Patagonia puffer jacket, mens large, blue, Montreal"): the model spent
eight turns fighting a `JSON.parse` edge case, grew the context to 19k tokens, and was killed by the
420 s timeout seconds before it would have answered. `shop/core.ts` now does the search, envelope
parsing, colour/size matching and price sorting in TypeScript, and hands the model about a dozen
compact rows. Same query: **111 s**, correct answer. The model gets parameters, not a parser.

The same lesson is why `core.ts` is harness-agnostic. When the durable leg was added, the two
adapters came to ~90 lines each and nothing that was expensive to learn had to be written twice.

**The ucp MCP tool mirrors the CLI, not the UCP payload.** `catalog_search` takes `input` (a JSON
*string* of the UCP payload) and `set` (JSON-pointer overlays) — not `query` directly. Passing
`{query: "..."}` fails with `/catalog: must have required property 'query'`.

**The response is mostly envelope.** A plain search returns ~91 KB, and ~62 KB even with
`view: "compact"` and `pagination.limit: 5`, because every product carries its full description.
pi truncates results over 20 KB before the model sees them, so direct tool calls hand the model
20 KB of capability metadata. Neither harness lets the model near that envelope now: `core.ts` runs
the `ucp` CLI itself with a 64 MB buffer, pulls out `result.products[].variants[]`, and returns
compact rows.

Useful payload fields: `filters.price.max` (minor units, server-side), `pagination.limit`,
`view: "compact"`, `sources: ["shopify","external"]`.

## How location works in UCP

UCP splits location across two layers, and the agent is built to match.

**Layer 1 — the global catalog (`shop_search`).** Three location-ish inputs, all verified against
the live catalog:

| Input | Shape | Effect |
|---|---|---|
| `filters.ships_to` | object, `country` required, optional `region` + `postal_code` | keeps variants that ship to the destination |
| `filters.ships_from` | **array** of `{country}`, OR logic | keeps variants shipped from those countries |
| `context.address_country` / `address_region` / `postal_code` | object | localisation and delivery estimates; `ships_to` falls back to these when absent |

`ships_from` being an array is easy to get wrong: passing `{country:"CA"}` is rejected with
`/catalog/filters/ships_from: must be array`. The tool takes `ships_from_countries: ["CA"]` and
builds the right shape.

Measured on "Patagonia puffer jacket men", 10 products each: no filter gave 9 sellers, all US;
`ships_from:[{country:"CA"}]` gave 5 different sellers; `ships_to:{CA, QC, H2X 1Y4}` surfaced
`patagonia-halifax.myshopify.com`. The filters do real work.

**Layer 2 — the merchant (`shop_stores`).** Proximity is not in the global catalog. Individual
businesses advertise `dev.ucp.common.location.search` and `.lookup`, and their own MCP endpoint
exposes `search_locations` / `lookup_locations`. Confirmed by probing four Canadian-shipping
sellers: `out-and-back-outdoor` and `alpine-country-lodge` advertise it, `patagonia-halifax` and
`flatspot-2` do not. So the flow is global-first, then ask each promising merchant — exactly as
`shop_stores` does it.

`search_locations` takes an empty `location` object to list every store, a literal `query` matched
against name and address (no geocoding, so spell regions out in full), or a `distance` with an
explicit `center` lat/lon and a `max` radius in metres, returning nearest first. Records come back
as `{id, name, address{street_address, address_locality, address_region, address_country,
postal_code, phone_number}, geo{latitude, longitude}}`.

Two implementation notes. The `ucp` CLI 0.9.1 has **no** location command — `--llms-full` does not
mention it — so `shop_stores` POSTs JSON-RPC straight to `https://<domain>/api/ucp/mcp`, passing the
agent profile as `meta["ucp-agent"].profile` (read from `ucp profile show`, overridable with
`UCP_AGENT_PROFILE_URL`). And `shop_stores` runs `ucp discover` first, so a merchant without the
capability gets a clean "online-only" answer instead of a failed call.

## The catalog cannot confirm a colour or size

This one cost a failed run and is the most important limitation to understand.

**Global catalog search returns exactly one representative variant per product.** 40 products came
back as 40 variants, and `catalog get_product` on a product returned that same single variant, not
the full matrix. So "blue in size L" cannot be answered from the global catalog — you are sampling
one variant per listing, not querying inventory.

An early run looked like it worked: a query with no location filter surfaced two Summit Blue / L
Nano Puffs. That was luck about which variant each listing happened to expose. Add `ships_to: CA`
and the same query returned 40 products with **zero** blue + L, which read as "no stock in Canada"
and was simply wrong.

**Merchants also name their options however they like.** Real labels seen in one 10-result page:

| Option name | Label |
|---|---|
| `Couleur` / `Taille` | `Glacial Blue Glcb` / `M` |
| `Color` / `Size` | `Lagom Blue` / `S` |
| `Colour` | `L` (a size, in a colour field) |
| `Color/size` | `M` |
| *(none)* | colour only in the product title |

So `shop_search` matches colour and size across option labels in several languages **and** the
product and variant titles, with token-aware size matching so `L` does not match `Glacial`. If
nothing matches strictly it returns the closest listings instead of nothing, with a header telling
the model it cannot claim the colour or size is in stock. The strict path now finds listings the
old option-only filter missed — "Clement Blue / Large", CAD 304, shipping to Quebec.

Setting `context.address_country` also makes merchants quote in local currency: the same searches
come back in CAD rather than USD.

## Verified store hits

Two runs that complete the whole story — global product discovery, then a real shop you can walk
into.

**"a Patagonia down jacket I can pick up in person in Denver, Colorado"** — 134 s. Found a Mens Down
Sweater at USD 79.99 from Out&Back Outdoor, which has two Denver storefronts at 3869 Steele Street,
and noted evo as a second in-person option.

**"mens waterproof hiking boots I can try on in a store in Montreal"** — 124 s. Found Keen Targhee
II Mid at CAD 139.99 from SAIL Plein Air, whose nearest store is in Laval.

The same query re-run on the durable harness from empty state picked SAIL again, and said why:
it was the only result with a store near Montreal. The two-phase location flow survived the port
unchanged, which is the point of keeping the logic in `shop/core.ts`.

How common is the capability? A scan of 24 merchants drawn from four product queries found seven
with `dev.ucp.common.location.search`: evo (10 stores incl. Denver and four in Whistler), Alo Yoga
(10 US), TOG24 (10 UK), Fly Fish Food (2 US), plus single-store Trident Fly Fishing, Risen Fly,
Gamefish (Edinburgh) and Plein Air Entrepôt (Montréal). Roughly a third, skewed toward real
outdoor retailers — which is exactly the kind of shop you would want to visit.

## Literal matching hides whole cities

`search_locations` matches text literally, and this bites hard on metro areas. SAIL Plein Air has
four stores around Montreal, and `query: "Montreal"` returns **zero** — because the branches are
named Laval, Brossard, Beloeil and Vaudreuil-Dorion. Reporting that as "no stores near you" would
be wrong in the most misleading way.

So `shop_stores` retries automatically: when a query matches nothing but the merchant does have
stores, it re-asks with an empty `location` and returns the full list, flagged `widened: true`, with
a header telling the model to judge proximity from the addresses. Verified: query "Montreal" on SAIL
now returns all 10 stores with street addresses and phone numbers.

## Budgets beat instructions

The policy told the agent to check "at most three merchants". It checked nine, then twelve on an
earlier run — each one a `ucp discover` network round trip. Prompt wording did not hold, so
`shop_stores` now enforces the budget in code: four distinct domains per thread, after which it
returns a refusal telling the model to stop and answer, and to describe unchecked merchants as
unknown rather than online-only. Run time dropped from 187 s to 139 s. On the durable path that
count is persisted, so it is four per *task* rather than four per process — see
[The store-lookup budget is durable too](#the-store-lookup-budget-is-durable-too).

Worth knowing it is not a complete fix: the model still wrote "no Montreal stores carry these" when
two merchants had been refused. The budget bounds the work reliably; it cannot stop the model
overstating what the work showed.

## Troubleshooting a hang

Measured on the Radeon 890M with Qwen3.5-35B-A3B: the pi leg alone answers a three-constraint query
in ~26 s, the full OpenCode chain in ~64 s. A run that takes minutes means something else is holding
a slot.

An interrupted `opencode run` can leave an orphaned `opencode` process alive. It keeps one of the
two llama.cpp slots, so the next run and the orphan evict each other's prompt cache and every turn
reprocesses its whole prompt from scratch. One query that should take a minute took 900 s this way.

```bash
pgrep -af opencode          # look for a process you did not start
curl -s localhost:8080/slots | jq '.[] | {id, is_processing, n_prompt_tokens}'
```

Kill the orphan and re-run. In the server log, `making room for prompt cache entry, removing oldest
entry` on every turn is the signature of two clients fighting over two slots.

## Next steps

- Add cart tools back with `"cart_*": "codemode"` once you want a real cart.
- For checkout: register an agent profile, get a Catalog JWT, and gate purchases on
  `UCP_ON_ESCALATION`, which fires a shell command when a merchant requires buyer handoff.
  pi has no permission system of its own, so that hook is where human approval belongs.
- Order tracking is what durable sleep is for: a task can end a phase with
  `runtime.sleepUntil(...)`, hold no process meanwhile, and wake when the clock reaches it. That is
  the natural shape for "tell me when this ships" once checkout exists.
