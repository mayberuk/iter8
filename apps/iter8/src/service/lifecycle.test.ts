import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  CONFIG_FILE,
  DraftBody,
  ENV,
  ExitCode,
  LandingFragment,
  LIVE_PATH,
  liveSubprotocols,
  Note,
  OpenResult,
  OVERLAY_ROUTES,
  PairResult,
  RoundsResult,
  SendResult,
  ServerMessage,
  ServiceStatus,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Subprocess } from "bun"
import type { z } from "zod"
import { readProcessStart } from "../pairing/process-identity"

const REPO = resolve(import.meta.dir, "../../../..")
const MAIN = join(REPO, "apps/iter8/src/main.ts")
const LIFECYCLE = join(import.meta.dir, "lifecycle.ts")
const SWEEP_MS = 2_000
const IDLE_MS = 2_400
const IDLE_CHECK_MS = IDLE_MS / 4
const IDLE_WINDOW_MS = IDLE_MS + IDLE_CHECK_MS + 800

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

async function holds(label: string, ok: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms
  await until(
    label,
    () => {
      expect(ok(), label).toBe(true)
      return Date.now() > end
    },
    ms + 5_000,
  )
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

function freePool(size: number, avoid: number[] = []): { range: string; ports: number[] } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const first = 12_000 + Math.floor(Math.random() * 8_000)
    const ports = Array.from({ length: size }, (_, index) => first + index)
    if (ports.every((port) => bindable(port) && !avoid.includes(port))) {
      return { range: `${first}-${first + size - 1}`, ports }
    }
  }
  throw new Error("No free port range found")
}

// A service still booting has neither taken the lock nor logged, so cleanup finds it by the
// working directory the CLI starts every service in.
function servicesIn(root: string, home: string): number[] {
  const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,args="]).stdout.toString()
  return listing
    .split("\n")
    .filter((line) => line.endsWith(" serve") && (line.includes(MAIN) || line.includes(`${root}/`)))
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => {
      const fields = Bun.spawnSync(["lsof", "-w", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])
      return fields.stdout.toString().split("\n").includes(`n${home}`)
    })
}

type Home = {
  root: string
  home: string
  pool: { range: string; ports: number[] }
  env: Record<string, string>
}

async function makeHome(): Promise<Home> {
  const root = await realpath(await mkdtemp("/tmp/iter8-"))
  const home = join(root, "home")
  const pool = freePool(2)
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("ITER8_"),
  )
  const env = { ...Object.fromEntries(inherited), [ENV.home]: home, [ENV.pool]: pool.range }
  cleanups.push(async () => {
    const pids = servicesIn(root, home)
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    await until("every service to exit", () => pids.every((pid) => !alive(pid)), 10_000)
    await rm(root, { recursive: true, force: true })
  })
  return { root, home, pool, env }
}

function spawnChild(
  cmd: string[],
  env: Record<string, string>,
  cwd: string,
): Subprocess<"ignore", "pipe", "pipe"> {
  const child = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
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

function sleeper(home: Home) {
  return spawnChild(["sleep", "600"], home.env, home.root)
}

async function registerOwner(home: Home, pid: number) {
  const { pairing } = await cliJson(
    home,
    [
      "hook",
      "start",
      "--pid",
      String(pid),
      "--label",
      "alpha",
      "--source",
      "startup",
      "--agent",
      "stub",
    ],
    PairResult,
  )
  return pairing.owner
}

async function serviceStatus(home: Home, owner?: string) {
  return cliJson(home, ["status", ...(owner ? ["--owner", owner] : [])], ServiceStatus)
}

function startWait(home: Home, pid: number, timeoutSeconds = 60) {
  return spawnChild(
    [
      process.execPath,
      MAIN,
      "hook",
      "wait",
      "--pid",
      String(pid),
      "--timeout-seconds",
      String(timeoutSeconds),
    ],
    home.env,
    home.root,
  )
}

async function armedWaiter(home: Home, sessionPid: number, timeoutSeconds = 60) {
  const owner = await registerOwner(home, sessionPid)
  const wait = startWait(home, sessionPid, timeoutSeconds)
  await until(
    "the hook wait to arm",
    async () => (await serviceStatus(home, owner)).owner?.listener === "armed",
    10_000,
  )
  return { owner, wait }
}

async function exitCodeWithin(child: Subprocess, ms: number): Promise<number | string> {
  return Promise.race([child.exited, Bun.sleep(ms).then(() => "still running")])
}

function controlFetch(home: Home, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://iter8${path}`, { ...init, unix: join(home.home, "control.sock") })
}

type PageAccess = {
  token: ReturnType<typeof LandingFragment.parse>["t"]
  host: string
  origin: string
  port: number
}

function accessOf(open: OpenResult, port?: number): PageAccess {
  const { t: token } = LandingFragment.parse(
    Object.fromEntries(new URLSearchParams(new URL(open.landingUrl).hash.slice(1))),
  )
  const origin = new URL(open.page.origin)
  if (port !== undefined) origin.port = String(port)
  return { token, host: origin.host, origin: origin.origin, port: Number(origin.port) }
}

async function openPage(home: Home, name: string, owner?: string) {
  const site = join(home.root, name)
  await mkdir(site)
  await writeFile(join(site, "index.html"), `<!doctype html><title>${name}</title><p>hello</p>`)
  const open = await cliJson(
    home,
    ["open", site, ...(owner === undefined ? [] : ["--owner", owner])],
    OpenResult,
  )
  return { site, open, access: accessOf(open) }
}

async function sendRound(open: OpenResult, access: PageAccess, key: string) {
  const headers = {
    host: access.host,
    origin: access.origin,
    [TOKEN_HEADER]: access.token,
    "content-type": "application/json",
  }
  const draft = await fetch(`http://127.0.0.1:${access.port}${OVERLAY_ROUTES.createDraft.path}`, {
    method: OVERLAY_ROUTES.createDraft.method,
    headers,
    body: JSON.stringify(
      DraftBody.parse({
        intent: "fix",
        body: `tighten the heading ${key}`,
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
  const sent = await fetch(`http://127.0.0.1:${access.port}${OVERLAY_ROUTES.send.path}`, {
    method: OVERLAY_ROUTES.send.method,
    headers,
    body: JSON.stringify({
      idempotencyKey: `lifecycle-test-${key}`,
      noteIds: [note.id],
      generation: open.page.pairing?.generation,
    }),
  })
  const result = SendResult.parse(await sent.json())
  if (result.outcome !== "accepted") throw new Error(`Send refused: ${result.reason}`)
  return result.round
}

async function connectLive(access: PageAccess) {
  const messages: Array<{ at: number; message: ServerMessage }> = []
  // lib.dom's WebSocket type hides Bun's constructor option for request headers.
  const ws = new WebSocket(`ws://127.0.0.1:${access.port}${LIVE_PATH}`, {
    protocols: liveSubprotocols(access.token),
    headers: { host: access.host, origin: access.origin },
  } as unknown as string[])
  cleanups.push(() => ws.close())
  const closed = new Promise<{ code: number; reason: string }>((settle) => {
    ws.onclose = (event) => settle({ code: event.code, reason: event.reason })
  })
  ws.onmessage = (event) => {
    messages.push({ at: Date.now(), message: ServerMessage.parse(JSON.parse(String(event.data))) })
  }
  await new Promise((settle, fail) => {
    ws.onopen = settle
    ws.onerror = () => fail(new Error("live socket failed to open"))
  })
  return { ws, messages, closed }
}

type Live = Awaited<ReturnType<typeof connectLive>>

function firstAt(live: Live, matches: (message: ServerMessage) => boolean): number | undefined {
  return live.messages.find((entry) => matches(entry.message))?.at
}

async function startIdleService(home: Home, idleMs: number) {
  const entry = join(home.root, "idle-service.ts")
  await writeFile(
    entry,
    `import { runService } from ${JSON.stringify(LIFECYCLE)}
await runService({ env: process.env, embeddedOverlayDir: "/nonexistent", idleMs: ${idleMs}, exit: (code) => process.exit(code) })
`,
  )
  const service = spawnChild([process.execPath, entry], home.env, home.root)
  const ready = await until(
    "the idle-test service to be ready",
    async () => {
      const run = await cli(home, ["status", "--json"])
      return run.exitCode === 0 && ServiceStatus.parse(JSON.parse(run.stdout))
    },
    15_000,
  )
  expect(ready.pid).toBe(service.pid)
  return service
}

function stays(service: Subprocess, ms: number) {
  return holds(`the service to stay up for ${ms} ms`, () => service.exitCode === null, ms)
}

function expectStopped(home: Home) {
  expect(existsSync(join(home.home, "service.lock"))).toBe(false)
  expect(existsSync(join(home.home, "control.sock"))).toBe(false)
}

test("--version prints iter8 and the package.json version", async () => {
  const { version } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"))
  const home = await makeHome()
  const run = await cli(home, ["--version"])
  expect(run).toEqual({ exitCode: 0, stdout: `iter8 ${version}\n`, stderr: "" })
})

const blockers: Record<string, (home: Home) => Promise<() => Promise<unknown>>> = {
  "a live owner": async (home) => {
    const session = sleeper(home)
    const owner = await registerOwner(home, session.pid)
    expect((await serviceStatus(home, owner)).owner?.state.status).toBe("live")
    return async () => {
      session.kill("SIGKILL")
      await session.exited
    }
  },
  "a busy owner": async (home) => {
    const session = sleeper(home)
    const owner = await registerOwner(home, session.pid)
    const prompt = await cli(home, ["hook", "prompt", "--pid", String(session.pid)])
    expect(prompt.exitCode, prompt.stderr).toBe(0)
    expect((await serviceStatus(home, owner)).owner?.state.status).toBe("busy")
    return async () => {
      session.kill("SIGKILL")
      await session.exited
    }
  },
  "an owner whose process cannot be identified": async (home) => {
    const gone = Bun.spawn(["true"])
    await gone.exited
    const owner = await registerOwner(home, gone.pid)
    expect((await serviceStatus(home, owner)).owner?.state.status).toBe("unknown")
    return async () => {
      const end = await cli(home, [
        "hook",
        "end",
        "--pid",
        String(gone.pid),
        "--label",
        "alpha",
        "--reason",
        "logout",
      ])
      expect(end.exitCode, end.stderr).toBe(0)
    }
  },
  "an open live socket": async (home) => {
    const { access } = await openPage(home, "site")
    const live = await connectLive(access)
    return async () => live.ws.close()
  },
}

for (const [name, block] of Object.entries(blockers)) {
  test(`the service stays up while ${name} is present and exits once it is gone`, async () => {
    const home = await makeHome()
    const service = await startIdleService(home, IDLE_MS)
    const release = await block(home)
    await stays(service, IDLE_WINDOW_MS)

    await release()
    expect(await exitCodeWithin(service, 15_000)).toBe(0)
    expectStopped(home)
  }, 60_000)
}

for (const stage of ["announced", "queued"] as const) {
  test(`the service stays up until the sweep has orphaned the ${stage} round of an owner that just died`, async () => {
    const home = await makeHome()
    const idleMs = 600
    const service = await startIdleService(home, idleMs)
    const session = sleeper(home)
    const owner = await registerOwner(home, session.pid)
    const { open, access } = await openPage(home, "site", owner)
    const live = await connectLive(access)
    const roundStage = async (id: string) => {
      const response = await controlFetch(home, "/rounds", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identities: [], owner: null }),
      })
      const { rounds } = RoundsResult.parse(await response.json())
      return rounds.find((summary) => summary.id === id)?.stage
    }
    const busyPairings = () =>
      live.messages.filter(
        ({ message }) =>
          message.type === "pairing" &&
          message.pairing?.owner === owner &&
          message.pairing.state.status === "busy",
      ).length

    const early = stage === "announced" ? await sendRound(open, access, "stranded") : null
    const prompt = await cli(home, ["hook", "prompt", "--pid", String(session.pid)])
    expect(prompt.exitCode, prompt.stderr).toBe(0)
    await until("a sweep to report the busy owner", () => busyPairings() >= 2, SWEEP_MS + 3_000)
    const round = early ?? (await sendRound(open, access, "stranded"))
    expect(await roundStage(round.id)).toBe(stage)

    live.ws.close()
    session.kill("SIGKILL")
    await session.exited
    await until(
      "the sweep to orphan the round while the service stays up",
      async () => {
        expect(service.exitCode).toBeNull()
        return (await roundStage(round.id)) === "orphaned"
      },
      SWEEP_MS + 3_000,
    )
    expect(await exitCodeWithin(service, 15_000)).toBe(0)
    expectStopped(home)
  }, 60_000)
}

test("a restarted service orphans the queued and announced rounds of an owner stored as gone, then idles out", async () => {
  const home = await makeHome()
  const session = sleeper(home)
  const owner = await registerOwner(home, session.pid)
  const { open, access } = await openPage(home, "site", owner)
  const announced = await sendRound(open, access, "announced")
  const prompt = await cli(home, ["hook", "prompt", "--pid", String(session.pid)])
  expect(prompt.exitCode, prompt.stderr).toBe(0)
  const queued = await sendRound(open, access, "queued")
  const before = await cliJson(home, ["rounds"], RoundsResult)
  expect(before.rounds.map((summary) => summary.stage)).toEqual(["announced", "queued"])
  const { pid } = await serviceStatus(home)
  process.kill(pid, "SIGTERM")
  await until(
    "the first service to release its lock",
    () => !existsSync(join(home.home, "service.lock")),
    10_000,
  )
  session.kill("SIGKILL")
  await session.exited

  const db = new Database(join(home.home, "iter8.db"))
  db.run("UPDATE owners SET gone_reason = 'exited' WHERE id = ?", [owner])
  db.close()

  const service = await startIdleService(home, IDLE_MS)
  const { rounds } = await cliJson(home, ["rounds"], RoundsResult)
  expect(rounds.map((summary) => `${summary.id} ${summary.stage}`)).toEqual([
    `${announced.id} orphaned`,
    `${queued.id} orphaned`,
  ])
  expect(await exitCodeWithin(service, 15_000)).toBe(0)
  expectStopped(home)
}, 60_000)

test("a service nobody ever used exits cleanly, and not before the idle period has passed", async () => {
  const home = await makeHome()
  const idleMs = 3_000
  const startedAt = Date.now()
  const entry = join(home.root, "idle-service.ts")
  await writeFile(
    entry,
    `import { runService } from ${JSON.stringify(LIFECYCLE)}
await runService({ env: process.env, embeddedOverlayDir: "/nonexistent", idleMs: ${idleMs}, exit: (code) => process.exit(code) })
`,
  )
  const service = spawnChild([process.execPath, entry], home.env, home.root)
  const exitCode = await exitCodeWithin(service, 20_000)
  const elapsed = Date.now() - startedAt

  expect(exitCode).toBe(0)
  expect(elapsed).toBeGreaterThanOrEqual(idleMs)
  expectStopped(home)
}, 60_000)

test("activity restarts the idle period instead of letting an earlier idle stretch count", async () => {
  const home = await makeHome()
  const idleMs = 3_000
  const service = await startIdleService(home, idleMs)
  await stays(service, idleMs / 4 + 500)
  const session = sleeper(home)
  await registerOwner(home, session.pid)
  await stays(service, idleMs + 500)

  const killedAt = Date.now()
  session.kill("SIGKILL")
  await session.exited
  expect(await exitCodeWithin(service, 20_000)).toBe(0)
  expect(Date.now() - killedAt).toBeGreaterThanOrEqual(idleMs)
}, 60_000)

for (const trigger of ["POST /drain", "SIGTERM", "SIGINT"] as const) {
  test(`a drain by ${trigger} cancels every pending hook wait, each exiting 0 with nothing on stderr`, async () => {
    const home = await makeHome()
    const waits: Array<ReturnType<typeof startWait>> = []
    for (let index = 0; index < 3; index++) {
      waits.push((await armedWaiter(home, sleeper(home).pid)).wait)
    }
    const { pid } = await serviceStatus(home)

    if (trigger === "POST /drain") {
      const response = await controlFetch(home, "/drain", { method: "POST" })
      expect(response.status).toBe(202)
    } else process.kill(pid, trigger)

    for (const wait of waits) {
      expect(await finished(wait)).toEqual({ exitCode: 0, stdout: "", stderr: "" })
    }
    await until("the drained service to exit", () => !alive(pid), 10_000)
    expectStopped(home)
  }, 60_000)
}

test("a drain answers every one of many pending waits before the connections close", async () => {
  const home = await makeHome()
  const started = await cli(home, ["rounds", "--json"])
  expect(started.exitCode, started.stderr).toBe(0)
  const waits: Array<Promise<Response>> = []
  const owners: string[] = []
  for (let index = 0; index < 24; index++) {
    const session = sleeper(home)
    const startedAt = readProcessStart(session.pid)
    const registered = await controlFetch(home, "/hook/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pid: session.pid,
        startedAt,
        label: "alpha",
        source: "startup",
        agent: "stub",
        cwd: home.root,
      }),
    })
    expect(registered.status).toBe(200)
    owners.push(PairResult.parse(await registered.json()).pairing.owner)
    const query = new URLSearchParams({
      pid: String(session.pid),
      startedAt: startedAt ?? "",
      timeoutSeconds: "60",
    })
    waits.push(controlFetch(home, `/hook/wait?${query}`))
  }
  await until(
    "every wait to arm",
    async () => {
      const states = await Promise.all(
        owners.map(async (owner) => {
          const response = await controlFetch(home, "/status", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ identities: [], owner }),
          })
          return ServiceStatus.parse(await response.json()).owner?.listener
        }),
      )
      return states.every((listener) => listener === "armed")
    },
    15_000,
  )
  const { pid } = await serviceStatus(home)

  const drained = await controlFetch(home, "/drain", { method: "POST" })
  expect(drained.status).toBe(202)
  const answers = await Promise.all(
    waits.map(async (wait) => {
      const response = await wait
      return [response.status, await response.json()]
    }),
  )
  expect(answers).toEqual(owners.map(() => [200, { outcome: "cancelled" }]))
  await until("the drained service to exit", () => !alive(pid), 10_000)
}, 90_000)

test("a drain tells every page's live socket the service is restarting and closes it with 1012", async () => {
  const home = await makeHome()
  const first = await openPage(home, "first")
  const second = await openPage(home, "second")
  const sockets = [await connectLive(first.access), await connectLive(second.access)]
  const { pid } = await serviceStatus(home)

  const drained = await controlFetch(home, "/drain", { method: "POST" })
  expect(drained.status).toBe(202)

  for (const live of sockets) {
    expect(await live.closed).toEqual({ code: 1012, reason: "service restarting" })
    expect(live.messages.map((entry) => entry.message.type)).toContain("draining")
  }
  await until("the drained service to exit", () => !alive(pid), 10_000)
}, 60_000)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} received while the service is still starting drains it as soon as it is ready`, async () => {
    const home = await makeHome()
    await mkdir(home.home, { recursive: true })
    const config = join(home.home, CONFIG_FILE)
    expect(Bun.spawnSync(["mkfifo", config]).exitCode).toBe(0)
    const service = spawnChild([process.execPath, MAIN, "serve"], home.env, home.home)
    await until(
      "the starting service to take its lock",
      () => existsSync(join(home.home, "service.lock")),
      10_000,
    )
    expect(existsSync(join(home.home, "control.sock"))).toBe(false)

    service.kill(signal)
    spawnChild(
      ["sh", "-c", `printf '%s' '${JSON.stringify({ pool: home.pool.range })}' > ${config}`],
      home.env,
      home.root,
    )

    expect(await exitCodeWithin(service, 15_000)).toBe(0)
    expectStopped(home)
  }, 60_000)
}

test("a pending hook wait exits 5 when the service dies, and no service is started in its place", async () => {
  const home = await makeHome()
  const session = sleeper(home)
  const { wait } = await armedWaiter(home, session.pid, 20)
  const { pid } = await serviceStatus(home)
  const log = join(home.home, "service.log")

  process.kill(pid, "SIGKILL")
  const result = await finished(wait)
  expect(result.exitCode).toBe(5)
  expect(result.stderr).not.toBe("")

  const logged = await readFile(log, "utf8")
  await holds(
    "no replacement service to appear",
    () =>
      servicesIn(home.root, home.home).length === 0 &&
      JSON.parse(readFileSync(join(home.home, "service.lock"), "utf8")).pid === pid,
    2_500,
  )
  expect(await readFile(log, "utf8")).toBe(logged)
  const status = await cli(home, ["status", "--json"])
  expect(status.exitCode).toBe(5)
}, 60_000)

test("an owner's death updates every one of its pages and orphans every one of its rounds within two sweeps, leaving another owner alone", async () => {
  const home = await makeHome()
  const dying = sleeper(home)
  const staying = sleeper(home)
  const dyingOwner = await registerOwner(home, dying.pid)
  const stayingOwner = await registerOwner(home, staying.pid)
  const pageA = await openPage(home, "a", dyingOwner)
  const pageB = await openPage(home, "b", dyingOwner)
  const pageC = await openPage(home, "c", stayingOwner)
  const liveA = await connectLive(pageA.access)
  const liveB = await connectLive(pageB.access)
  const liveC = await connectLive(pageC.access)
  const dyingRounds = [
    await sendRound(pageA.open, pageA.access, "a1"),
    await sendRound(pageA.open, pageA.access, "a2"),
    await sendRound(pageB.open, pageB.access, "b1"),
  ]
  const stayingRound = await sendRound(pageC.open, pageC.access, "c1")
  const prompt = await cli(home, ["hook", "prompt", "--pid", String(staying.pid)])
  expect(prompt.exitCode, prompt.stderr).toBe(0)

  const killedAt = Date.now()
  dying.kill("SIGKILL")
  await dying.exited
  const goneFor = (owner: string) => (message: ServerMessage) =>
    message.type === "pairing" &&
    message.pairing?.owner === owner &&
    message.pairing.state.status === "gone"
  const orphaned = (id: string) => (message: ServerMessage) =>
    message.type === "round" && message.round.id === id && message.round.state.stage === "orphaned"
  const expectations: Array<[Live, (message: ServerMessage) => boolean]> = [
    [liveA, goneFor(dyingOwner)],
    [liveB, goneFor(dyingOwner)],
    [liveA, orphaned(dyingRounds[0]?.id ?? "")],
    [liveA, orphaned(dyingRounds[1]?.id ?? "")],
    [liveB, orphaned(dyingRounds[2]?.id ?? "")],
  ]
  await until(
    "every page of the dead owner to hear about it",
    () => expectations.every(([live, matches]) => firstAt(live, matches) !== undefined),
    2 * SWEEP_MS + 2_000,
  )
  for (const [live, matches] of expectations) {
    expect((firstAt(live, matches) ?? Infinity) - killedAt).toBeLessThanOrEqual(2 * SWEEP_MS)
  }

  const { rounds } = await cliJson(home, ["rounds"], RoundsResult)
  expect(rounds.map((round) => `${round.id} ${round.stage}`)).toEqual([
    ...dyingRounds.map((round) => `${round.id} orphaned`),
    `${stayingRound.id} announced`,
  ])
  const stayingHeard = liveC.messages.filter(
    ({ message }) =>
      goneFor(stayingOwner)(message) ||
      (message.type === "round" && message.round.state.stage === "orphaned"),
  )
  expect(stayingHeard).toEqual([])
}, 60_000)

test("status lists only the pool ports the service actually bound", async () => {
  const home = await makeHome()
  const pool = freePool(3)
  const occupied = pool.ports[1] ?? 0
  const holder = Bun.listen({ hostname: "127.0.0.1", port: occupied, socket: { data() {} } })
  cleanups.push(() => holder.stop(true))
  const crowded: Home = { ...home, pool, env: { ...home.env, [ENV.pool]: pool.range } }

  const started = await cli(crowded, ["rounds", "--json"])
  expect(started.exitCode, started.stderr).toBe(0)
  const status = await serviceStatus(crowded)
  expect(status.pool).toEqual(pool.ports.filter((port) => port !== occupied))
  expect(status.pool).not.toContain(occupied)
}, 60_000)

test("a restarted service rebinds its pages to the new pool, proxies them and watches their folders again", async () => {
  const home = await makeHome()
  const session = sleeper(home)
  const owner = await registerOwner(home, session.pid)
  const { site, open } = await openPage(home, "site", owner)
  const first = await serviceStatus(home)
  process.kill(first.pid, "SIGTERM")
  await until(
    "the first service to release its lock",
    () => !existsSync(join(home.home, "service.lock")),
    10_000,
  )

  const moved = freePool(2, home.pool.ports)
  const restarted: Home = { ...home, env: { ...home.env, [ENV.pool]: moved.range } }
  const started = await cli(restarted, ["rounds", "--json"])
  expect(started.exitCode, started.stderr).toBe(0)
  expect((await serviceStatus(restarted)).pool).toEqual(moved.ports)

  const access = accessOf(open, moved.ports[0])
  const page = await fetch(`http://127.0.0.1:${access.port}/`, { headers: { host: access.host } })
  expect(page.status).toBe(200)
  expect(await page.text()).toContain("<p>hello</p>")

  const live = await connectLive(access)
  await writeFile(join(site, "index.html"), "<!doctype html><title>site</title><p>changed</p>")
  await until(
    "a reload after the folder changed",
    () => live.messages.some((entry) => entry.message.type === "reload"),
    10_000,
  )
}, 60_000)

test("the compiled executable reports its own version and build and starts itself as the service", async () => {
  const { version } = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"))
  const home = await makeHome()
  const binary = join(home.root, "iter8")
  const compile = await finished(
    spawnChild([process.execPath, "build", "--compile", "--outfile", binary, MAIN], home.env, REPO),
  )
  expect(compile.exitCode, compile.stderr).toBe(0)

  const printed = await finished(spawnChild([binary, "--version"], home.env, home.root))
  expect(printed).toEqual({ exitCode: 0, stdout: `iter8 ${version}\n`, stderr: "" })

  const started = await finished(spawnChild([binary, "rounds", "--json"], home.env, home.root))
  expect(started.exitCode, started.stderr).toBe(0)
  const reported = await finished(spawnChild([binary, "status", "--json"], home.env, home.root))
  const status = ServiceStatus.parse(JSON.parse(reported.stdout))
  expect(status).toMatchObject({ state: "ready", version, build: "compiled" })
  const args = Bun.spawnSync(["ps", "-o", "args=", "-p", String(status.pid)]).stdout.toString()
  expect(args.trim()).toBe(`${binary} serve`)
}, 120_000)

test("an unknown command exits 64 with one line on stderr and nothing on stdout", async () => {
  const home = await makeHome()
  const run = await cli(home, ["frobnicate"])
  expect(run.exitCode).toBe(ExitCode.usage)
  expect(run.stdout).toBe("")
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
  expect(run.stderr).toContain("frobnicate")
})

test("a known command given a bad argument exits 64 with one line on stderr", async () => {
  const home = await makeHome()
  const run = await cli(home, ["rounds", "--bogus"])
  expect(run.exitCode).toBe(ExitCode.usage)
  expect(run.stdout).toBe("")
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
})

test("a service that cannot start exits 1 with one line on stderr and leaves no lock behind", async () => {
  const home = await makeHome()
  await mkdir(home.home, { recursive: true })
  await writeFile(join(home.home, "iter8.db"), "this is not a database file")
  const run = await finished(spawnChild([process.execPath, MAIN, "serve"], home.env, home.home))

  expect(run.exitCode).toBe(ExitCode.failure)
  expect(run.stdout).toBe("")
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
  expect(existsSync(join(home.home, "service.lock"))).toBe(false)
})
