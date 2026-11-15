import { tool } from "@opencode-ai/plugin"
import { spawn } from "node:child_process"
import { join } from "node:path"

// The shopping agent is a pi-durable harness in durable/run.ts, not a pi subprocess.
// Everything it does is committed to .shop-state/<thread>.sqlite before it is shown, so
// an interrupted run is pending rather than lost: handing the SAME task back resumes it.
// Not process.execPath: OpenCode runs tools inside its own binary, so that is `opencode`.
const NODE = process.env.PI_SHOP_NODE ?? "node"
const TIMEOUT_MS = Number(process.env.PI_SHOP_TIMEOUT_MS ?? 900_000)
const MAX = Number(process.env.PI_SHOP_MAX_CHARS ?? 4000)

type Result = {
  status: string
  reason?: string
  text?: string
  fallbackText?: string
  tools?: string[]
  toolCalls?: number
  resumed?: boolean
  thread?: string
  db?: string
  tokens?: { input: number; output: number }
}

type Run = { result?: Result; events: number; stderr: string; code: number | null; timedOut: boolean }

function runAgent(runner: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, ["--disable-warning=ExperimentalWarning", runner, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let out = ""
    let stderr = ""
    let events = 0
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, TIMEOUT_MS)

    child.stdout.on("data", (c) => (out += c.toString()))
    child.stderr.on("data", (c) => {
      const chunk = c.toString()
      stderr += chunk
      // Progress is JSONL on stderr; count it so a silent hang is distinguishable.
      events += chunk.split("\n").filter((l) => l.trim().startsWith("{")).length
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      // The runner writes exactly one JSON object, as its last line.
      const last = out.trim().split("\n").filter(Boolean).pop()
      let result: Result | undefined
      if (last) {
        try {
          result = JSON.parse(last)
        } catch {
          result = undefined
        }
      }
      resolve({ result, events, stderr, code, timedOut })
    })
  })
}

export default tool({
  description:
    "Delegate a shopping research task to a durable pi agent that searches real merchant catalogs " +
    "over UCP. Use for finding products, comparing prices and building shortlists. " +
    "It is read-only: it cannot add to a cart, check out, or buy anything. " +
    "Its state is committed to disk, so if a call is interrupted, calling it again with the SAME " +
    "task and thread resumes where it stopped instead of starting over.",
  args: {
    task: tool.schema
      .string()
      .describe("The shopping task in plain language, e.g. 'merino beanie under $40, ship to Canada'"),
    thread: tool.schema
      .string()
      .optional()
      .describe(
        "Conversation key. Reuse the same value to continue an earlier shopping thread, or to " +
          "resume one that was interrupted.",
      ),
    resume: tool.schema
      .boolean()
      .optional()
      .describe(
        "Finish whatever this thread left unfinished, ignoring `task`. Use only when a previous " +
          "call on this thread was interrupted and you do not have its exact wording.",
      ),
  },
  async execute(args, context) {
    const raw = args.thread?.trim() || context.sessionID || "default"
    const thread = (raw.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 40) || "default")
    const runner = join(context.directory, "durable", "run.ts")
    const started = Date.now()

    const cli = args.resume
      ? ["--thread", thread, "--resume"]
      : ["--thread", thread, "--task", args.task]

    const run = await runAgent(runner, cli, context.directory)
    const secs = ((Date.now() - started) / 1000).toFixed(1)

    // No parsable result: the run was cut off. Its committed steps are still on disk,
    // so say that plainly instead of reporting a dead end.
    if (!run.result) {
      const why = run.timedOut
        ? `timed out after ${TIMEOUT_MS}ms`
        : `exited ${run.code} without a result`
      const tail = run.stderr.trim().split("\n").slice(-6).join("\n")
      return [
        `The shopping agent ${why} after ${secs}s, with ${run.events} progress events.`,
        "",
        "Nothing is lost: every completed step is committed to " +
          `.shop-state/${thread}.sqlite. Call pi_shop again with the same task and ` +
          `thread "${thread}" to carry on from the last committed step, or with resume=true.`,
        "",
        tail ? "Last output:\n" + tail : "",
      ]
        .filter(Boolean)
        .join("\n")
    }

    const r = run.result
    if (r.status === "idle") {
      return `Thread "${thread}" has nothing unfinished to resume.`
    }

    let body = (r.text || r.fallbackText || "").trim()
    if (body.length > MAX) body = body.slice(0, MAX) + `\n…truncated at ${MAX} chars`
    if (!body) {
      body =
        `The agent ended with status "${r.status}"` +
        (r.reason ? ` (${r.reason})` : "") +
        " and wrote nothing."
    }

    const used = [...new Set(r.tools ?? [])].join(", ") || "none"
    const notes = [
      `thread: ${thread}`,
      `tools used: ${used}`,
      `${r.toolCalls ?? 0} tool calls`,
      r.tokens ? `${r.tokens.input}+${r.tokens.output} tokens` : "",
      `${secs}s`,
      r.resumed ? "RESUMED from a previous interrupted run" : "",
      r.status !== "done" ? `status: ${r.status}${r.reason ? " (" + r.reason + ")" : ""}` : "",
      !r.text && r.fallbackText ? "NO SUMMARY (raw tool output)" : "",
    ].filter(Boolean)

    return [body, "", "---", notes.join(" | ")].join("\n")
  },
})
