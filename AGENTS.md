# pi-ucp-shop

Delegation demo: OpenCode orchestrates, a pi-durable harness runs the agent loop, UCP reaches real
merchant catalogs. State is committed to `.shop-state/<thread>.sqlite` before anything is shown.

## Layout

- `shop/core.ts` — all the shopping logic, with no harness in it. Change behaviour HERE.
- `durable/` — the pi-durable harness: `models.ts` (llama.cpp provider), `tools.ts` (the two
  tools), `budget.ts` (the store-lookup cap, as a conversation document), `run.ts` (the CLI
  OpenCode spawns), `dump.ts` (print a thread's transcript).
- `.pi/extensions/shop_search.ts` — the same two tools for pi the CLI. A thin adapter.
- `.opencode/tools/pi_shop.ts` — OpenCode's delegation tool.

Both adapters are deliberately thin. A fix that belongs to shopping goes in `core.ts` so it lands
on both paths at once.

## Shopping agent policy

- Catalog search over UCP is read-only. The durable harness registers no cart, checkout, bash,
  write or edit tool at all, so this agent cannot spend money or touch the filesystem.
- Prices from the catalog are integer minor units: `2799` means `$27.99`. `core.ts` converts them,
  so `shop_search` rows are already in dollars.
- Every result carries a buy URL. Hand that link to the human; never attempt to complete a
  purchase automatically.
- Prefer one broad `shop_search` and let it filter, over many narrow searches.
- `shop_stores` is always the second phase: proximity lives on the merchant, never in the global
  catalog.

## Working on this

- An interrupted run is not a failed run. Re-running the identical task on the same thread resumes
  it; `--inspect` shows what is pending without running anything.
- Tools that reach the network read-only should stay `replay: "safe"`. Anything with a side effect
  must not be.
- A replay-safe tool reruns after a crash, so anything it *claims* must be idempotent. Re-claiming
  a merchant in `durable/budget.ts` succeeds for exactly this reason; making it fail would discard
  network work that survived the crash.
- Budgets and protocol handling belong in TypeScript, not in the prompt. Both were tried in the
  prompt first and both were ignored by a capable model.
