// pi (the CLI) adapter. All the logic is in ../../shop/core.ts, which durable/tools.ts
// also uses, so the two paths cannot drift apart.

import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
  FIELD_HELP,
  findStores,
  inProcessBudget,
  SEARCH_DESCRIPTION,
  SEARCH_GUIDELINES,
  searchCatalog,
  STORES_DESCRIPTION,
  STORES_GUIDELINES,
  type Outcome,
} from "../../shop/core.ts"

// pi has no durable store for this, so the budget resets if pi restarts. The durable
// path keeps it in the conversation instead (durable/budget.ts).
const budget = inProcessBudget()

/** core's Outcome in pi's tool-result shape. */
function reply(o: Outcome) {
  return {
    content: [{ type: "text", text: o.text }],
    details: o.details,
    ...(o.isError ? { isError: true } : {}),
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "shop_search",
    label: "Shop Search",
    description: SEARCH_DESCRIPTION,
    promptSnippet: "Search real merchant catalogs for purchasable products",
    promptGuidelines: SEARCH_GUIDELINES,
    parameters: Type.Object({
      query: Type.String({ description: FIELD_HELP.query }),
      max_price: Type.Optional(Type.Number({ description: FIELD_HELP.max_price })),
      color: Type.Optional(Type.String({ description: FIELD_HELP.color })),
      size: Type.Optional(Type.String({ description: FIELD_HELP.size })),
      limit: Type.Optional(Type.Number({ description: FIELD_HELP.limit })),
      ships_to_country: Type.Optional(Type.String({ description: FIELD_HELP.ships_to_country })),
      ships_to_region: Type.Optional(Type.String({ description: FIELD_HELP.ships_to_region })),
      ships_to_postal: Type.Optional(Type.String({ description: FIELD_HELP.ships_to_postal })),
      ships_from_countries: Type.Optional(
        Type.Array(Type.String(), { description: FIELD_HELP.ships_from_countries }),
      ),
    }),

    async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate?: (u: any) => void) {
      return reply(
        await searchCatalog(params, {
          signal,
          onProgress: (text) =>
            onUpdate?.({ content: [{ type: "text", text }], details: { status: "searching" } }),
        }),
      )
    },
  })

  pi.registerTool({
    name: "shop_stores",
    label: "Shop Stores",
    description: STORES_DESCRIPTION,
    promptSnippet: "Look up a merchant's physical stores, optionally nearest a point",
    promptGuidelines: STORES_GUIDELINES,
    parameters: Type.Object({
      business: Type.String({ description: FIELD_HELP.business }),
      query: Type.Optional(Type.String({ description: FIELD_HELP.store_query })),
      latitude: Type.Optional(Type.Number({ description: FIELD_HELP.latitude })),
      longitude: Type.Optional(Type.Number({ description: FIELD_HELP.longitude })),
      radius_km: Type.Optional(Type.Number({ description: FIELD_HELP.radius_km })),
      limit: Type.Optional(Type.Number({ description: FIELD_HELP.store_limit })),
    }),

    async execute(_toolCallId: string, params: any, signal: AbortSignal, onUpdate?: (u: any) => void) {
      return reply(
        await findStores(params, {
          signal,
          budget,
          onProgress: (text) =>
            onUpdate?.({ content: [{ type: "text", text }], details: { status: "discovering" } }),
        }),
      )
    },
  })
}
