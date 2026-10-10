import { writeSync } from "node:fs"
import { ExitCode } from "@iter8/protocol"
import { z } from "zod"

export const AgentCommand = z.discriminatedUnion("op", [
  z.object({ op: z.literal("prompt") }),
  z.object({ op: z.literal("stop") }),
  z.object({ op: z.literal("clear") }),
  z.object({ op: z.literal("exit") }),
  z.object({ op: z.literal("crash") }),
  z.object({ op: z.literal("run"), id: z.number().int(), args: z.array(z.string()) }),
  z.object({
    op: z.literal("run-hook"),
    id: z.number().int(),
    command: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    env: z.record(z.string(), z.string()),
    timeoutMs: z.number().int().positive(),
  }),
])
export type AgentCommand = z.infer<typeof AgentCommand>

const Output = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
const exitCode = z.number().int()
const lines = z.array(z.string())

export const AgentEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("started"), label: z.string(), exitCode, lines }),
  z.object({ event: z.literal("prompted"), exitCode, lines }),
  z.object({ event: z.literal("stopped"), exitCode }),
  z.object({
    event: z.literal("cleared"),
    label: z.string(),
    endExitCode: exitCode,
    exitCode,
    lines,
  }),
  z.object({ event: z.literal("exiting"), exitCode }),
  z.object({ event: z.literal("woken"), lines }),
  z.object({ event: z.literal("listener-ended"), exitCode, stderr: z.string() }),
  Output.extend({ event: z.literal("ran"), id: z.number().int() }),
  Output.extend({ event: z.literal("hook-ran"), id: z.number().int(), timedOut: z.boolean() }),
  z.object({ event: z.literal("error"), message: z.string() }),
])
export type AgentEvent = z.infer<typeof AgentEvent>

const LISTENER_TIMEOUT_SECONDS = 600

function emit(event: AgentEvent): void {
  writeSync(1, `${JSON.stringify(event)}\n`)
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "")
}

async function collect(child: {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}) {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode: code, stdout, stderr }
}

async function main(argv: string[]): Promise<void> {
  const [initialLabel, ...command] = argv
  if (initialLabel === undefined || command.length === 0) {
    throw new Error("usage: agent-session.ts LABEL CLI_COMMAND...")
  }
  let label = initialLabel
  const pid = String(process.pid)
  let listener: Bun.Subprocess | null = null

  const cli = (args: string[]) =>
    collect(
      Bun.spawn([...command, ...args], {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: label },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )

  const disarm = () => {
    const old = listener
    listener = null
    old?.kill()
  }

  const arm = () => {
    disarm()
    const child = Bun.spawn(
      [
        ...command,
        "hook",
        "wait",
        "--pid",
        pid,
        "--timeout-seconds",
        `${LISTENER_TIMEOUT_SECONDS}`,
      ],
      {
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: label },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    listener = child
    void Promise.all([child.exited, new Response(child.stderr).text()]).then(([code, stderr]) => {
      if (listener !== child) return
      listener = null
      if (code === ExitCode.wake) emit({ event: "woken", lines: splitLines(stderr) })
      else emit({ event: "listener-ended", exitCode: code, stderr })
    })
  }

  const runHook = async (hook: Extract<AgentCommand, { op: "run-hook" }>) => {
    const child = Bun.spawn(["sh", "-c", hook.command], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: label, ...hook.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so a timeout also stops whatever the shell started.
      detached: true,
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, hook.timeoutMs)
    try {
      child.stdin.write(JSON.stringify(hook.input))
      await child.stdin.end()
    } catch {
      // A command that exits without reading its input closes the pipe first.
    }
    const output = await collect(child)
    clearTimeout(timer)
    emit({ event: "hook-ran", id: hook.id, ...output, timedOut })
  }

  const lifecycle = {
    prompt: async () => {
      const run = await cli(["hook", "prompt", "--pid", pid])
      emit({ event: "prompted", exitCode: run.exitCode, lines: splitLines(run.stdout) })
    },
    stop: async () => {
      const run = await cli(["hook", "stop", "--pid", pid])
      arm()
      emit({ event: "stopped", exitCode: run.exitCode })
    },
    clear: async () => {
      const end = await cli(["hook", "end", "--pid", pid, "--label", label, "--reason", "clear"])
      label = crypto.randomUUID()
      const start = await cli([
        "hook",
        "start",
        "--pid",
        pid,
        "--label",
        label,
        "--source",
        "clear",
        "--agent",
        "stub",
      ])
      emit({
        event: "cleared",
        label,
        endExitCode: end.exitCode,
        exitCode: start.exitCode,
        lines: splitLines(start.stdout),
      })
    },
    exit: async () => {
      const end = await cli(["hook", "end", "--pid", pid, "--label", label, "--reason", "other"])
      disarm()
      emit({ event: "exiting", exitCode: end.exitCode })
      process.exit(0)
    },
  }

  const start = await cli([
    "hook",
    "start",
    "--pid",
    pid,
    "--label",
    label,
    "--source",
    "startup",
    "--agent",
    "stub",
  ])
  arm()
  emit({ event: "started", label, exitCode: start.exitCode, lines: splitLines(start.stdout) })

  let queue = Promise.resolve()
  const report = (error: unknown) => emit({ event: "error", message: String(error) })

  for await (const line of console) {
    if (line.trim() === "") continue
    let parsed: AgentCommand
    try {
      parsed = AgentCommand.parse(JSON.parse(line))
    } catch (error) {
      report(error)
      continue
    }
    if (parsed.op === "crash") process.kill(process.pid, "SIGKILL")
    else if (parsed.op === "run") {
      void cli(parsed.args).then((run) => emit({ event: "ran", id: parsed.id, ...run }), report)
    } else if (parsed.op === "run-hook") void runHook(parsed).catch(report)
    else queue = queue.then(lifecycle[parsed.op]).catch(report)
  }

  await queue
  disarm()
  process.exit(0)
}

if (import.meta.main) await main(process.argv.slice(2))
