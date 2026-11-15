#!/usr/bin/env node
// The shopping agent as a pi-durable harness, run once per invocation.
//
//   node run.ts --thread demo --task "merino beanie under $40, ship to Canada"
//   node run.ts --thread demo --resume      # drive whatever the last process left unfinished
//   node run.ts --thread demo --inspect     # what is pending, without running anything
//
// Everything is committed to <state-dir>/<thread>.sqlite before it is shown. A process
// killed mid-run leaves the work pending rather than losing it: the next invocation with
// the same thread picks it up from the last committed step.
//
// Progress goes to stderr as JSONL. stdout gets exactly one JSON object, last line.

import { existsSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  Harness,
  type Conversation,
  type SettledSubmissionRecord,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { SHOP_POLICY } from "../shop/core.ts"
import { ShopBudgetDoc } from "./budget.ts"
import { llamaProvider, MODEL_REF } from "./models.ts"
import { ShopTools } from "./tools.ts"

const context = BACKGROUND_CONTEXT

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes("--" + name)

const thread = (arg("thread") ?? "default").replace(/[^a-zA-Z0-9_.-]/g, "") || "default"
const task = arg("task")
const resumeOnly = flag("resume")
const inspectOnly = flag("inspect")
const maxTurns = Number(arg("max-turns") ?? process.env.SHOP_MAX_TURNS ?? 12)

const stateDir =
  arg("state-dir") ??
  process.env.SHOP_STATE_DIR ??
  join(dirname(new URL(import.meta.url).pathname), "..", ".shop-state")

if (!task && !resumeOnly && !inspectOnly) {
  process.stderr.write("usage: run.ts --thread <id> (--task <text> | --resume | --inspect)\n")
  process.exit(2)
}

const progress = (event: Record<string, unknown>) =>
  process.stderr.write(JSON.stringify({ t: Date.now(), ...event }) + "\n")

// ---------------------------------------------------------------------------
// Reading the answer back out of the transcript
// ---------------------------------------------------------------------------

function textBlocks(entry: unknown): string {
  const msg = (entry as { model?: { content?: unknown }[] } | undefined)?.model?.[0]
  const content = (msg as { content?: unknown })?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b: { type?: string }) => b?.type === "text")
    .map((b: { text?: string }) => b.text ?? "")
    .join("")
}

/**
 * What the run did, read from the committed context: the answer, the tool names called,
 * and the last tool result as text. The model sometimes ends a run without writing a
 * summary; handing back raw tool output beats failing the delegation.
 *
 * `context()` is a plain read of committed state, so none of this writes anything.
 */
async function readRun(root: Conversation, answerId: string | undefined) {
  const view = await root.context(context)
  const names: string[] = []
  let toolCalls = 0
  let lastToolText = ""
  let answer = ""

  for (const e of view.entries) {
    if (answerId && e.id === answerId) answer = textBlocks(e)
    if (e.kind === "pi.tool-result") {
      toolCalls++
      const text = textBlocks(e)
      if (text.trim()) lastToolText = text.slice(0, 8000)
      continue
    }
    if (e.kind !== "pi.assistant") continue
    const content = (e.model?.[0] as { content?: unknown })?.content
    if (!Array.isArray(content)) continue
    for (const b of content as { type?: string; name?: string }[]) {
      if (b?.type === "toolCall" && b.name) names.push(b.name)
    }
  }
  // Without an answer entry, fall back to the newest assistant text in context.
  if (!answer) {
    for (const e of [...view.entries].reverse()) {
      if (e.kind !== "pi.assistant") continue
      const text = textBlocks(e)
      if (text.trim()) {
        answer = text
        break
      }
    }
  }
  return { tools: [...new Set(names)], toolCalls, lastToolText, answer }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(stateDir, { recursive: true })
const dbPath = join(stateDir, thread + ".sqlite")

// Resuming or inspecting a thread that was never run should not create its storage.
if ((resumeOnly || inspectOnly) && !existsSync(dbPath)) {
  process.stdout.write(JSON.stringify({ status: "idle", thread, db: dbPath, fresh: true }) + "\n")
  process.exit(0)
}

const models = createModels()
models.setProvider(llamaProvider())

const registry = createRegistry()
registry.install(ShopTools)

const storage = await openNodeSqliteStorage(dbPath)
// Inspecting must never recover work or write: a read-only Harness rejects both.
const harness = await Harness.open(
  storage,
  { models, registry, readOnly: inspectOnly },
  context,
)

/** Thrown to leave the try block early once a terminal answer is already printed. */
const DONE = Symbol("done")

let exitCode = 0
try {
  const root = inspectOnly
    ? await harness.root(context)
    : await harness.root(context, {
        agent: {
          model: MODEL_REF,
          thinkingLevel: "off",
          instructions: SHOP_POLICY,
          maxTurns,
        },
      })

  if (inspectOnly) {
    const i = await harness.inspect(context)
    process.stdout.write(
      JSON.stringify(
        {
          thread,
          db: dbPath,
          scheduling: i.scheduling,
          liveTasks: i.tasks.map((t) => ({ kind: t.record.kind, state: t.state.kind })),
          pending: i.submissions.map((s) => ({ id: s.id, type: s.type, status: s.status })),
          storeBudgetSpent: (await harness.snapshot(ShopBudgetDoc, root.id, context))?.checked ?? [],
        },
        null,
        2,
      ) + "\n",
    )
  } else {
    // Pending work the last process left, if any. resume() starts the scheduler;
    // waiting on the submission is what drives it to completion.
    const before = await harness.inspect(context)
    const pending = before.submissions.filter((s) => s.type === "input")
    harness.resume()

    let settled: SettledSubmissionRecord
    let resumed = false
    let requestId = ""

    if (resumeOnly) {
      if (pending.length === 0) {
        process.stdout.write(JSON.stringify({ status: "idle", thread, db: dbPath }) + "\n")
        throw DONE
      }
      const sub = await harness.submission(pending[0].id, context)
      if (!sub) throw new Error("submission " + pending[0].id + " vanished")
      progress({ event: "resuming", submission: pending[0].id })
      resumed = true
      settled = await sub.wait(context)
    } else {
      // Same task on the same thread is the same request: a retry after a crash
      // reacquires the original submission instead of asking the model twice.
      requestId = "shop-" + createHash("sha256").update(task!).digest("hex").slice(0, 16)
      resumed = pending.some((s) => s.requestId === requestId)
      progress({ event: resumed ? "rejoining" : "submitting", requestId })
      const sub = await root.submit({ type: "input", content: task!, requestId }, context)
      settled = await sub.wait(context)
    }

    const tail = await readRun(root, settled.status === "done" ? settled.answer : undefined)
    const answer = tail.answer

    const usage = await harness.usage(context)
    let input = 0
    let output = 0
    for (const u of Object.values(usage.models ?? {})) {
      input += (u as { input?: number }).input ?? 0
      output += (u as { output?: number }).output ?? 0
    }
    process.stdout.write(
      JSON.stringify({
        status: settled.status,
        reason: settled.status === "unanswered" ? settled.reason : undefined,
        text: answer.trim(),
        fallbackText: answer.trim() ? undefined : tail.lastToolText,
        tools: tail.tools,
        toolCalls: tail.toolCalls,
        resumed,
        requestId: requestId || undefined,
        thread,
        db: dbPath,
        // Merchants this task has spent its store-lookup budget on, across every process
        // that has worked on it.
        storeBudgetSpent: (await harness.snapshot(ShopBudgetDoc, root.id, context))?.checked ?? [],
        tokens: input || output ? { input, output } : undefined,
      }) + "\n",
    )
    if (settled.status !== "done") exitCode = 1
  }
} catch (err) {
  if (err !== DONE) {
    process.stderr.write("runner failed: " + String((err as Error)?.stack ?? err) + "\n")
    exitCode = 1
  }
} finally {
  await harness.close(context)
}

process.exit(exitCode)
