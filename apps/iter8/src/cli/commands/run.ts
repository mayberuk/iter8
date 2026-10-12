import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { CLI_SURFACE, ExitCode } from "@iter8/protocol"
import { type CommandDef, defineCommand } from "citty"
import { z } from "zod"
import type { Clock } from "../../connect/supervisor"
import { resolvePaths } from "../../home"
import { type CliDeps, type caller, commandArgs, runCli, textFlag } from "../client"
import { openPage } from "./open"
import { fnv1a, planRun, printedPorts, RUN_PORTS, type RunPlan, stablePort } from "./run-plan"

export type DevServer = {
  pid: number
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

type PageTarget = Parameters<typeof openPage>[2]
type Interrupt = "SIGINT" | "SIGTERM" | "SIGHUP"

export type RunSystem = {
  /** Starts the dev server as the leader of its own process group, its output piped. */
  spawn: (
    argv: string[],
    options: { cwd: string; env: Record<string, string | undefined> },
  ) => DevServer
  /** Starts a program this command neither waits for nor outlives; false when it cannot start. */
  launch: (argv: string[]) => boolean
  clock: Clock
  env: Record<string, string | undefined>
  platform: "linux" | "darwin"
  hostname: string
  onInterrupt: (stop: (signal: Interrupt) => void) => void
  probe: (url: string) => Promise<boolean>
  portFree: (port: number) => Promise<boolean>
  open: (target: PageTarget, cwd: string) => Promise<{ url: string; laptops: string[] }>
}

const READY_TIMEOUT_MS = 60_000
const POLL_MS = 100
const PROBE_TIMEOUT_MS = 5_000
const STOP_GRACE_MS = 5_000
const TAIL_LINES = 20
const SIGNAL_EXIT: Record<Interrupt, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined

export function liveSystem(deps: CliDeps, values: Parameters<typeof caller>[1]): RunSystem {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("iter8 run runs on macOS and Linux")
  }
  return {
    spawn: (argv, { cwd, env }) =>
      Bun.spawn(argv, {
        cwd,
        env,
        detached: true,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    launch: (argv) => {
      try {
        Bun.spawn(argv, {
          detached: true,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }).unref()
        return true
      } catch {
        return false
      }
    },
    clock: { now: Date.now, setTimeout, clearTimeout },
    env: process.env,
    platform,
    hostname: hostname(),
    onInterrupt: (stop) => {
      process.on("SIGINT", () => stop("SIGINT"))
      process.on("SIGTERM", () => stop("SIGTERM"))
      process.on("SIGHUP", () => stop("SIGHUP"))
    },
    probe: async (url) => {
      try {
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
        await response.body?.cancel()
        return true
      } catch {
        return false
      }
    },
    portFree: async (port) => {
      for (const host of ["127.0.0.1", "::1"]) {
        try {
          Bun.listen({ hostname: host, port, socket: { data() {} } }).stop(true)
        } catch (error) {
          // A machine without IPv6 refuses ::1 for a reason other than the port being taken.
          if (host === "127.0.0.1" || errorCode(error) === "EADDRINUSE") return false
        }
      }
      return true
    },
    open: async (target, cwd) => {
      const { opened, laptops } = await openPage(deps, values, target, [], cwd)
      return { url: opened.url, laptops }
    },
  }
}

function withDefaultDir(args: string[]): string[] {
  const options = Object.fromEntries(
    CLI_SURFACE.run.flags.map((flag) => [flag.name, { type: "string" as const }]),
  )
  const { positionals } = parseArgs({
    args,
    options: { ...options, json: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  })
  return positionals.length === 0 ? [...args, "."] : args
}

async function projectDir(path: string): Promise<string> {
  let real: string
  try {
    real = await realpath(path)
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`No such directory: ${path}`, { cause: ExitCode.notFound })
    }
    throw error
  }
  if (!(await stat(real)).isDirectory()) {
    throw new Error(`${path} is not a directory`, { cause: ExitCode.usage })
  }
  return real
}

async function readPackageJson(dir: string): Promise<unknown> {
  const file = Bun.file(join(dir, "package.json"))
  if (!(await file.exists())) return null
  try {
    return await file.json()
  } catch (error) {
    throw new Error(
      `Cannot parse ${join(dir, "package.json")}: ${error instanceof Error ? error.message : error}`,
    )
  }
}

/** A workspace keeps its lockfile at the root, so the nearest directory holding one decides. */
async function nearestLockfiles(dir: string): Promise<string[]> {
  for (let current = dir; ; current = dirname(current)) {
    const present = await Promise.all(
      LOCKFILES.map((name) => Bun.file(join(current, name)).exists()),
    )
    const found = LOCKFILES.filter((_, index) => present[index])
    if (found.length > 0 || dirname(current) === current) return found
  }
}

async function hasTopLevelHtml(dir: string): Promise<boolean> {
  return (await readdir(dir, { withFileTypes: true })).some(
    (entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".html"),
  )
}

async function freePort(start: number, portFree: RunSystem["portFree"]): Promise<number> {
  const size = RUN_PORTS.last - RUN_PORTS.first + 1
  for (let step = 0; step < size; step++) {
    const port = RUN_PORTS.first + ((start - RUN_PORTS.first + step) % size)
    if (await portFree(port)) return port
  }
  throw new Error(`No free port in ${RUN_PORTS.first}–${RUN_PORTS.last}`)
}

function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => clock.setTimeout(resolve, ms))
}

function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL" | 0): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

async function stopGroup(pgid: number, clock: Clock): Promise<void> {
  signalGroup(pgid, "SIGTERM")
  const killAt = clock.now() + STOP_GRACE_MS
  const giveUpAt = killAt + STOP_GRACE_MS
  let killed = false
  while (signalGroup(pgid, 0) && clock.now() < giveUpAt) {
    if (!killed && clock.now() >= killAt) {
      signalGroup(pgid, "SIGKILL")
      killed = true
    }
    await sleep(clock, POLL_MS)
  }
}

/**
 * What a run leaves under the state dir so that, if its CLI dies without cleaning up, the next
 * run of the same root can stop the orphaned dev server and take its port back.
 */
const RunRecord = z.object({
  root: z.string(),
  pgid: z.number().int().positive(),
  startedAt: z.string().min(1),
  cli: z.object({ pid: z.number().int().positive(), startedAt: z.string().nullable() }),
})
type RunRecord = z.infer<typeof RunRecord>

function recordPath(env: RunSystem["env"], root: string): string {
  const name = fnv1a(root).toString(16).padStart(8, "0")
  return join(resolvePaths(env).home, "run", `${name}.pid`)
}

async function readRecord(path: string): Promise<RunRecord | null> {
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
  try {
    return RunRecord.parse(JSON.parse(text))
  } catch {
    return null
  }
}

/**
 * Stops the dev server a dead run of this root left behind. Each check guards against signalling
 * a group that is not that orphan: a hash collision (root), a run still alive (cli), and a
 * reused pid (the leader's start time).
 */
async function reclaimOrphan(deps: CliDeps, clock: Clock, path: string, root: string) {
  const record = await readRecord(path)
  if (record === null || record.root !== root) return
  const { cli } = record
  if (cli.startedAt !== null && deps.processStart(cli.pid) === cli.startedAt) return
  if (deps.processStart(record.pgid) === record.startedAt) await stopGroup(record.pgid, clock)
  await rm(path, { force: true })
}

async function remember(deps: CliDeps, path: string, root: string, pgid: number): Promise<void> {
  const startedAt = deps.processStart(pgid)
  if (startedAt === null) return
  const record: RunRecord = {
    root,
    pgid,
    startedAt,
    cli: { pid: deps.pid, startedAt: deps.processStart(deps.pid) },
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

async function forget(path: string, pgid: number): Promise<void> {
  if ((await readRecord(path))?.pgid === pgid) await rm(path, { force: true })
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  write: (text: string) => void,
  tail: string[],
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  let partial = ""
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    write(text)
    const lines = (partial + text).split("\n")
    partial = lines.pop() ?? ""
    tail.push(...lines)
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES))
    for (const line of lines) onLine(line)
  }
  if (partial !== "") {
    tail.push(partial)
    tail.splice(0, Math.max(0, tail.length - TAIL_LINES))
    onLine(partial)
  }
}

async function place(
  deps: CliDeps,
  system: RunSystem,
  target: PageTarget,
  dir: string,
): Promise<void> {
  const { url, laptops } = await system.open(target, dir)
  deps.stdout(`${url}\n`)
  if (laptops.length > 0) {
    deps.stdout(`Opened on ${laptops.join(", ")}.\n`)
  } else if (system.env.SSH_CONNECTION || system.env.SSH_TTY) {
    deps.stdout(
      `You're on SSH and no laptop is connected. On your laptop run: iter8 setup ${system.hostname}\n`,
    )
  } else {
    const opener = system.platform === "darwin" ? "open" : "xdg-open"
    deps.stdout(
      system.launch([opener, url])
        ? "Opened in your browser.\n"
        : `Couldn't start ${opener}; open the URL above in your browser.\n`,
    )
  }
}

async function serve(
  deps: CliDeps,
  system: RunSystem,
  plan: Extract<RunPlan, { kind: "server" }>,
  dir: string,
  record: string,
): Promise<number> {
  const { clock } = system
  const { port } = plan
  deps.stdout(`Starting ${plan.argv.join(" ")} on port ${port}…\n`)
  const child = system.spawn(plan.argv, { cwd: dir, env: { ...system.env, ...plan.env } })
  const tail: string[] = []
  const printed: number[] = []
  const onLine = (line: string) => {
    for (const printedPort of printedPorts(line)) {
      if (printedPort !== port && !printed.includes(printedPort)) printed.push(printedPort)
    }
  }
  const pumped = Promise.all([
    pump(child.stdout, deps.stdout, tail, onLine),
    pump(child.stderr, deps.stderr, tail, onLine),
  ]).catch(() => {})
  const state: { exit: number | null; interrupt: Interrupt | null } = {
    exit: null,
    interrupt: null,
  }
  void child.exited.then((code) => {
    state.exit = code
  })
  let stopping: Promise<unknown> | null = null
  const stop = () => {
    stopping ??= stopGroup(child.pid, clock).then(() => child.exited)
    return stopping
  }
  system.onInterrupt((signal) => {
    state.interrupt ??= signal
    void stop()
  })

  const fail = async (line: string) => {
    await stop()
    await pumped
    deps.stderr([line, ...tail, ""].join("\n"))
    return ExitCode.failure
  }

  try {
    await remember(deps, record, dir, child.pid)
    const deadline = clock.now() + READY_TIMEOUT_MS
    let upstream: string | null = null
    while (upstream === null) {
      if (state.interrupt !== null) {
        await stop()
        return SIGNAL_EXIT[state.interrupt]
      }
      if (state.exit !== null) {
        return await fail(
          `The dev server exited with code ${state.exit} before answering on port ${port}.`,
        )
      }
      const urls = [port, ...printed].flatMap((candidate) => [
        `http://127.0.0.1:${candidate}/`,
        `http://[::1]:${candidate}/`,
      ])
      const answers = await Promise.all(urls.map((url) => system.probe(url)))
      upstream = urls[answers.indexOf(true)] ?? null
      if (upstream === null) {
        if (clock.now() >= deadline) {
          return await fail(`The dev server did not answer on port ${port} within 60 s.`)
        }
        await sleep(clock, POLL_MS)
      }
    }

    const answeredPort = Number(new URL(upstream).port)
    if (answeredPort !== port) {
      deps.stdout(
        `The dev server ignored port ${port} and is on ${answeredPort}, so this page's address changes between runs. Make it listen on ${port} with its --port flag or the $PORT variable.\n`,
      )
    }
    await place(deps, system, { kind: "server", upstream }, dir)
    const code = await child.exited
    await stop()
    await pumped
    return state.interrupt === null ? code : SIGNAL_EXIT[state.interrupt]
  } catch (error) {
    await stop()
    throw error
  } finally {
    await forget(record, child.pid)
  }
}

export const run = (deps: CliDeps, system?: RunSystem): CommandDef =>
  defineCommand({
    meta: { name: "run", description: CLI_SURFACE.run.summary },
    args: commandArgs("run"),
    run: ({ rawArgs }) => {
      const split = rawArgs.indexOf("--")
      const head = split === -1 ? rawArgs : rawArgs.slice(0, split)
      const command = split === -1 ? null : rawArgs.slice(split + 1)
      return runCli(deps, "run", withDefaultDir(head), async ({ values, positionals }) => {
        if (command?.length === 0) {
          throw new Error("Give the dev command after --", { cause: ExitCode.usage })
        }
        const flagPort = textFlag(values, "port")
        const requested = flagPort === undefined ? null : Number(flagPort)
        if (requested !== null && (requested < 1 || requested > 65_535)) {
          throw new Error("--port must be between 1 and 65535", { cause: ExitCode.usage })
        }
        const live = system ?? liveSystem(deps, values)
        const dir = await projectDir(resolve(deps.cwd, positionals[0] ?? "."))
        const record = recordPath(live.env, dir)
        await reclaimOrphan(deps, live.clock, record, dir)
        const [packageJson, lockfiles, hasHtml] = await Promise.all([
          readPackageJson(dir),
          nearestLockfiles(dir),
          hasTopLevelHtml(dir),
        ])
        const port = requested ?? (await freePort(stablePort(dir), live.portFree))
        const plan = planRun({ root: dir, packageJson, lockfiles, hasHtml, command, port })
        switch (plan.kind) {
          case "nothing":
            throw new Error(plan.reason)
          case "folder":
            await place(deps, live, { kind: "folder", root: plan.root, file: null }, dir)
            return ExitCode.ok
          case "server":
            if (requested !== null && !(await live.portFree(requested))) {
              throw new Error(`Port ${requested} is already in use`)
            }
            return serve(deps, live, plan, dir, record)
        }
      })
    },
  })
