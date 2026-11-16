# Agentic shopping over UCP, with a crash-resumable local agent

Notes for a blog post. Everything below was built and verified on 2026-11-15/16
on an Arch machine with a local llama.cpp server. No cloud model was used.

Repo: https://github.com/resistorsoftware/pi-ucp-shop (private)

Code links in this document point at `main` with line anchors, so each one lands
on the specific thing being described rather than a whole file. They work for
the repo owner; for a published post the snippets would need inlining, or the
repo would need to be public.

---

## 1. The short version

- An OpenCode slash command (`/shop "waterproof boots I can try on in Montreal"`)
  hands a plain-language shopping task to a separate agent process.
- That agent runs on **pi-durable**, driving a local Qwen3.5-35B model, with
  exactly two tools: search a catalog, and ask one merchant where its shops are.
- Those tools talk to **UCP** (Universal Commerce Protocol), so the products and
  store addresses are real listings from real Shopify merchants, not fixtures.
- The agent cannot buy anything. That is enforced by what is registered, not by
  asking it nicely.
- Every step is committed to SQLite before it is shown, so killing the process
  mid-run loses nothing: the next run resumes from the last committed step.

The last point is the one worth writing about. "Agent" usually means a loop that
dies with its process. This one does not.

---

## 2. The chain

```
OpenCode  /shop "mens waterproof hiking boots, try on in a store in Montreal"
   |
   +-- .opencode/commands/shop.md          the slash command
        |
        +-- pi_shop tool                   OpenCode's delegation boundary
             |
             +-- node durable/run.ts --thread <id> --task "..."
                  |
                  +-- Harness over .shop-state/<thread>.sqlite
                  |     model: llama.cpp at 127.0.0.1:8080
                  |     extension: "shop" -- two tools, nothing else
                  |
                  +-- shop_search  ---> ucp catalog search
                  |                       global catalog, filtered by
                  |                       ships_to / ships_from
                  |
                  +-- shop_stores  ---> ucp discover, then search_locations
                                          on the merchant's own endpoint:
                                          https://<domain>/api/ucp/mcp
```

Three processes, three trust boundaries: OpenCode never sees the protocol, the
agent never sees a checkout tool, and the model never sees the raw envelope.

---

## 3. UCP and what "agentic shopping" actually means here

### What UCP is

- The Universal Commerce Protocol, announced by Shopify and Google on
  2026-01-11. It is the thing that lets a program, rather than a person with a
  browser, discover and buy from a merchant.
- Transport-agnostic, REST/JSON primary, with an MCP binding. There is a
  reference CLI, `@shopify/ucp-cli`, which also runs as an MCP server.
- Catalog search is **unauthenticated**. Anyone can query the global catalog
  today. That is why this exercise could be built at all in an afternoon.
- Checkout is not. It needs a Catalog JWT from the Shopify Developer Dashboard
  plus an agent profile published at an HTTPS URL. Neither is configured here.

### The two-layer location model - the single most useful thing learned

This is the insight the whole agent design hangs on, and it is not obvious from
the spec:

- **Product discovery is global.** One catalog, all merchants. You can filter by
  where the buyer is (`filters.ships_to` with country/region/postal) and by where
  stock is held (`filters.ships_from`, an array of countries, OR logic).
- **Physical proximity is not in that catalog at all.** It lives on the
  individual merchant, behind a separate capability, `dev.ucp.common.location`,
  exposed at `https://<domain>/api/ucp/mcp` as `search_locations` /
  `lookup_locations`. The `ucp` CLI 0.9.1 has no command for it.

So "find me boots I can try on in Montreal" is necessarily **two phases**:
search globally, then ask specific merchants whether they have a shop near you.
An agent that does not know this will either hallucinate store locations or
report that nothing is available locally.

- Only merchants with active retail locations answer at all. In a scan of 24
  merchants drawn from four product queries, **7 exposed the location
  capability** - roughly a third, skewed heavily toward genuine outdoor
  retailers, which is exactly the category where trying something on matters.
- The phase split is also why the budget in section 6 exists: phase two costs a
  network round trip per merchant, so an agent left unchecked will sweep the
  whole result list.

Code: the two-phase policy the agent is given ->
[shop/core.ts#L517](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L517)

### What the agent is allowed to do

- Discover products, compare prices, find nearby shops, rank, recommend.
- Hand over a buy URL for a human to complete.
- That is the whole job. "Agentic shopping" here means agentic *research and
  handoff*, deliberately stopping short of agentic spending.

### Why it stops there, and how that is enforced

- The durable harness registers **one** extension containing two read-only
  tools. `@earendil-works/pi-durable/tools` (which ships `read`, `write`,
  `edit`, `bash`) is never imported. Cart and checkout are not hidden, they are
  absent.
- That is a stronger guarantee than a prompt instruction or an allowlist,
  because there is no code path to the capability at all.
- On the older pi CLI path the same posture is achieved with an allowlist plus
  MCP exposure settings, which is weaker and worth contrasting in a post.

Code: the extension, and everything it contains ->
[durable/tools.ts#L84](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/tools.ts#L84)

---

## 4. pi and pi-durable

### What they are

- **pi** (`earendil-works/pi`, 1.5.2) is a minimal extensible coding-agent
  harness: a CLI with a TUI, a JSON event mode, an RPC mode, and a TS SDK. It
  has no sub-agents, no plan mode, and notably **no permission system**.
- **pi-durable** (`@earendil-works/pi-durable`, same version, MIT, marked
  experimental) is a separate library: a durable agent harness. Not a CLI.

### The distinction that justified the work

- pi the CLI already persists sessions as JSONL. That is **history**.
- pi-durable persists **execution**. Conversations, model turns, tool calls and
  your own state are committed to storage before anything is shown.
- The difference is invisible until something dies mid-turn. With JSONL history,
  a crash leaves an assistant tool-call entry with no result - a hole the next
  run just talks past. With pi-durable, reopening the storage picks the work up
  where it stopped.

### How the local model is wired in

- pi the CLI reads `~/.pi/agent/models.json`. pi-durable is a library, so there
  is no config file: the provider is constructed in code through
  `createProvider`, which is the same entry point pi's own models.json loader
  uses.
- Keyless local auth, `openai-completions` API, context window matched to the
  server's `-c 49152` split across `--parallel 2`.

Code: the whole provider, 49 lines ->
[durable/models.ts#L18](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/models.ts#L18)

### Tool durability: `replay: "safe"`

- Both tools are declared replay-safe, because they are read-only HTTP GETs.
- A call the process died during therefore **reruns** on reopen. Without it the
  model gets an `interrupted` result and has to reason about a gap in its own
  transcript.
- This flag is the single highest-leverage line in the project.

Code: [durable/tools.ts#L40](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/tools.ts#L40)
and [#L64](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/tools.ts#L64)

### Three ways back in after an interruption

```
# 1. Hand back the identical task. Same requestId, so it rejoins the
#    original submission instead of asking the model twice.
node durable/run.ts --thread demo --task "the exact same wording"

# 2. Resume whatever is pending, when the wording is lost.
node durable/run.ts --thread demo --resume

# 3. Look without touching. Opens read-only: recovers nothing, runs nothing.
node durable/run.ts --thread demo --inspect
```

- Form 1 is what the OpenCode tool tells the orchestrator to do when a call is
  cut off, and it is idempotent: after a kill, the thread held **one** submission
  and **one** user entry, not two.
- Form 3 was verified running against a database another process was actively
  writing. SQLite's file locks make that safe.

Code: the requestId derivation ->
[durable/run.ts#L203](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/run.ts#L203)

---

## 5. What was set up, piece by piece

| What | Where | Why |
|---|---|---|
| Shopping logic, harness-free | [shop/core.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts) | One copy of everything expensive to learn. 537 lines. |
| Catalog search | [core.ts#L198](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L198) | Builds the UCP payload, runs the CLI, returns compact rows. |
| Store lookup | [core.ts#L332](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L332) | Phase two: capability check, then the merchant's own endpoint. |
| Durable harness provider | [durable/models.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/models.ts) | Local llama.cpp as a pi-ai provider, in code. |
| The two durable tools | [durable/tools.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/tools.ts) | 87-line adapter. Replay-safe, durable budget. |
| Durable store-lookup budget | [durable/budget.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/budget.ts) | A conversation document, so a crash cannot reset it. |
| The runner | [durable/run.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/run.ts) | CLI: submit, resume, inspect. One JSON object on stdout. |
| Transcript dump | [durable/dump.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/dump.ts) | Read-only. How the durability claims were checked. |
| pi CLI adapter | [.pi/extensions/shop_search.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/.pi/extensions/shop_search.ts) | Same two tools for pi's TUI. 89 lines. |
| OpenCode delegation tool | [.opencode/tools/pi_shop.ts](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/.opencode/tools/pi_shop.ts) | Spawns the runner, digests the result. |
| The slash command | [.opencode/commands/shop.md](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/.opencode/commands/shop.md) | Stops the orchestrator from fishing for products itself. |
| Agent-facing project notes | [AGENTS.md](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/AGENTS.md) | Read automatically by both pi and OpenCode. |

Shape worth noting for a post: **537 lines of domain logic, two adapters of
~88 lines each.** When the durable leg was added, nothing that had been
expensive to learn was rewritten. That was not foresight; it came out of the
first lesson below.

---

## 6. Three lessons, each learned by getting it wrong first

### Do not make the model parse the protocol

- First version exposed the UCP MCP tools and told the model to write a
  code-mode script to extract products from the roughly 180 KB envelope.
- It worked on toy queries and collapsed on a real one: eight turns fighting a
  `JSON.parse` edge case, context grown to 19k tokens, killed by a 420 s
  timeout seconds before it would have answered.
- Moving search, envelope parsing, colour/size matching and price sorting into
  TypeScript answered the same query in **111 s**. The model gets parameters,
  not a parser.
- A related trap: the `ucp` MCP tool mirrors the CLI, not the UCP payload. It
  takes `input` as a JSON **string** plus `set` for JSON-pointer overlays.
  Passing `{query: "..."}` fails with `/catalog: must have required property
  'query'`.

### Budgets belong in code, not in the prompt

- The policy said "check at most three merchants". The model checked nine, then
  twelve on another run - each one a network round trip.
- Enforced in code instead, it holds: four distinct domains, then a refusal that
  also tells the model to describe unchecked merchants as *unknown* rather than
  online-only. Run time dropped from 187 s to 139 s.
- Honest limitation: the budget bounds the work reliably but cannot stop the
  model overstating what the work showed. On one run it still wrote "no Montreal
  stores carry these" when two merchants had been refused unchecked.
- Later made durable (see section 7), because a process-level counter is
  meaningless across a crash.

Code: the claim, enforced before any network work ->
[core.ts#L336](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L336)

### Literal matching hides whole cities

- `search_locations` matches text literally. There is no geocoding.
- SAIL Plein Air has four stores around Montreal. They are named Laval,
  Brossard, Beloeil and Vaudreuil-Dorion. Querying "Montreal" returns **zero**.
- Directly verified: `"Montreal"` -> 0 stores, `"Laval"` -> 2, no query -> 10.
- An agent reporting that faithfully would tell you there are no stores near
  you, in the most misleading way possible. `shop_stores` now auto-widens to the
  full store list, flags that it did, and tells the model to judge proximity
  from the addresses.

Code: [core.ts#L400](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L400)

### Bonus trap: the catalog cannot confirm a colour or size

- Global catalog search returns exactly **one representative variant per
  product**. 40 products come back as 40 variants, and `catalog get_product`
  returns that same single variant, not the matrix.
- So "blue in size L" is sampling, never an inventory check.
- An early run looked like it worked - two matching jackets surfaced - which was
  luck about which variant each listing happened to expose. Adding a location
  filter returned 40 products with zero matches, which read as "no stock in
  Canada" and was simply wrong.
- Merchants also name options however they like. Real labels from one page of 10
  results: `Couleur`/`Taille` in French, `Colour` containing a **size**, a
  single field called `Color/size`, and listings with the colour only in the
  product title.
- Handled with multi-language option keys, a title haystack, token-aware size
  matching (so "L" does not match "Glacial"), and a softened fallback that
  returns closest listings with an explicit warning rather than nothing.

Code: option matching ->
[core.ts#L98](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L98),
size matching -> [core.ts#L124](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/shop/core.ts#L124)

---

## 7. The durability claims, and how they were checked

Not asserted - measured, with the transcript as evidence. `durable/dump.ts`
prints a thread's committed entries; entry timestamps were correlated against
the moment of the kill.

### Test 1: does committed work survive and get reused?

A run was `SIGKILL`ed 25 s in, then resumed:

```
  7 seq  2 pi.user         BEFORE kill   the task
 10 seq  4 pi.system       BEFORE kill
 11 seq 11 pi.assistant    BEFORE kill   <call shop_search>       7.5s
 13 seq 14 pi.tool-result  BEFORE kill   the catalog round trip   0.9s
 15 seq 33 pi.assistant    BEFORE kill
 16 seq 49 pi.assistant    after kill    <call shop_stores> x3   15.2s
 ...
 32 seq116 pi.assistant    after kill    the answer              38.8s
```

- The resumed process started at entry 16.
- It did **not** re-request the first model turn and did **not** re-run
  `shop_search`. The 180 KB catalog fetch and 7.5 s of generation were already
  committed and were reused.

### Test 2: does a durable budget actually bind across a restart?

The budget was moved out of a process-level Set into a conversation document.
The claim is a single commit: `tx.doc()` returns a mutable draft, so
read-check-add is atomic, and two tool calls in one round cannot both decide
they are the last one.

- Budget set to 2, killed at 28 s with 2 merchants claimed. The model had asked
  for **four** store lookups in that round:

```
 15 pi.assistant    <call shop_stores> x4
 21 pi.tool-result  Store-lookup budget spent: 2 merchants already checked (...)
 22 pi.tool-result  Store-lookup budget spent: 2 merchants already checked (...)
 23 pi.tool-result  erniessports.myshopify.com does not advertise ...location.search
 24 pi.tool-result  ca-keenfootwear.myshopify.com does not advertise ...location.search
```

- Merchants 3 and 4 refused, because the budget was spent *before the kill*.
  The resumed run ended at exactly 2, not 4.
- The two already-claimed merchants reran and returned real results.

That second half is the subtle part, and probably the best single paragraph in a
blog post about durable agents:

> Re-claiming a resource you already claimed must **succeed**. A replay-safe tool
> rerunning after a crash asks again for something it already paid for. Refusing
> it there throws away the work that survived. Had the re-claim failed, all four
> lookups would have been refused and the agent would have finished with no
> store data at all.

Code: [durable/budget.ts#L36](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/durable/budget.ts#L36)

### What the agent exposes about its own limits

- `--inspect` and the runner's JSON both report `storeBudgetSpent`, so the cap
  is observable rather than a matter of trust.
- When a delegated call is cut off, the OpenCode tool does not report a dead
  end: it says the state is committed and that handing back the same task will
  resume it. On the one occasion this fired for real, the orchestrating model
  read that and retried correctly on its own.

Code: [.opencode/tools/pi_shop.ts#L123](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/.opencode/tools/pi_shop.ts#L123)

---

## 8. Results, with numbers

Hardware: AMD Radeon 890M, llama.cpp with the Vulkan backend, unified memory.
Model: Qwen3.5-35B-A3B, Q4_K_M, 18.5 GB, served with `--parallel 2`.

| Query | Path | Time | Result |
|---|---|---|---|
| merino beanie under $40, ships to Canada | durable, direct | 63 s | 3 real products, price-sorted |
| same | full OpenCode chain | 91 s | same, plus orchestrator commentary |
| Patagonia down jacket, pick up in Denver | full chain | 134 s | Out&Back Outdoor, two Denver storefronts |
| mens waterproof boots, try on in Montreal | full chain | 124 s | Keen Targhee II, CAD 139.99, SAIL Plein Air, nearest store Laval |

- The Montreal query was re-run on the durable harness from empty state and
  picked SAIL again, saying why: it was the only result with a store near
  Montreal. The two-phase location flow survived the rewrite unchanged, which
  is the payoff for keeping the logic harness-free.

### Two operational notes worth a sidebar

- **Serve the model with two slots.** With a single slot the orchestrator and
  the delegate deadlock waiting for each other: 420 s timeouts with no output.
- **An orphaned process will look like a hang.** An interrupted `opencode run`
  left a process holding one of the two slots; it and the next run evicted each
  other's prompt cache, so every turn reprocessed its whole prompt. A one-minute
  query took 900 s. The signature in the server log is `making room for prompt
  cache entry, removing oldest entry` on every turn.

### A 1.7B model is not enough

- As orchestrator it hallucinated merchants and prices outright.
- As the shopping agent it mangled the tool payload, invented files, and spawned
  subagents until it blew its context.
- Worth a line in a post about the floor for this kind of work.

---

## 9. What is deliberately not built

- **Cart and checkout.** Would need an agent profile at an HTTPS URL plus a
  Catalog JWT. The interesting design question is where human approval goes:
  pi has no permission system of its own, so the natural hook is
  `UCP_ON_ESCALATION`, which fires a shell command when a merchant requires
  buyer handoff.
- **Order tracking.** This is what durable sleep is for: a task can end a phase
  with `runtime.sleepUntil(...)`, hold no process at all meanwhile, and wake
  when the clock reaches it. That is the right shape for "tell me when this
  ships", and it only makes sense once checkout exists.
- **Colour and size confirmation.** Not possible from the global catalog, as
  above. Would need per-merchant product queries.

---

## 10. Angles for the post

Pick one; there are at least four here.

- **"Your agent framework persists history, not execution."** The pi vs
  pi-durable distinction, with the kill-test transcript as the proof. Most
  general-interest angle.
- **"Stop asking the model to behave."** Three times in one project, an
  instruction in the prompt was ignored and the same rule held perfectly in
  TypeScript: the envelope parser, the merchant budget, the city matching. The
  budget is the sharpest version - a capable model swept 9 merchants when told
  "at most three".
- **"Idempotency is the whole game in durable agents."** The re-claim rule from
  section 7. Short, specific, counterintuitive.
- **"What agentic commerce actually looks like in 2026."** UCP's two-layer
  location model, the one-variant-per-product sampling limit, roughly a third of
  merchants exposing physical stores, and a deliberate stop before spending.

### Details that make good copy

- Querying "Montreal" returns zero stores for a chain with four stores around
  Montreal.
- A merchant field named `Colour` containing the value `L`.
- One listing came back in French; the agent handled it because option keys are
  matched in five languages.
- The agent correctly picked a more expensive boot *because* it was the only one
  you could try on. That is a recommendation a price-sorter cannot make.

---

## 11. Reference

### Setup

```
cd durable && npm install          # the durable harness
opencode                           # then: /shop merino wool beanie under $40
```

```
llama-server -m ~/.cache/llama.cpp/Qwen3.5-35B-A3B-UD-Q4_K_M.gguf \
  --host 127.0.0.1 --port 8080 -c 49152 --parallel 2 -ngl 99 --jinja \
  --alias qwen3.5-35b-a3b
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SHOP_STATE_DIR` | `./.shop-state` | Per-thread SQLite files |
| `SHOP_LLAMA_BASE_URL` | `http://127.0.0.1:8080/v1` | The llama.cpp server |
| `SHOP_MODEL_ID` | `qwen3.5-35b-a3b` | Model id as the server advertises it |
| `SHOP_MAX_TURNS` | `12` | Tool rounds per run |
| `SHOP_STORE_BUDGET` | `4` | Merchants `shop_stores` may check per thread |
| `PI_SHOP_NODE` | `node` | Node used to run the harness |
| `PI_SHOP_TIMEOUT_MS` | `900000` | Kill the harness child after this long |
| `PI_SHOP_MAX_CHARS` | `4000` | Cap on the digest returned to OpenCode |

### Versions as tested

- pi / pi-durable / pi-ai / chord / pi-schema: 1.5.2
- OpenCode: 1.19.5
- `@shopify/ucp-cli`: 0.9.1
- llama.cpp: 0.9.0-dev, Vulkan backend
- Node: 24.12.0 (runs the TypeScript runner directly, no build step)

### External references

- UCP announcement and docs: Shopify / Google, 2026-01-11
- pi: https://github.com/earendil-works/pi
- pi-durable README (the `Persist and Resume` and `Your Own State` sections are
  the two that matter here)

### Full project README

The in-repo [README.md](https://github.com/resistorsoftware/pi-ucp-shop/blob/main/README.md)
covers the same ground with more operational detail, including a troubleshooting
section for hangs.
