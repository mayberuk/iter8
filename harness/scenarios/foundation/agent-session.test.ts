import { expect, test } from "bun:test"
import { mkdtemp, rename, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { POINTER_LINE } from "@iter8/protocol"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { WORKER } from "../../rig/ports"
import { type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { FAKE_CLI_ENTRY, type FakeCliCall, readFakeCliCalls } from "../../stubs/fake-cli"

type Context = {
  service: RunningService
  session: AgentSession
  dir: string
  wake: string
  calls(): Promise<FakeCliCall[]>
}

async function withSession(
  vars: Record<string, string>,
  body: (context: Context) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(`/tmp/iter8-fake-w${WORKER}-`)
  const log = join(dir, "calls.jsonl")
  const wake = join(dir, "wake.json")
  const service = await startService({
    entry: FAKE_CLI_ENTRY,
    env: { FAKE_CLI_LOG: log, FAKE_CLI_WAKE: wake, ...vars },
  })
  try {
    const session = await startAgentSession(service)
    try {
      await body({ service, session, dir, wake, calls: () => readFakeCliCalls(log) })
    } finally {
      if (alive(session.pid)) await session.exit()
    }
  } finally {
    await service.stop()
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hook(calls: FakeCliCall[], ...subcommands: string[]): FakeCliCall[] {
  return calls.filter((call) => call.argv[0] === "hook" && subcommands.includes(call.argv[1] ?? ""))
}

async function waitCalls(context: Context, count: number): Promise<FakeCliCall[]> {
  return waitFor(`${count} recorded hook wait calls`, async () => {
    const waits = hook(await context.calls(), "wait")
    return waits.length === count ? waits : null
  })
}

const POINTERS = JSON.stringify([
  { roundId: "R4", pageId: "larkspur", noteCount: 1 },
  { roundId: "R12", pageId: "mock-pricing", noteCount: 3 },
])
const POINTER_TEXT = [
  "Review round R4 from larkspur · 1 note — run `iter8 show R4`",
  "Review round R12 from mock-pricing · 3 notes — run `iter8 show R12`",
]

test("start runs hook start with the stub's own pid and source startup, then arms hook wait", async () => {
  await withSession({}, async (context) => {
    const { session } = context
    const pid = String(session.pid)
    expect(alive(session.pid)).toBe(true)
    const starts = hook(await context.calls(), "start")
    expect(starts.map((call) => call.argv)).toEqual([
      [
        "hook",
        "start",
        "--pid",
        pid,
        "--label",
        session.label,
        "--source",
        "startup",
        "--agent",
        "stub",
      ],
    ])
    expect(starts[0]?.ppid).toBe(session.pid)
    expect(starts[0]?.env.CLAUDE_CODE_SESSION_ID).toBe(session.label)

    const [wait] = await waitCalls(context, 1)
    expect(wait?.argv.slice(0, 4)).toEqual(["hook", "wait", "--pid", pid])
    expect(wait?.argv[4]).toBe("--timeout-seconds")
    expect(Number(wait?.argv[5])).toBeGreaterThan(0)
    expect(wait?.ppid).toBe(session.pid)
  })
}, 30_000)

test("clear ends the old label with reason clear, then starts a new label on the same pid", async () => {
  await withSession({}, async (context) => {
    const { session } = context
    const pid = String(session.pid)
    const first = session.label
    const cleared = await session.clear()
    expect(cleared.endExitCode).toBe(0)
    expect(cleared.exitCode).toBe(0)
    expect(cleared.label).not.toBe(first)
    expect(session.label).toBe(cleared.label)

    const lifecycle = hook(await context.calls(), "start", "end")
    expect(lifecycle.map((call) => call.argv)).toEqual([
      ["hook", "start", "--pid", pid, "--label", first, "--source", "startup", "--agent", "stub"],
      ["hook", "end", "--pid", pid, "--label", first, "--reason", "clear"],
      [
        "hook",
        "start",
        "--pid",
        pid,
        "--label",
        cleared.label,
        "--source",
        "clear",
        "--agent",
        "stub",
      ],
    ])
    expect(lifecycle.map((call) => call.ppid)).toEqual([session.pid, session.pid, session.pid])
    expect(lifecycle[2]?.env.CLAUDE_CODE_SESSION_ID).toBe(cleared.label)
  })
}, 30_000)

test("prompt emits the pointer lines hook prompt printed, each a whole pointer line", async () => {
  await withSession({ FAKE_CLI_POINTERS: POINTERS }, async (context) => {
    const { session } = context
    const started = session.events.find((event) => event.event === "started")
    expect(started).toMatchObject({ lines: POINTER_TEXT })

    const prompted = await session.prompt()
    expect(prompted.exitCode).toBe(0)
    expect(prompted.lines).toEqual(POINTER_TEXT)
    for (const line of prompted.lines) expect(line).toMatch(POINTER_LINE)
    expect(hook(await context.calls(), "prompt").map((call) => call.argv)).toEqual([
      ["hook", "prompt", "--pid", String(session.pid)],
    ])
  })
}, 30_000)

test("a wake makes hook wait exit with the wake code, emitting woken until the next stop re-arms", async () => {
  await withSession({}, async (context) => {
    const { session, wake } = context
    await waitCalls(context, 1)
    const staging = `${wake}.partial`
    await writeFile(staging, JSON.stringify([{ roundId: "R7", pageId: "larkspur", noteCount: 2 }]))
    await rename(staging, wake)

    const woken = await session.waitForEvent((event) => event.event === "woken", 10_000)
    expect(woken).toEqual({
      event: "woken",
      lines: ["Review round R7 from larkspur · 2 notes — run `iter8 show R7`"],
    })
    expect(woken.event === "woken" && woken.lines.every((line) => POINTER_LINE.test(line))).toBe(
      true,
    )

    await unlink(wake)
    const stopped = await session.stop()
    expect(stopped.exitCode).toBe(0)
    const waits = await waitCalls(context, 2)
    expect(waits.map((call) => call.argv[3])).toEqual([String(session.pid), String(session.pid)])
    expect(session.events.filter((event) => event.event === "woken")).toHaveLength(1)
  })
}, 30_000)

test("run-hook runs the command as the stub's child with hook JSON on stdin and the env merged", async () => {
  await withSession({}, async (context) => {
    const { service, session } = context
    const input = session.hookInput("Stop")
    expect(input).toEqual({
      session_id: session.label,
      transcript_path: join(service.home, "transcripts", `${session.label}.jsonl`),
      cwd: process.cwd(),
      hook_event_name: "Stop",
    })
    expect(session.hookInput("SessionStart", { source: "clear" }).source).toBe("clear")

    const result = await session.runHook({
      command:
        'printf "ppid=%s\\npool=%s\\nprobe=%s\\n" "$PPID" "$ITER8_POOL" "$STUB_PROBE"; cat; echo refused >&2; exit 3',
      input,
      env: { ITER8_POOL: "1-2", STUB_PROBE: "from-test" },
      timeoutMs: 10_000,
    })
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toBe("refused\n")
    expect(result.timedOut).toBe(false)
    const [ppid, pool, probe, stdin] = result.stdout.split("\n")
    expect(ppid).toBe(`ppid=${session.pid}`)
    expect(pool).toBe("pool=1-2")
    expect(probe).toBe("probe=from-test")
    expect(JSON.parse(stdin ?? "")).toEqual(input)
  })
}, 30_000)

test("an unawaited run-hook leaves the session free, and one outliving its timeout is stopped", async () => {
  await withSession({}, async (context) => {
    const { session, dir } = context
    const gate = join(dir, "gate")
    let released = false
    const pending = session
      .runHook({
        command: 'while [ ! -f "$GATE" ]; do sleep 0.05; done; echo released',
        input: session.hookInput("Stop"),
        env: { GATE: gate },
        timeoutMs: 20_000,
      })
      .then((result) => {
        released = true
        return result
      })
    const version = await session.run(["--version"])
    expect(version.stdout.trim()).toBe("iter8 0.0.0-fake")
    expect(released).toBe(false)
    await writeFile(gate, "")
    expect(await pending).toMatchObject({ exitCode: 0, stdout: "released\n", timedOut: false })

    const started = performance.now()
    const slow = await session.runHook({
      command: "sleep 5; echo late",
      input: session.hookInput("Stop"),
      timeoutMs: 300,
    })
    expect(slow.timedOut).toBe(true)
    expect(slow.stdout).not.toContain("late")
    expect(performance.now() - started).toBeLessThan(3_000)
  })
}, 30_000)

test("crash kills the stub without running hook end", async () => {
  await withSession({}, async (context) => {
    const { session } = context
    await session.crash()
    expect(alive(session.pid)).toBe(false)
    expect(hook(await context.calls(), "end")).toEqual([])
    expect(session.events.some((event) => event.event === "exiting")).toBe(false)
  })
}, 30_000)

test("exit runs hook end with reason other and the current label, then exits 0", async () => {
  await withSession({}, async (context) => {
    const { session } = context
    const label = session.label
    expect(await session.exit()).toBe(0)
    expect(alive(session.pid)).toBe(false)
    expect(hook(await context.calls(), "end").map((call) => call.argv)).toEqual([
      ["hook", "end", "--pid", String(session.pid), "--label", label, "--reason", "other"],
    ])
  })
}, 30_000)
