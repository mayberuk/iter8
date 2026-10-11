import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ConnectSystem, runConnect, type Spawned } from "./run"
import type { Clock } from "./supervisor"

type TimerHandle = ReturnType<typeof setTimeout>

class FakeClock implements Clock {
  private time = 0
  private nextHandle = 0
  private timers = new Map<TimerHandle, { at: number; run: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(run: () => void, ms: number): TimerHandle {
    const handle = ++this.nextHandle as unknown as TimerHandle
    this.timers.set(handle, { at: this.time + ms, run })
    return handle
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle)
  }

  get pending(): number {
    return this.timers.size
  }

  async advance(ms: number, asleep = false): Promise<void> {
    const target = this.time + ms
    if (asleep) this.time = target
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      const [handle, timer] = next
      this.time = Math.max(this.time, timer.at)
      this.timers.delete(handle)
      timer.run()
      await Promise.resolve()
    }
    this.time = target
    await Promise.resolve()
  }
}

class FakeChild implements Spawned {
  exitCode: number | null = null
  exitOnKill = true
  readonly kills: (NodeJS.Signals | undefined)[] = []
  readonly exited: Promise<number>
  readonly stdout: ReadableStream<Uint8Array>
  readonly stderr: ReadableStream<Uint8Array>
  readonly onExit: (() => void)[] = []
  private resolveExit: (code: number) => void = () => {}
  private streams: ReadableStreamDefaultController<Uint8Array>[] = []

  constructor(readonly argv: string[]) {
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve
    })
    this.stdout = new ReadableStream({ start: (controller) => void this.streams.push(controller) })
    this.stderr = new ReadableStream({ start: (controller) => void this.streams.push(controller) })
  }

  exit(code: number, output: { stdout?: string; stderr?: string } = {}): void {
    if (this.exitCode !== null) return
    const [stdout, stderr] = this.streams
    stdout?.enqueue(new TextEncoder().encode(output.stdout ?? ""))
    stderr?.enqueue(new TextEncoder().encode(output.stderr ?? ""))
    for (const stream of this.streams) stream.close()
    this.exitCode = code
    for (const run of this.onExit) run()
    this.resolveExit(code)
  }

  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal)
    if (this.exitOnKill) this.exit(143)
  }
}

const HOST = "devbox"
const TAILSCALE = "/usr/bin/tailscale"
const DEVBOX_HOME = "/home/biruk/.iter8"
const MACHINE_ID = "devbox-machine"
const SSH_OPTIONS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ControlPath=none",
]
const CONNECTING = `Connecting to ${HOST} over SSH…`
const SSH_REFUSED = `SSH to ${HOST} needs a password or a host-key confirmation. Run ssh ${HOST} once, then retry.`

type ChildOutput = { code: number; stdout?: string; stderr?: string }

type Script = {
  poolSize?: number
  configHangs?: boolean
  platform?: "linux" | "darwin"
  forwardAddress?: string | null
  tailscale?: string
  tailscaleStatus?: unknown
  localPool?: (ports: number[]) => number[] | null
  status?: (call: number) => ChildOutput | undefined
  tunnel?: (child: FakeChild, call: number) => boolean
}

async function freePorts(count: number): Promise<number[]> {
  const listeners = Array.from({ length: count }, () =>
    Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }),
  )
  const ports = listeners.map((listener) => listener.port)
  for (const listener of listeners) listener.stop(true)
  return ports
}

async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await Bun.sleep(2)
  }
}

const teardowns: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown()
})

async function setup(script: Script = {}) {
  const root = await mkdtemp(join(tmpdir(), "i8-connect-"))
  const home = join(root, "iter8")
  const ports = await freePorts(script.poolSize ?? 2)
  const first = ports[0] as number
  const last = ports.at(-1) as number
  const clock = new FakeClock()
  const lines: string[] = []
  const spawns: FakeChild[] = []
  const accepted = new Map<number, number>()
  const listeners = new Set<Bun.TCPSocketListener>()
  let interrupt: (() => void) | undefined
  let interrupted = false
  let nonces = 0
  const statusJson = JSON.stringify({
    state: "ready",
    version: "0.1.0",
    build: "devbox-build",
    protocolVersion: 2,
    schemaVersion: 3,
    machineId: MACHINE_ID,
    machineName: "devbox-name",
    pid: 4242,
    home: DEVBOX_HOME,
    pool: ports,
    overlay: "present",
    owner: null,
    addedByNewerBuild: true,
  })

  function bind(child: FakeChild, port: number): void {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          accepted.set(port, (accepted.get(port) ?? 0) + 1)
          socket.end()
        },
        data() {},
      },
    })
    listeners.add(listener)
    child.onExit.push(() => {
      listener.stop(true)
      listeners.delete(listener)
    })
  }

  const count = (match: (child: FakeChild) => boolean) => spawns.filter(match).length
  const isConfig = (child: FakeChild) => child.argv[1] === "-G"
  const isStatus = (child: FakeChild) => child.argv[0] === "ssh" && child.argv.at(-1) === "--json"
  const isTunnel = (child: FakeChild) => child.argv[1] === "-N"
  const isOpener = (child: FakeChild) => ["open", "xdg-open"].includes(child.argv[0] ?? "")

  const system: ConnectSystem = {
    spawn(argv) {
      const child = new FakeChild(argv)
      spawns.push(child)
      if (isConfig(child)) {
        if (script.configHangs) return child
        child.exit(0, { stdout: `host ${HOST}\nhostname devbox.corp.example\nuser biruk\n` })
      } else if (argv[0] === TAILSCALE) {
        if (script.tailscaleStatus === undefined) child.exit(1)
        else child.exit(0, { stdout: JSON.stringify(script.tailscaleStatus) })
      } else if (isStatus(child)) {
        const result = script.status?.(count(isStatus)) ?? { code: 0, stdout: statusJson }
        child.exit(result.code, result)
      } else if (isTunnel(child)) {
        if (!script.tunnel?.(child, count(isTunnel))) for (const port of ports) bind(child, port)
      } else if (isOpener(child)) {
        child.exit(0)
      }
      return child
    },
    clock,
    platform: script.platform ?? "linux",
    laptopName: "Biruk's Mac",
    home,
    forwardAddress: script.forwardAddress ?? null,
    tailscale: () => script.tailscale ?? null,
    localPool: async () => script.localPool?.(ports) ?? null,
    nonce: () => (++nonces).toString(16).padStart(8, "0"),
    out: (line) => lines.push(line),
    onInterrupt(stop) {
      interrupt = stop
      if (interrupted) stop()
    },
  }

  let exitCode: number | undefined
  const run = runConnect(HOST, system).then((code) => {
    exitCode = code
    return code
  })
  function requestInterrupt(): void {
    interrupted = true
    interrupt?.()
  }
  teardowns.push(async () => {
    requestInterrupt()
    await run.catch(() => {})
    for (const listener of listeners) listener.stop(true)
    await rm(root, { recursive: true, force: true })
  })

  return {
    home,
    first,
    last,
    ports,
    clock,
    lines,
    spawns,
    accepted,
    run,
    bind,
    socket: join(home, `connect-${process.pid}.sock`),
    forwarding: `Forwarding ${first}–${last} from ${HOST} (devbox-name). Pages opened there open here.`,
    exitCode: () => exitCode,
    interrupt: requestInterrupt,
    configs: () => spawns.filter(isConfig),
    statuses: () => spawns.filter(isStatus),
    tunnels: () => spawns.filter(isTunnel),
    openers: () => spawns.filter(isOpener).map((child) => child.argv),
    forwards: (bindAddress = "") =>
      ports.flatMap((port) => ["-L", `${bindAddress}${port}:127.0.0.1:${port}`]),
    tunnel(index: number): FakeChild {
      const child = spawns.filter(isTunnel)[index]
      if (!child) throw new Error(`no tunnel ${index}`)
      return child
    },
  }
}

type Rig = Awaited<ReturnType<typeof setup>>

function announce(rig: Rig, machineId: string, url: string): Promise<Response> {
  return fetch("http://iter8/open", {
    unix: rig.socket,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId, url }),
    signal: AbortSignal.timeout(1_000),
  })
}

async function forwarded(rig: Rig, times = 1): Promise<void> {
  await until(
    () => rig.lines.filter((line) => line.startsWith("Forwarding")).length >= times,
    "the Forwarding line",
  )
}

test("a host that could become an ssh option is a usage error before anything starts", async () => {
  for (const host of ["", "-oProxyCommand=sh", "dev box", "dev\u0007box"]) {
    await expect(runConnect(host, {} as ConnectSystem)).rejects.toHaveProperty("cause", 64)
  }
})

test("the plain route keeps the user's ssh config and forwards every pool port with the page socket", async () => {
  const rig = await setup()
  await forwarded(rig)
  expect(rig.spawns.map((child) => child.argv)).toEqual([
    ["ssh", "-G", "--", HOST],
    ["ssh", ...SSH_OPTIONS, "--", HOST, "iter8", "status", "--json"],
    [
      "ssh",
      "-N",
      ...SSH_OPTIONS,
      ...rig.forwards(),
      "-R",
      `${DEVBOX_HOME}/laptop-biruk-s-mac-00000001.sock:${rig.socket}`,
      "--",
      HOST,
    ],
  ])
  expect(rig.lines).toEqual([CONNECTING, rig.forwarding])
})

test("every port of a pool of one, three or five is forwarded and probed", async () => {
  for (const poolSize of [1, 3, 5]) {
    const rig = await setup({ poolSize })
    await forwarded(rig)
    expect(rig.tunnel(0).argv.filter((arg) => arg.includes(":127.0.0.1:"))).toEqual(
      rig.ports.map((port) => `${port}:127.0.0.1:${port}`),
    )
    expect(rig.ports.filter((port) => !rig.accepted.has(port))).toEqual([])
    expect(rig.lines).toEqual([CONNECTING, rig.forwarding])
  }
})

test("an online Tailscale peer routes to its IPv4 address through HostName on every remote ssh", async () => {
  const rig = await setup({
    tailscale: TAILSCALE,
    forwardAddress: "127.0.0.1",
    tailscaleStatus: {
      BackendState: "Running",
      Peer: {
        nodekey: {
          HostName: "devbox",
          DNSName: "devbox.tail1234.ts.net.",
          TailscaleIPs: ["fd7a:115c:a1e0::7", "100.64.0.7"],
          Online: true,
        },
      },
    },
  })
  await forwarded(rig)
  const hostName = ["-o", "HostName=100.64.0.7"]
  expect(rig.spawns.map((child) => child.argv)).toEqual([
    ["ssh", "-G", "--", HOST],
    [TAILSCALE, "status", "--json"],
    ["ssh", ...SSH_OPTIONS, ...hostName, "--", HOST, "iter8", "status", "--json"],
    [
      "ssh",
      "-N",
      ...SSH_OPTIONS,
      ...hostName,
      ...rig.forwards("127.0.0.1:"),
      "-R",
      `${DEVBOX_HOME}/laptop-biruk-s-mac-00000001.sock:${rig.socket}`,
      "--",
      HOST,
    ],
  ])
  expect(rig.lines).toEqual([`Connecting to ${HOST} over Tailscale (100.64.0.7)…`, rig.forwarding])
})

test("Forwarding is printed only once every forwarded port accepts a connection", async () => {
  let tunnel: FakeChild | undefined
  const rig = await setup({
    tunnel(child) {
      tunnel = child
      rig.bind(child, rig.first)
      return true
    },
  })
  await until(() => (rig.accepted.get(rig.first) ?? 0) >= 1, "the first readiness probe")
  await until(() => rig.clock.pending === 2, "the next readiness poll")
  expect(rig.lines).toEqual([CONNECTING])

  await rig.clock.advance(200)
  await until(() => (rig.accepted.get(rig.first) ?? 0) >= 2, "the second readiness probe")
  await until(() => rig.clock.pending === 2, "the third readiness poll")
  expect(rig.lines).toEqual([CONNECTING])

  if (!tunnel) throw new Error("no tunnel spawned")
  rig.bind(tunnel, rig.last)
  await rig.clock.advance(200)
  await forwarded(rig)
  expect(rig.lines).toEqual([CONNECTING, rig.forwarding])
})

test("a page announced for a forwarded port of the expected machine opens in the laptop's browser", async () => {
  for (const [platform, opener] of [
    ["linux", "xdg-open"],
    ["darwin", "open"],
  ] as const) {
    const rig = await setup({ platform })
    await forwarded(rig)
    const url = `http://larkspur.localhost:${rig.first}/notes`

    expect((await announce(rig, "another-machine", url)).status).toBe(403)
    expect((await announce(rig, MACHINE_ID, "http://larkspur.localhost:1/")).status).toBe(403)
    expect(rig.openers()).toEqual([])

    expect((await announce(rig, MACHINE_ID, url)).status).toBe(204)
    expect(rig.openers()).toEqual([[opener, url]])
  }
})

test("an ssh exit with 255 is reported and reconnects after 1 s", async () => {
  const rig = await setup()
  await forwarded(rig)
  rig.tunnel(0).exit(255, { stderr: `Connection to ${HOST} closed by remote host.\n` })
  const lost = `Lost ${HOST}: Connection to ${HOST} closed by remote host. Reconnecting in 1 s.`
  await until(() => rig.lines.includes(lost), "the Lost line")

  await rig.clock.advance(999)
  expect(rig.configs()).toHaveLength(1)
  await rig.clock.advance(1)
  expect(rig.configs()).toHaveLength(2)
  await forwarded(rig, 2)
  expect(rig.lines).toEqual([CONNECTING, rig.forwarding, lost, CONNECTING, rig.forwarding])
})

test("a wake from sleep kills the tunnel and reconnects at once, once the old ssh has let go of the ports", async () => {
  const rig = await setup({
    tunnel(child, call) {
      child.exitOnKill = call > 1
      return false
    },
  })
  await forwarded(rig)
  await rig.clock.advance(12_001, true)
  expect(rig.lines).toContain(`This computer woke from sleep. Reconnecting to ${HOST}.`)
  expect(rig.tunnel(0).kills).toEqual(["SIGTERM"])
  expect(rig.configs()).toHaveLength(2)

  await until(() => rig.statuses().length === 2, "the second status check")
  expect(rig.tunnels()).toHaveLength(1)
  rig.tunnel(0).exit(143)
  await forwarded(rig, 2)
  expect(rig.lines).toEqual([
    CONNECTING,
    rig.forwarding,
    `This computer woke from sleep. Reconnecting to ${HOST}.`,
    CONNECTING,
    rig.forwarding,
  ])
  expect(rig.tunnels()).toHaveLength(2)
})

test("a taken laptop port is named, and blamed on this laptop's own iter8 only when its pool holds it", async () => {
  for (const pool of ["own", "other", "none"] as const) {
    const rig: Rig = await setup({
      localPool: (ports) => (pool === "own" ? ports : pool === "other" ? [1, 2] : null),
      tunnel(child) {
        child.exit(255, {
          stderr: `bind [127.0.0.1]:${rig.first}: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: ${rig.first}\nCould not request local forwarding.\n`,
        })
        return true
      },
    })
    const lost = `Lost ${HOST}: port ${rig.first} is taken. Reconnecting in 1 s.`
    await until(() => rig.lines.includes(lost), "the Lost line")
    const suffix =
      pool === "own"
        ? ` This computer's own iter8 service holds it (pool ${rig.first}–${rig.last}); give one machine a different pool in its config.json.`
        : ""
    expect(rig.lines).toEqual([
      CONNECTING,
      `Port ${rig.first} on this computer is taken.${suffix}`,
      lost,
    ])
  }
})

test("service-down says so once and checks again every 3 s", async () => {
  const notRunning = `iter8 is not running on ${HOST} yet. It starts with the first Claude Code session or iter8 open there. Waiting.`
  const rig = await setup({
    status: (call) => (call <= 2 ? { code: 5 } : undefined),
  })
  await until(() => rig.clock.pending === 2, "the first service retry")
  expect(rig.lines).toEqual([CONNECTING, notRunning])

  await rig.clock.advance(2_999)
  expect(rig.configs()).toHaveLength(1)
  await rig.clock.advance(1)
  expect(rig.configs()).toHaveLength(2)
  await until(() => rig.statuses().length === 2, "the second status check")
  await until(() => rig.clock.pending === 2, "the second service retry")
  expect(rig.lines).toEqual([CONNECTING, notRunning])
  expect(rig.tunnels()).toHaveLength(0)

  await rig.clock.advance(2_999)
  expect(rig.configs()).toHaveLength(2)
  await rig.clock.advance(1)
  expect(rig.configs()).toHaveLength(3)
  await forwarded(rig)
  expect(rig.statuses()).toHaveLength(3)
  expect(rig.lines).toEqual([CONNECTING, notRunning, rig.forwarding])
})

test("authentication, host-key and missing-iter8 failures print their fix and exit 1 without retrying", async () => {
  const cases: [Script, string][] = [
    [
      { status: () => ({ code: 255, stderr: "biruk@devbox: Permission denied (publickey).\n" }) },
      SSH_REFUSED,
    ],
    [
      { status: () => ({ code: 127, stderr: "bash: line 1: iter8: command not found\n" }) },
      `iter8 was not found on ${HOST}'s PATH for non-interactive SSH.`,
    ],
    [
      {
        tunnel(child) {
          child.exit(255, { stderr: "Host key verification failed.\n" })
          return true
        },
      },
      SSH_REFUSED,
    ],
  ]
  for (const [script, line] of cases) {
    const rig = await setup(script)
    expect(await rig.run).toBe(1)
    expect(rig.lines).toEqual([CONNECTING, line])
    expect(existsSync(rig.socket)).toBe(false)
    await rig.clock.advance(60_000)
    expect(rig.configs()).toHaveLength(1)
  }
})

test("a refused socket forward retries at once without -R and keeps the port forwards", async () => {
  const rig = await setup({
    tunnel(child, call) {
      if (call > 1) return false
      child.exit(255, {
        stderr: `Error: remote port forwarding failed for listen path ${DEVBOX_HOME}/laptop-biruk-s-mac-00000001.sock\n`,
      })
      return true
    },
  })
  const refused = `${HOST}'s SSH server refuses socket forwarding, so pages opened there will not open here.`
  await until(() => rig.lines.includes(refused), "the refused line")
  await until(() => rig.clock.pending === 2, "the immediate retry")
  await rig.clock.advance(0)
  await forwarded(rig)

  expect(rig.tunnel(1).argv).toEqual(["ssh", "-N", ...SSH_OPTIONS, ...rig.forwards(), "--", HOST])
  expect(rig.lines).toEqual([
    CONNECTING,
    refused,
    CONNECTING,
    `Forwarding ${rig.first}–${rig.last} from ${HOST} (devbox-name).`,
  ])
})

test("forwards that never accept within 15 s kill ssh and back off", async () => {
  const rig = await setup({ tunnel: () => true })
  await until(() => rig.tunnels().length === 1, "the tunnel")
  const killed = () => rig.tunnel(0).kills.length > 0
  while (rig.clock.now() < 20_000) {
    await until(() => killed() || rig.clock.pending === 2, "the next readiness poll")
    if (killed()) break
    await rig.clock.advance(200)
  }
  expect(rig.clock.now()).toBe(15_000)
  expect(rig.tunnel(0).kills).toEqual(["SIGTERM"])
  const lost = `Lost ${HOST}: the forwarded ports did not accept connections within 15 s. Reconnecting in 1 s.`
  await until(() => rig.lines.includes(lost), "the Lost line")
  expect(rig.lines).toEqual([CONNECTING, lost])
})

test("an interrupt kills ssh, removes the local socket and exits 0", async () => {
  const rig = await setup()
  await forwarded(rig)
  expect((await stat(rig.home)).mode & 0o777).toBe(0o700)
  expect(existsSync(rig.socket)).toBe(true)

  rig.interrupt()
  expect(await rig.run).toBe(0)
  expect(rig.tunnel(0).kills).toEqual(["SIGTERM"])
  expect(existsSync(rig.socket)).toBe(false)
  expect(rig.exitCode()).toBe(0)
})

test("an interrupt in the middle of an attempt stops its ssh and starts no further one", async () => {
  const rig = await setup({ configHangs: true })
  await until(() => rig.configs().length === 1, "the ssh -G child")
  rig.interrupt()
  expect(await rig.run).toBe(0)
  expect(rig.configs()[0]?.kills).toEqual(["SIGTERM"])
  expect(rig.spawns).toHaveLength(1)
  expect(rig.lines).toEqual([])
})
