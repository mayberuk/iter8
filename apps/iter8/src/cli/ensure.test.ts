import { afterEach, expect, setSystemTime, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  DraftBody,
  ENV,
  LandingFragment,
  Note,
  OpenResult,
  OVERLAY_ROUTES,
  PairResult,
  PROTOCOL_VERSION,
  RoundsResult,
  SendResult,
  ServiceStatus,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Subprocess } from "bun"
import type { z } from "zod"
import { resolvePaths } from "../home"
import { readProcessStart } from "../pairing/process-identity"
import { BUILD, liveLockHolder, VERSION } from "../service/lifecycle"
import { LATEST_MIGRATION_VERSION } from "../store/db"
import { ensureService } from "./ensure"

const REPO = resolve(import.meta.dir, "../../../..")
const MAIN = join(REPO, "apps/iter8/src/main.ts")
const PROCESS_IDENTITY = join(REPO, "apps/iter8/src/pairing/process-identity.ts")

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function until<T>(
  label: string,
  read: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await Bun.sleep(25)
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

function bindable(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

function freePool(size: number): { range: string; ports: number[] } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const first = 12_000 + Math.floor(Math.random() * 8_000)
    const ports = Array.from({ length: size }, (_, index) => first + index)
    if (ports.every(bindable)) return { range: `${first}-${first + size - 1}`, ports }
  }
  throw new Error("No free port range found")
}

// A service still booting has neither taken the lock nor logged, so cleanup finds it by the
// working directory the CLI starts every service in.
function servicesIn(home: string): number[] {
  const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="]).stdout.toString()
  return listing
    .split("\n")
    .filter((line) => line.includes(`${MAIN} serve`))
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => {
      const fields = Bun.spawnSync(["lsof", "-w", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      return fields.stdout.toString().split("\n").includes(`n${home}`)
    })
}

type Home = { root: string; home: string; ports: number[]; env: Record<string, string> }

async function makeHome(): Promise<Home> {
  const root = await realpath(await mkdtemp("/tmp/iter8-"))
  const home = join(root, "home")
  const pool = freePool(2)
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("ITER8_"),
  )
  const env = { ...Object.fromEntries(inherited), [ENV.home]: home, [ENV.pool]: pool.range }
  cleanups.push(async () => {
    const pids = servicesIn(home)
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    await until("every service to exit", () => pids.every((pid) => !alive(pid)), 10_000)
    await rm(root, { recursive: true, force: true })
  })
  return { root, home, ports: pool.ports, env }
}

function spawnChild(
  cmd: string[],
  env: Record<string, string>,
  cwd: string,
  options: { detached?: boolean } = {},
): Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: options.detached ?? false,
  })
  cleanups.push(async () => {
    child.kill("SIGKILL")
    await child.exited
  })
  return child
}

async function finished(child: Subprocess<"ignore", "pipe", "pipe">) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function cli(home: Home, args: string[]) {
  return finished(spawnChild([process.execPath, MAIN, ...args], home.env, home.root))
}

async function cliJson<S extends z.ZodType>(
  home: Home,
  args: string[],
  schema: S,
): Promise<z.output<S>> {
  const run = await cli(home, [...args, "--json"])
  if (run.exitCode !== 0) throw new Error(`${args.join(" ")} exited ${run.exitCode}: ${run.stderr}`)
  return schema.parse(JSON.parse(run.stdout))
}

function processGroup(pid: number): number {
  const result = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)])
  if (result.exitCode !== 0) throw new Error(`ps found no process ${pid}`)
  return Number(result.stdout.toString().trim())
}

async function sendRound(open: OpenResult, body: string) {
  const { t: token } = LandingFragment.parse(
    Object.fromEntries(new URLSearchParams(new URL(open.landingUrl).hash.slice(1))),
  )
  const { host, port } = new URL(open.page.origin)
  const headers = {
    host,
    origin: open.page.origin,
    [TOKEN_HEADER]: token,
    "content-type": "application/json",
  }
  const draft = await fetch(`http://127.0.0.1:${port}${OVERLAY_ROUTES.createDraft.path}`, {
    method: OVERLAY_ROUTES.createDraft.method,
    headers,
    body: JSON.stringify(
      DraftBody.parse({
        intent: "fix",
        body,
        target: {
          kind: "region",
          box: { x: 0, y: 10, width: 200, height: 40 },
          viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
        },
        anchorStatus: "anchored",
      }),
    ),
  })
  expect(draft.status).toBe(201)
  const note = Note.parse(await draft.json())
  const sent = await fetch(`http://127.0.0.1:${port}${OVERLAY_ROUTES.send.path}`, {
    method: OVERLAY_ROUTES.send.method,
    headers,
    body: JSON.stringify({
      idempotencyKey: `ensure-test-${note.id}`,
      noteIds: [note.id],
      generation: open.page.pairing?.generation,
    }),
  })
  const result = SendResult.parse(await sent.json())
  if (result.outcome !== "accepted") throw new Error(`Send refused: ${result.reason}`)
  return result.round
}

test("two commands started at once with no service end with one service that both use", async () => {
  const home = await makeHome()
  const runs = await Promise.all([cli(home, ["rounds", "--json"]), cli(home, ["rounds", "--json"])])
  for (const run of runs) {
    expect(run.exitCode, run.stderr).toBe(0)
    expect(RoundsResult.parse(JSON.parse(run.stdout))).toEqual({ rounds: [] })
  }

  const status = await cliJson(home, ["status"], ServiceStatus)
  expect(status.state).toBe("ready")
  expect(status.pool).toEqual(home.ports)
  expect(liveLockHolder(join(home.home, "service.lock"))?.pid).toBe(status.pid)

  const lines = (await readFile(join(home.home, "service.log"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; msg: string })
  const ready = new Set(lines.filter((line) => line.msg === "ready").map((line) => line.pid))
  expect([...ready]).toEqual([status.pid])
  const others = new Set(lines.map((line) => line.pid).filter((pid) => pid !== status.pid))
  for (const pid of others) {
    expect(lines.filter((line) => line.pid === pid).map((line) => line.msg)).toEqual([
      "already running",
    ])
    expect(alive(pid)).toBe(false)
  }
}, 60_000)

test("the started service has its own process group and outlives its starter's group", async () => {
  const home = await makeHome()
  const starter = spawnChild([process.execPath, MAIN, "rounds", "--json"], home.env, home.root, {
    detached: true,
  })
  expect((await finished(starter)).exitCode).toBe(0)

  const { pid } = await cliJson(home, ["status"], ServiceStatus)
  expect(processGroup(pid)).toBe(pid)
  expect(processGroup(pid)).not.toBe(starter.pid)
  expect(processGroup(pid)).not.toBe(processGroup(process.pid))

  try {
    process.kill(-starter.pid, "SIGKILL")
  } catch {}
  const after = await cliJson(home, ["status"], ServiceStatus)
  expect(after).toMatchObject({ state: "ready", pid })
}, 60_000)

for (const field of ["version", "protocolVersion", "schemaVersion", "build"] as const) {
  test(`a service differing only in ${field} is drained and replaced, keeping its pages and rounds`, async () => {
    const home = await makeHome()
    const site = join(home.root, "site")
    await mkdir(site)
    await writeFile(join(site, "index.html"), "<!doctype html><title>site</title><p>hello</p>")
    const session = spawnChild(["sleep", "600"], home.env, home.root)
    const { pairing } = await cliJson(
      home,
      ["hook", "start", "--pid", String(session.pid), "--label", "alpha", "--source", "startup"],
      PairResult,
    )
    const opened = await cliJson(home, ["open", site, "--owner", pairing.owner], OpenResult)
    const round = await sendRound(opened, "keep me across the restart")
    const real = await cliJson(home, ["status"], ServiceStatus)
    process.kill(real.pid, "SIGTERM")
    await until(
      "the first service to release its lock",
      () => !existsSync(join(home.home, "service.lock")),
      10_000,
    )

    const scripts = join(home.root, "scripts")
    await mkdir(scripts)
    const fakeEntry = join(scripts, "old-service.ts")
    const differing = {
      version: "0.0.0-old",
      protocolVersion: real.protocolVersion + 1,
      schemaVersion: real.schemaVersion + 1,
      build: real.build === "source" ? "compiled" : "source",
    }[field]
    const oldStatus = ServiceStatus.parse({ ...real, [field]: differing, pid: 1, owner: null })
    await writeFile(
      fakeEntry,
      `import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { readProcessStart } from ${JSON.stringify(PROCESS_IDENTITY)}
const home = process.env.${ENV.home}
const lock = join(home, "service.lock")
const socket = join(home, "control.sock")
writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: readProcessStart(process.pid) }))
const status = ${JSON.stringify(oldStatus)}
const server = Bun.serve({
  unix: socket,
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/status") return Response.json({ ...status, pid: process.pid })
    if (pathname !== "/drain") return new Response(null, { status: 404 })
    setTimeout(async () => {
      await server.stop(true)
      unlinkSync(lock)
      process.exit(0)
    }, 0)
    return new Response(null, { status: 202 })
  },
})
`,
    )
    const fake = spawnChild([process.execPath, fakeEntry], home.env, home.root)
    const seenOld = await until(
      "status to report the old service",
      async () => {
        const run = await cli(home, ["status", "--json"])
        return run.exitCode === 0 && ServiceStatus.parse(JSON.parse(run.stdout))
      },
      10_000,
    )
    expect(seenOld).toMatchObject({ [field]: differing, pid: fake.pid })

    const reopened = await cliJson(home, ["open", site], OpenResult)
    const fakeRun = await finished(fake)
    expect(fakeRun.exitCode, fakeRun.stderr).toBe(0)
    expect(reopened.page.id).toBe(opened.page.id)
    const replaced = await cliJson(home, ["status"], ServiceStatus)
    expect(replaced[field]).toBe(real[field])
    expect(replaced.pid).not.toBe(fake.pid)
    const { rounds } = await cliJson(home, ["rounds"], RoundsResult)
    expect(rounds.map((summary) => summary.id)).toEqual([round.id])
  }, 60_000)
}

for (const holder of ["a dead pid", "a live pid with another start time"] as const) {
  test(`a lock naming ${holder} is taken over`, async () => {
    const home = await makeHome()
    await mkdir(home.home, { recursive: true })
    let stale: { pid: number; startedAt: string }
    if (holder === "a dead pid") {
      const gone = Bun.spawn(["true"])
      await gone.exited
      stale = { pid: gone.pid, startedAt: "linux:0:0" }
    } else {
      stale = { pid: process.pid, startedAt: `${readProcessStart(process.pid)}-other` }
    }
    await writeFile(join(home.home, "service.lock"), JSON.stringify(stale))

    const run = await cli(home, ["rounds", "--json"])
    expect(run.exitCode, run.stderr).toBe(0)
    const status = await cliJson(home, ["status"], ServiceStatus)
    expect(status.state).toBe("ready")
    expect(status.pid).not.toBe(stale.pid)
    expect(liveLockHolder(join(home.home, "service.lock"))?.pid).toBe(status.pid)
  }, 60_000)
}

test("status starts no service when none is running", async () => {
  const home = await makeHome()
  const run = await cli(home, ["status", "--json"])
  expect(run.exitCode).toBe(5)
  expect(run.stdout).toBe("")
  expect(existsSync(join(home.home, "service.lock"))).toBe(false)
}, 60_000)

function currentStatus(home: Home) {
  return ServiceStatus.parse({
    state: "ready",
    version: VERSION,
    build: BUILD,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: LATEST_MIGRATION_VERSION,
    machineId: "fake-machine",
    machineName: "fake",
    pid: 1,
    home: home.home,
    pool: home.ports,
    overlay: "missing",
    owner: null,
  })
}

async function writeFakeService(
  home: Home,
  name: string,
  options: { status: ServiceStatus; bindAfterMs: number; onDrain: string },
): Promise<string> {
  const scripts = join(home.root, "scripts")
  await mkdir(scripts, { recursive: true })
  const entry = join(scripts, name)
  await writeFile(
    entry,
    `import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { readProcessStart } from ${JSON.stringify(PROCESS_IDENTITY)}
const home = process.env.${ENV.home}
writeFileSync(join(home, "service.lock"), JSON.stringify({ pid: process.pid, startedAt: readProcessStart(process.pid) }))
const status = ${JSON.stringify(options.status)}
await Bun.sleep(${options.bindAfterMs})
Bun.serve({
  unix: join(home, "control.sock"),
  fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === "/status") return Response.json({ ...status, pid: process.pid })
    if (pathname === "/drain") {
      ${options.onDrain}
      return new Response(null, { status: 202 })
    }
    return Response.json({ rounds: [] })
  },
})
`,
  )
  return entry
}

test("a command that finds a live lock and no socket waits for that service and starts none", async () => {
  const home = await makeHome()
  await mkdir(home.home, { recursive: true })
  const entry = await writeFakeService(home, "slow-service.ts", {
    status: currentStatus(home),
    bindAfterMs: 1500,
    onDrain: "",
  })
  const fake = spawnChild([process.execPath, entry], home.env, home.root)
  const lock = join(home.home, "service.lock")
  await until("the slow service to take the lock", () => existsSync(lock), 10_000)
  expect(existsSync(join(home.home, "control.sock"))).toBe(false)

  const run = await cli(home, ["rounds", "--json"])
  expect(run.exitCode, run.stderr).toBe(0)
  expect(RoundsResult.parse(JSON.parse(run.stdout))).toEqual({ rounds: [] })
  expect(liveLockHolder(lock)?.pid).toBe(fake.pid)
  expect(existsSync(join(home.home, "service.log"))).toBe(false)
}, 60_000)

test("an old service that keeps its lock fails the command after 10 s, naming the cause", async () => {
  const home = await makeHome()
  await mkdir(home.home, { recursive: true })
  const marker = join(home.root, "drain-requested")
  const entry = await writeFakeService(home, "stubborn-service.ts", {
    status: { ...currentStatus(home), version: "0.0.0-old" },
    bindAfterMs: 0,
    onDrain: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
  })
  const fake = spawnChild([process.execPath, entry], home.env, home.root)
  await until(
    "the stubborn service to take the lock",
    () => liveLockHolder(join(home.home, "service.lock")),
    10_000,
  )
  const spawn = (() => {
    throw new Error("an old service must be drained, not replaced by a spawn")
  }) as unknown as typeof Bun.spawn
  cleanups.push(() => setSystemTime())

  const outcome = ensureService(
    resolvePaths(home.env),
    { spawn, env: home.env, command: [process.execPath, MAIN] },
    { start: true },
  ).then(
    () => null,
    (error: unknown) => error,
  )
  await until("the old service to be asked to drain", () => existsSync(marker), 10_000)
  setSystemTime(new Date(Date.now() + 11_000))
  const error = await Promise.race([outcome, Bun.sleep(5_000).then(() => "still waiting")])
  setSystemTime()

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    "The running iter8 service is another version and did not stop within 10 s",
  )
  expect(fake.exitCode).toBeNull()
}, 60_000)

test("a service that never becomes ready fails the command after 30 s, naming the log", async () => {
  const home = await makeHome()
  const paths = resolvePaths(home.env)
  const calls: Array<{ command: string[]; options: Record<string, unknown> }> = []
  const spawn = ((command: string[], options: Record<string, unknown>) => {
    calls.push({ command, options })
    return { unref() {} }
  }) as unknown as typeof Bun.spawn
  cleanups.push(() => setSystemTime())
  const command = [process.execPath, MAIN]

  const outcome = ensureService(paths, { spawn, env: home.env, command }, { start: true }).then(
    () => null,
    (error: unknown) => error,
  )
  await until("the service to be spawned", () => calls.length > 0, 10_000)
  const observeUntil = Date.now() + 600
  await until(
    "six polls with no second spawn",
    () => {
      expect(calls).toHaveLength(1)
      return Date.now() > observeUntil
    },
    5_000,
  )
  setSystemTime(new Date(Date.now() + 31_000))
  const error = await Promise.race([outcome, Bun.sleep(5_000).then(() => "still waiting")])
  setSystemTime()

  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(
    `The iter8 service did not become ready within 30 s; see ${paths.log}`,
  )
  expect(calls).toHaveLength(1)
  expect(calls[0]?.command).toEqual([...command, "serve"])
  expect(calls[0]?.options).toMatchObject({
    cwd: paths.home,
    env: home.env,
    detached: true,
    stdio: ["ignore", expect.any(Number), expect.any(Number)],
  })
}, 60_000)
