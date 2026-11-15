// Print a thread's committed transcript, for checking what survived a crash.
//   node dump.ts --thread kill1

import { join, dirname } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { llamaProvider } from "./models.ts"
import { ShopTools } from "./tools.ts"

const context = BACKGROUND_CONTEXT
const i = process.argv.indexOf("--thread")
const thread = i >= 0 ? process.argv[i + 1] : "default"
const stateDir =
  process.env.SHOP_STATE_DIR ?? join(dirname(new URL(import.meta.url).pathname), "..", ".shop-state")

const models = createModels()
models.setProvider(llamaProvider())
const registry = createRegistry()
registry.install(ShopTools)

// readOnly: open recovers nothing and runs no tasks, so inspecting is never a side effect.
const storage = await openNodeSqliteStorage(join(stateDir, thread + ".sqlite"))
const harness = await Harness.open(storage, { models, registry, readOnly: true }, context)
const root = await harness.root(context)

const page = await root.entries({ conversationId: root.id, order: "ascending" }, 200, undefined, context)
for (const e of page.items) {
  const msg = e.model?.[0] as { content?: unknown } | undefined
  const content = msg?.content
  let summary = ""
  if (typeof content === "string") summary = content
  else if (Array.isArray(content)) {
    summary = (content as { type?: string; text?: string; name?: string }[])
      .map((b) =>
        b.type === "toolCall" ? "<call " + b.name + ">" : (b.text ?? "").replace(/\s+/g, " "),
      )
      .join(" ")
  }
  console.log(String(e.id).padStart(4) + "  " + e.kind.padEnd(16) + summary.slice(0, 110))
}
await harness.close(context)
