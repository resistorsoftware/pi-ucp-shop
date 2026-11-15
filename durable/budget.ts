// The shop_stores budget, kept in the conversation instead of in memory.
//
// Why this exists: the budget bounds `ucp discover` round trips, and a process-level Set
// resets when the process dies. A run killed after checking 4 merchants could check 4 more
// on resume, so the bound held per process and not per task — exactly the thing durability
// is supposed to fix.
//
// The claim is one commit. `tx.doc()` hands back a mutable draft, so read-check-add happens
// inside a single atomic change: two tool calls in the same round cannot both see 3 checked
// and both decide they are the 4th.

import { defineDoc } from "@earendil-works/pi-durable"
import type { ToolExecutionApi } from "@earendil-works/pi-durable"
import type { Context } from "@earendil-works/chord/context"
import { STORE_BUDGET, type BudgetClaim, type ClaimResult } from "../shop/core.ts"

export const ShopBudgetDoc = defineDoc<{ checked: string[] }>({
  kind: "shop.store-budget",
  version: 1,
  scope: "conversation",
  history: "latest",
  // A fork is a separate line of work and gets its own allowance.
  fork: "initial",
  initial: () => ({ checked: [] }),
  // The list is at most STORE_BUDGET short strings, so deltas never need a new base.
  checkpointWhen: () => false,
})

/** A budget backed by the conversation's own document; survives restarts. */
export function durableBudget(
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: Context,
  limit = STORE_BUDGET,
): BudgetClaim {
  return (domain) =>
    api.commit(async (tx): Promise<ClaimResult> => {
      const doc = await tx.doc(ShopBudgetDoc, api.conversationId)
      // Already paid for: a replay-safe rerun after a crash must not be charged again.
      if (doc.checked.includes(domain)) return { ok: true, checked: [...doc.checked] }
      if (doc.checked.length >= limit) return { ok: false, checked: [...doc.checked] }
      doc.checked.push(domain)
      return { ok: true, checked: [...doc.checked] }
    }, context)
}
