// pi-durable adapter for the same two tools the pi CLI extension registers.
//
// Two things differ from the pi path, and both are the reason durability buys something:
//
//  - Both tools are `replay: "safe"`. They are read-only HTTP GETs, so if the process dies
//    mid-call, reopening the storage reruns just that call. Without it the model would get an
//    `interrupted` result and have to reason about a hole in its own transcript.
//  - The store-lookup budget lives in a conversation document (durable/budget.ts), not in a
//    process-level Set, so a crash cannot hand the agent a fresh allowance.

import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema"
import {
  FIELD_HELP,
  findStores,
  SEARCH_DESCRIPTION,
  SEARCH_GUIDELINES,
  searchCatalog,
  STORES_DESCRIPTION,
  STORES_GUIDELINES,
  type Outcome,
} from "../shop/core.ts"
import { durableBudget } from "./budget.ts"

/** core's Outcome in pi-durable's tool-result shape. */
function reply(o: Outcome) {
  return {
    output: [{ type: "text" as const, text: o.text }],
    details: o.details as never,
    ...(o.isError ? { isError: true } : {}),
  }
}

/** Guidelines are prompt text here rather than a registration field, as in pi. */
const guidelineBlock = (lines: string[]) => "\n\nHow to use it:\n- " + lines.join("\n- ")

const shopSearch = defineTool({
  name: "shop_search",
  description: SEARCH_DESCRIPTION + guidelineBlock(SEARCH_GUIDELINES),
  replay: "safe",
  parameters: obj({
    query: str({ description: FIELD_HELP.query }),
    max_price: opt(num({ description: FIELD_HELP.max_price })),
    color: opt(str({ description: FIELD_HELP.color })),
    size: opt(str({ description: FIELD_HELP.size })),
    limit: opt(num({ description: FIELD_HELP.limit })),
    ships_to_country: opt(str({ description: FIELD_HELP.ships_to_country })),
    ships_to_region: opt(str({ description: FIELD_HELP.ships_to_region })),
    ships_to_postal: opt(str({ description: FIELD_HELP.ships_to_postal })),
    ships_from_countries: opt(arr(str(), { description: FIELD_HELP.ships_from_countries })),
  }),
  execute: async (args, api, context) =>
    reply(
      await searchCatalog(args, {
        signal: context.abortSignal,
        onProgress: (text) => api.output(text + "\n"),
      }),
    ),
})

const shopStores = defineTool({
  name: "shop_stores",
  description: STORES_DESCRIPTION + guidelineBlock(STORES_GUIDELINES),
  replay: "safe",
  parameters: obj({
    business: str({ description: FIELD_HELP.business }),
    query: opt(str({ description: FIELD_HELP.store_query })),
    latitude: opt(num({ description: FIELD_HELP.latitude })),
    longitude: opt(num({ description: FIELD_HELP.longitude })),
    radius_km: opt(num({ description: FIELD_HELP.radius_km })),
    limit: opt(num({ description: FIELD_HELP.store_limit })),
  }),
  execute: async (args, api, context) =>
    reply(
      await findStores(args, {
        signal: context.abortSignal,
        budget: durableBudget(api, context),
        onProgress: (text) => api.output(text + "\n"),
      }),
    ),
})

/** The only extension the shopping conversation installs: no bash, read, write or edit. */
export const ShopTools = defineExtension({
  name: "shop",
  tools: [shopSearch, shopStores],
})
