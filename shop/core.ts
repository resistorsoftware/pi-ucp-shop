// The shopping logic, with no harness in it.
//
// Two harnesses call this: `.pi/extensions/shop_search.ts` (pi the CLI) and
// `durable/tools.ts` (pi-durable). Both are thin adapters. Everything that was
// expensive to learn — merchants naming their options in four languages, the
// catalog showing one representative variant per product, search_locations
// matching literally, models ignoring a prompt-level budget — lives here once.

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const run = promisify(execFile)

const PROFILE_FALLBACK =
  "https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json"

/** Distinct merchants shop_stores may check per task. Each costs a `ucp discover` round trip. */
export const STORE_BUDGET = Number(process.env.SHOP_STORE_BUDGET ?? 4)

/**
 * Whether this merchant may be checked, and who has been checked so far. Claiming a domain
 * already claimed must succeed: a replay-safe tool rerunning after a crash asks again for a
 * merchant it already paid for, and must not be charged twice.
 */
export type ClaimResult = { ok: boolean; checked: string[] }

/**
 * Where the budget is kept. The decision is the store's, not core's, so it can be made
 * atomically: the durable store does read-check-add inside one commit.
 */
export type BudgetClaim = (domain: string) => Promise<ClaimResult> | ClaimResult

/**
 * A budget in memory, for a harness with nowhere durable to put it (pi the CLI). Lives as long
 * as the process, so a crash resets it — see durable/budget.ts for the version that does not.
 */
export function inProcessBudget(limit = STORE_BUDGET): BudgetClaim {
  const checked = new Set<string>()
  return (domain) => {
    if (checked.has(domain)) return { ok: true, checked: [...checked] }
    if (checked.size >= limit) return { ok: false, checked: [...checked] }
    checked.add(domain)
    return { ok: true, checked: [...checked] }
  }
}

/** What both tools hand back: text for the model, details for a UI. */
export type Outcome = {
  text: string
  details: Record<string, unknown>
  isError?: boolean
}

export type SearchParams = {
  query: string
  max_price?: number
  color?: string
  size?: string
  limit?: number
  ships_to_country?: string
  ships_to_region?: string
  ships_to_postal?: string
  ships_from_countries?: string[]
}

export type StoreParams = {
  business: string
  query?: string
  latitude?: number
  longitude?: number
  radius_km?: number
  limit?: number
}

export type CallOpts = {
  signal?: AbortSignal
  onProgress?: (text: string) => void
  /** Required for findStores. Without one, store lookups are unbounded. */
  budget?: BudgetClaim
}

type Row = {
  title: string
  price: number
  currency: string
  merchant: string
  domain?: string
  color?: string
  size?: string
  buy: string
}

// Merchants name their options however they like: Color, Colour, Couleur, Taille,
// "Color/size", or nothing at all, and the colour is often only in the product title.
const COLOR_KEYS = ["color", "colour", "couleur", "farbe", "colore"]
const SIZE_KEYS = ["size", "taille", "größe", "grosse", "talla", "taglia"]

function variantOption(v: any, keys: string[]): string | undefined {
  for (const o of v.options ?? []) {
    const name = String(o?.name ?? "").toLowerCase()
    if (keys.some((k) => name === k || name.includes(k))) return o.label
  }
  return undefined
}

/** Everything a colour or size word might be hiding in, for one variant. */
function haystack(p: any, v: any): string {
  const opts = (v.options ?? []).map((o: any) => String(o?.name) + " " + String(o?.label)).join(" ")
  return [p.title, v.title, opts].filter(Boolean).join(" ").toLowerCase()
}

const SIZE_WORDS: Record<string, string[]> = {
  l: ["l", "large", "lg"],
  large: ["l", "large", "lg"],
  m: ["m", "medium", "med"],
  medium: ["m", "medium", "med"],
  s: ["s", "small", "sm"],
  small: ["s", "small", "sm"],
  xl: ["xl", "extra large"],
  xxl: ["xxl", "2xl"],
}

/** Does this variant plausibly match the wanted size? Token-aware, so "L" does not match "Glacial". */
function sizeMatches(sizeLabel: string | undefined, hay: string, want: string): boolean {
  const wants = SIZE_WORDS[want] ?? [want]
  const label = (sizeLabel ?? "").toLowerCase()
  if (label) {
    const tokens = label.split(/[^a-z0-9]+/).filter(Boolean)
    if (wants.some((w) => tokens.includes(w) || label === w)) return true
    // "Medium (M)" style labels
    if (wants.some((w) => w.length > 1 && label.includes(w))) return true
    return false
  }
  // No size option at all: fall back to title tokens, long words only to avoid false hits
  const tokens = hay.split(/[^a-z0-9]+/).filter(Boolean)
  return wants.some((w) => (w.length > 1 ? tokens.includes(w) : false))
}

function textOf(result: any): string {
  return (result?.content ?? []).map((b: any) => b?.text ?? "").join("")
}

/** The agent profile URL every UCP request must reference. */
let profileUrlCache: string | undefined
async function agentProfileUrl(): Promise<string> {
  if (process.env.UCP_AGENT_PROFILE_URL) return process.env.UCP_AGENT_PROFILE_URL
  if (profileUrlCache) return profileUrlCache
  try {
    const { stdout } = await run("ucp", ["profile", "show", "--format", "json"], { timeout: 30000 })
    const p = JSON.parse(stdout)
    const renderings: any[] = p.renderings ?? p.result?.renderings ?? []
    const best = renderings
      .filter((r) => r?.profile_url)
      .sort((a, b) => String(a.version).localeCompare(String(b.version)))
      .pop()
    profileUrlCache = best?.profile_url ?? PROFILE_FALLBACK
  } catch {
    profileUrlCache = PROFILE_FALLBACK
  }
  return profileUrlCache
}

/** Call a tool on a business's own UCP MCP endpoint. The ucp CLI has no location command. */
async function businessTool(domain: string, name: string, args: any, signal?: AbortSignal) {
  const profile = await agentProfileUrl()
  const res = await fetch("https://" + domain + "/api/ucp/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: { meta: { "ucp-agent": { profile } }, ...args } },
    }),
    signal,
  })
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + domain)
  const rpc = JSON.parse(await res.text())
  if (rpc.error) throw new Error(rpc.error.message ?? JSON.stringify(rpc.error))
  return rpc.result
}

function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(b.latitude - a.latitude)
  const dLon = toRad(b.longitude - a.longitude)
  const la1 = toRad(a.latitude)
  const la2 = toRad(b.latitude)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Search the UCP global catalog and return ranked rows. Read-only. */
export async function searchCatalog(params: SearchParams, opts: CallOpts = {}): Promise<Outcome> {
  const limit = Math.min(Math.max(Number(params.limit ?? 8), 1), 25)
  const payload: any = { query: params.query, pagination: { limit: 40 } }
  const filters: any = {}

  if (params.max_price != null) {
    filters.price = { max: Math.round(Number(params.max_price) * 100) }
  }
  if (params.ships_to_country) {
    filters.ships_to = { country: String(params.ships_to_country).toUpperCase() }
    if (params.ships_to_region) filters.ships_to.region = params.ships_to_region
    if (params.ships_to_postal) filters.ships_to.postal_code = params.ships_to_postal
  }
  // ships_from is an ARRAY of {country} objects; an object is rejected by the schema.
  if (params.ships_from_countries?.length) {
    filters.ships_from = params.ships_from_countries.map((c: string) => ({
      country: String(c).toUpperCase(),
    }))
  }
  if (Object.keys(filters).length) payload.filters = filters

  // context mirrors the destination so merchants can localise and estimate delivery
  if (params.ships_to_country) {
    payload.context = { address_country: String(params.ships_to_country).toUpperCase() }
    if (params.ships_to_region) payload.context.address_region = params.ships_to_region
    if (params.ships_to_postal) payload.context.postal_code = params.ships_to_postal
  }

  opts.onProgress?.('Searching catalog for "' + params.query + '"...')

  let env: any
  try {
    const { stdout } = await run(
      "ucp",
      ["catalog", "search", "--input", JSON.stringify(payload), "--format", "json"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180000, signal: opts.signal },
    )
    env = JSON.parse(stdout)
  } catch (err: any) {
    const msg = String(err?.stdout || err?.stderr || err?.message || err).slice(0, 700)
    return { text: "shop_search failed: " + msg, details: { error: msg }, isError: true }
  }

  const wantColor = params.color?.trim().toLowerCase()
  const wantSize = params.size?.trim().toLowerCase()

  // The global catalog returns ONE representative variant per product, so colour/size
  // here is a hint, never an inventory check. Keep strict and loose piles separately.
  const strict: Row[] = []
  const loose: Row[] = []
  for (const p of env.result?.products ?? []) {
    for (const v of p.variants ?? []) {
      const amount = v.price?.amount
      if (typeof amount !== "number") continue
      const color = variantOption(v, COLOR_KEYS)
      const size = variantOption(v, SIZE_KEYS)
      const hay = haystack(p, v)

      let merchant = v.seller?.name
      if (!merchant) {
        try {
          merchant = new URL(v.url).hostname
        } catch {
          merchant = "unknown"
        }
      }
      const row: Row = {
        title: p.title,
        price: amount / 100,
        currency: v.price?.currency ?? "USD",
        merchant,
        domain: v.seller?.domain,
        color,
        size,
        buy: v.checkout_url ?? v.url,
      }

      const colorOk = !wantColor || hay.includes(wantColor)
      const sizeOk = !wantSize || sizeMatches(size, hay, wantSize)
      if (colorOk && sizeOk) strict.push(row)
      // Every priced variant is a fallback candidate, so an unmet colour or size
      // degrades to "closest listings" rather than an empty answer.
      loose.push(row)
    }
  }

  strict.sort((a, b) => a.price - b.price)
  loose.sort((a, b) => a.price - b.price)
  const softened = strict.length === 0 && loose.length > 0
  const rows = softened ? loose : strict
  const top = rows.slice(0, limit)
  const total = env.result?.products?.length ?? 0

  if (top.length === 0) {
    const parts = ["No variant matched (searched " + total + " products"]
    if (wantColor) parts.push(', colour "' + params.color + '"')
    if (wantSize) parts.push(', size "' + params.size + '"')
    if (params.max_price != null) parts.push(", max $" + params.max_price)
    if (params.ships_to_country) parts.push(", ships to " + params.ships_to_country)
    if (params.ships_from_countries?.length)
      parts.push(", ships from " + params.ships_from_countries.join("/"))
    parts.push("). Relax one constraint or change the query.")
    return { text: parts.join(""), details: { matched: 0, products: total } }
  }

  const lines = top.map((r, i) => {
    const bits = [r.color, r.size].filter(Boolean).join(" / ")
    const tag = bits ? " [" + bits + "]" : ""
    return (
      i + 1 + ". " + r.title + tag + " - " + r.currency + " " + r.price.toFixed(2) +
      " - " + r.merchant + (r.domain ? " (" + r.domain + ")" : "") + "\n   " + r.buy
    )
  })

  const header = softened
    ? "No listing confirmed " +
      [wantColor ? 'colour "' + params.color + '"' : "", wantSize ? 'size "' + params.size + '"' : ""]
        .filter(Boolean)
        .join(" and ") +
      ", so these are the closest " + top.length + " of " + total +
      " products instead. IMPORTANT: the global catalog shows only one representative variant " +
      "per product, so it cannot confirm a colour or size is in stock. Say so, and tell the " +
      "buyer to check the listing or ask the merchant."
    : rows.length + " matching variants across " + total + " products; showing " + top.length +
      " cheapest. Colour/size come from one representative variant, so treat them as a hint, " +
      "not an inventory check."

  return {
    text: header + "\n\n" + lines.join("\n"),
    details: { matched: rows.length, products: total, shown: top.length, softened },
  }
}

/** Ask one merchant for its physical stores. Read-only. */
export async function findStores(params: StoreParams, opts: CallOpts = {}): Promise<Outcome> {
  const domain = String(params.business).replace(/^https?:\/\//, "").replace(/\/.*$/, "")
  const limit = Math.min(Math.max(Number(params.limit ?? 10), 1), 50)

  // Telling the model "at most three merchants" in the prompt does not hold: a capable
  // local model still swept nine. Claim the merchant here instead of asking for restraint.
  // The claim lands before the network work, so a crash mid-lookup still counts it.
  if (opts.budget) {
    const claim = await opts.budget(domain)
    if (!claim.ok) {
      return {
        text:
          "Store-lookup budget spent: " + claim.checked.length + " merchants already checked (" +
          claim.checked.join(", ") + "). Stop calling shop_stores and answer with what " +
          "you have. Merchants you did not check are unknown, not online-only — say that.",
        details: { budgetExceeded: true, checked: claim.checked },
      }
    }
  }

  opts.onProgress?.("Checking " + domain + " for store locations...")

  // 1. Does this merchant advertise the location capability at all?
  let caps: string[] = []
  try {
    const { stdout } = await run("ucp", ["discover", "--business", domain, "--format", "json"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 150000,
      signal: opts.signal,
    })
    const d = JSON.parse(stdout)
    caps = Object.keys(d.result?.profile?.ucp?.capabilities ?? {})
  } catch (err: any) {
    const msg = String(err?.stdout || err?.stderr || err?.message || err).slice(0, 500)
    return {
      text: "Could not discover " + domain + ": " + msg,
      details: { error: msg },
      isError: true,
    }
  }

  if (!caps.some((c) => c === "dev.ucp.common.location.search")) {
    return {
      text:
        domain +
        " does not advertise dev.ucp.common.location.search, so it exposes no physical stores " +
        "over UCP. Treat it as online-only. It does advertise: " + (caps.join(", ") || "nothing"),
      details: { hasLocations: false, capabilities: caps },
    }
  }

  // 2. Ask the merchant's own endpoint.
  const location: any = {}
  if (params.query) location.query = params.query
  const hasCenter = params.latitude != null && params.longitude != null
  if (hasCenter) {
    location.distance = {
      center: { latitude: Number(params.latitude), longitude: Number(params.longitude) },
      max: Math.round(Number(params.radius_km ?? 50) * 1000),
    }
  }

  let locs: any[]
  let widened = false
  try {
    const result = await businessTool(domain, "search_locations", { location }, opts.signal)
    locs = JSON.parse(textOf(result)).locations ?? []

    // search_locations matches literally: a chain around Montreal names its stores
    // Laval, Brossard, Vaudreuil-Dorion, so query "Montreal" returns nothing while the
    // merchant does have stores there. Never report that as "no stores" — list them all.
    if (locs.length === 0 && params.query) {
      const all = await businessTool(domain, "search_locations", { location: {} }, opts.signal)
      const every = JSON.parse(textOf(all)).locations ?? []
      if (every.length > 0) {
        locs = every
        widened = true
      }
    }
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 500)
    return {
      text: "search_locations failed on " + domain + ": " + msg,
      details: { error: msg },
      isError: true,
    }
  }

  if (locs.length === 0) {
    const how = params.query
      ? ' matching "' + params.query + '"'
      : hasCenter
        ? " within " + (params.radius_km ?? 50) + " km"
        : ""
    return {
      text:
        domain + " has the location capability but reported no active store" + how +
        ". Drop the query or widen the radius to list every store it does have.",
      details: { hasLocations: true, matched: 0 },
    }
  }

  const center = hasCenter
    ? { latitude: Number(params.latitude), longitude: Number(params.longitude) }
    : undefined

  const lines = locs.slice(0, limit).map((l: any, i: number) => {
    const a = l.address ?? {}
    const where = [a.address_locality, a.address_region, a.address_country, a.postal_code]
      .filter(Boolean)
      .join(" ")
    const dist = center && l.geo ? " (" + haversineKm(center, l.geo).toFixed(1) + " km)" : ""
    const phone = a.phone_number ? " | " + a.phone_number : ""
    return i + 1 + ". " + l.name + dist + "\n   " + (a.street_address ?? "") + "\n   " + where + phone
  })

  const head = widened
    ? 'No store name or address contains "' + params.query + '", but ' + domain +
      " has " + locs.length + " store(s). Matching is literal, so a chain around a city often " +
      "names its branches after suburbs. Judge from the addresses which are near the buyer:"
    : locs.length + " active store(s) at " + domain + (center ? ", nearest first" : "") + ":"

  return {
    text: head + "\n\n" + lines.join("\n"),
    details: {
      hasLocations: true,
      matched: locs.length,
      shown: Math.min(limit, locs.length),
      widened,
    },
  }
}

// ---------------------------------------------------------------------------
// Prose both harnesses register the tools with, so there is one copy of it.
// ---------------------------------------------------------------------------

export const SEARCH_DESCRIPTION =
  "Search the UCP global catalog (real Shopify merchants) and return a compact ranked list of " +
  "purchasable variants. Handles the ~180 KB protocol envelope for you: you get only the rows. " +
  "Location narrowing happens HERE, with ships_to_* and ships_from_countries. Read-only."

export const SEARCH_GUIDELINES = [
  "Use shop_search for any product lookup; do not call the ucp MCP tools or write codemode scripts for catalog search.",
  "Pass color, size and price to shop_search as parameters instead of filtering the results yourself.",
  "For a buyer in a country, set shop_search ships_to_country, and set ships_from_countries to the same country when they want it stocked domestically.",
  "shop_search prices are already in dollars. Quote them as returned.",
  "shop_search returns a merchant domain per row; feed that to shop_stores to find physical stores.",
]

export const STORES_DESCRIPTION =
  "Find a merchant's physical store locations. Takes the merchant domain from a shop_search row. " +
  "Store proximity lives on the merchant, not the global catalog, so this is always a SECOND step " +
  "after shop_search. Only merchants that advertise dev.ucp.common.location answer; the rest are " +
  "online-only and this says so. Read-only."

export const STORES_GUIDELINES = [
  "Call shop_stores only after shop_search, using the domain shown in a shop_search row.",
  "When the buyer names a city, pass it to shop_stores as query; words are matched literally, so use full region names, not abbreviations.",
  "If shop_stores reports a merchant has no location capability, treat that merchant as online-only rather than retrying.",
]

/** Field help, shared so the pi TypeBox schema and the durable pi-schema one cannot drift. */
export const FIELD_HELP = {
  query: "Product search terms, e.g. 'Patagonia puffer jacket men'",
  max_price: "Maximum price in DOLLARS, e.g. 40 or 299.99",
  color: "Colour to match, e.g. 'blue'. Matched loosely.",
  size: "Size to match, e.g. 'L' or 'Large'. Matched loosely.",
  limit: "Rows to return, default 8, max 25",
  ships_to_country:
    "ISO 3166-1 alpha-2 destination country, e.g. 'CA'. Keeps only variants that ship there.",
  ships_to_region: "Destination province/state, e.g. 'QC'. Needs ships_to_country.",
  ships_to_postal: "Destination postal code, e.g. 'H2X 1Y4'. Needs ships_to_country.",
  ships_from_countries:
    "ISO alpha-2 origin countries, e.g. ['CA']. Keeps only variants shipped FROM those countries. OR logic.",
  business: "Merchant domain from a shop_search row, e.g. 'alpine-country-lodge.myshopify.com'",
  store_query:
    "Literal text that must appear in the store name or address, e.g. 'Montreal' or 'Quebec'. No geocoding.",
  latitude: "Centre latitude for a proximity search",
  longitude: "Centre longitude for a proximity search",
  radius_km: "Radius in km around the centre, default 50",
  store_limit: "Stores to return, default 10",
} as const

/** The shopping agent's standing instructions. Identical on both paths. */
export const SHOP_POLICY = [
  "You are a shopping research agent with two tools: shop_search and shop_stores. You cannot buy",
  "anything. Never claim an order was placed. Hand over the buy URL for the human to finish.",
  "",
  "UCP splits location across two layers, so work in two phases:",
  "1. shop_search is global. Narrow it with ships_to_country (+region/postal) for where the buyer is,",
  "   and ships_from_countries when they want stock held in that country. Also pass max_price, color,",
  "   size. Each row shows a merchant domain.",
  "2. shop_stores asks ONE merchant, by domain, for its physical stores. Proximity data lives on the",
  "   merchant, never in the global catalog, so this is always the second step. Many merchants are",
  "   online-only and will say so; that is a normal answer, not an error.",
  "",
  "If the buyer named a city, do phase 1 with their country, then call shop_stores on AT MOST THREE",
  "merchants, chosen from the rows you will actually recommend, with the city as query. Each call is a",
  "network round trip, so never sweep the whole result list. Report which merchants have a store near",
  "the buyer and which are online-only. Do not repeat a call with the same arguments.",
  "",
  "Answer with a short ranked table with exactly these columns: Item, Colour/Size, Price, Merchant,",
  "Link. Keep each value in its own column. Then name your pick, and say plainly whether it can be",
  "bought in person near the buyer or only shipped.",
].join("\n")
