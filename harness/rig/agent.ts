import { join } from "node:path"
import type { HookEndReason, HookSource } from "@iter8/protocol"
import { type AgentCommand, AgentEvent } from "../stubs/agent-session"
import { type CliEnv, type CliRun, childEnv, cliCommand, cliRun } from "./cli"
import { waitFor } from "./wait"

const STUB = Bun.fileURLToPath(new URL("../stubs/agent-session.ts", import.meta.url))
const STARTED_TIMEOUT_MS = 15_000
const REPLY_TIMEOUT_MS = 30_000

export type AgentSessionOptions = { label?: string; cliCommand?: string[] }

export type HookRun = { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

/** The JSON Claude Code writes to a hook command's stdin. */
export type HookInput = {
  session_id: string
  transcript_path: string
  cwd: string
  hook_event_name: string
  source?: HookSource
  reason?: HookEndReason
  prompt?: string
}

type Named<E extends AgentEvent["event"]> = Extract<AgentEvent, { event: E }>

export type AgentSession = {
  pid: number
  /** The current label, which changes on every clear. */
  readonly label: string
  events: AgentEvent[]
  waitForEvent(predicate: (event: AgentEvent) => boolean, timeoutMs: number): Promise<AgentEvent>
  prompt(): Promise<Named<"prompted">>
  stop(): Promise<Named<"stopped">>
  clear(): Promise<Named<"cleared">>
  /** Resolves to the stub's exit code once it has run `hook end` and exited. */
  exit(): Promise<number>
  crash(): Promise<void>
  run(args: string[]): Promise<CliRun>
  /** Leave it unawaited to run an async hook. */
  runHook(hook: {
    command: string
    input: HookInput
    env?: Record<string, string>
    timeoutMs: number
  }): Promise<HookRun>
  hookInput(event: string, extra?: Pick<HookInput, "source" | "reason" | "prompt">): HookInput
}

export async function startAgentSession(
  service: { home: string; env: CliEnv },
  options: AgentSessionOptions = {},
): Promise<AgentSession> {
  let label = options.label ?? crypto.randomUUID()
  const command = options.cliCommand ?? service.env.command ?? cliCommand()
  const child = Bun.spawn([process.execPath, STUB, label, ...command], {
    env: childEnv(service.env),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const events: AgentEvent[] = []
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffered = ""
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true })
      const complete = buffered.split("\n")
      buffered = complete.pop() ?? ""
      for (const line of complete.filter((text) => text !== "")) {
        let parsed: AgentEvent
        try {
          parsed = AgentEvent.parse(JSON.parse(line))
        } catch {
          parsed = { event: "error", message: `unparseable stub output: ${line}` }
        }
        if (parsed.event === "cleared") label = parsed.label
        events.push(parsed)
      }
    }
  })()
  const stderr = new Response(child.stderr).text()
  const gone = () => child.exitCode !== null || child.signalCode !== null

  const eventAfter = (from: number, predicate: (event: AgentEvent) => boolean, timeoutMs: number) =>
    waitFor(
      "a matching stub agent session event",
      async () => {
        const found = events.slice(from).find(predicate)
        if (found !== undefined) return found
        if (!gone()) return null
        await reading
        const late = events.slice(from).find(predicate)
        if (late !== undefined) return late
        throw new Error(
          `the stub agent session exited (${child.exitCode ?? child.signalCode}) first; events: ${JSON.stringify(events)}\nstderr: ${await stderr}`,
        )
      },
      { timeoutMs },
    )

  const send = (command: AgentCommand) => {
    child.stdin.write(`${JSON.stringify(command)}\n`)
    child.stdin.flush()
  }

  const request = async <E extends AgentEvent["event"]>(
    command: AgentCommand,
    event: E,
    timeoutMs = REPLY_TIMEOUT_MS,
  ): Promise<Named<E>> => {
    const from = events.length
    send(command)
    const match = (candidate: AgentEvent) =>
      candidate.event === event &&
      (!("id" in command) || ("id" in candidate && candidate.id === command.id))
    return (await eventAfter(from, match, timeoutMs)) as Named<E>
  }

  let nextId = 0

  try {
    await eventAfter(0, (event) => event.event === "started", STARTED_TIMEOUT_MS)
  } catch (error) {
    child.kill("SIGKILL")
    await child.exited
    throw error
  }

  return {
    pid: child.pid,
    get label() {
      return label
    },
    events,
    waitForEvent: (predicate, timeoutMs) => eventAfter(0, predicate, timeoutMs),
    prompt: () => request({ op: "prompt" }, "prompted"),
    stop: () => request({ op: "stop" }, "stopped"),
    clear: () => request({ op: "clear" }, "cleared"),
    exit: async () => {
      send({ op: "exit" })
      return child.exited
    },
    crash: async () => {
      send({ op: "crash" })
      await child.exited
    },
    run: async (args) => {
      const ran = await request({ op: "run", id: ++nextId, args }, "ran")
      return cliRun(ran.exitCode, ran.stdout, ran.stderr)
    },
    runHook: async ({ command, input, env = {}, timeoutMs }) => {
      const ran = await request(
        { op: "run-hook", id: ++nextId, command, input, env, timeoutMs },
        "hook-ran",
        timeoutMs + REPLY_TIMEOUT_MS,
      )
      return {
        exitCode: ran.exitCode,
        stdout: ran.stdout,
        stderr: ran.stderr,
        timedOut: ran.timedOut,
      }
    },
    hookInput: (event, extra = {}) => ({
      session_id: label,
      transcript_path: join(service.home, "transcripts", `${label}.jsonl`),
      cwd: process.cwd(),
      hook_event_name: event,
      ...extra,
    }),
  }
}
