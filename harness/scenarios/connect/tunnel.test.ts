import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ENV } from "@iter8/protocol"
import { type ConnectSystem, runConnect, type Spawned } from "../../../apps/iter8/src/connect/run"
import { cliCommand } from "../../rig/cli"
import { throwawayHome } from "../../rig/home"
import { poolRange } from "../../rig/ports"
import { reapWithParent } from "../../rig/reap"
import { type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { FAKE_SSH_ENTRY } from "./fake-ssh"
import { FAKE_TAILSCALE_ENTRY } from "./fake-tailscale"

const HOST = "devbox"
const LAPTOP = "studio-laptop"
const FORWARD_ADDRESS = "127.0.0.2"
const SERVICE_ADDRESS = "127.0.0.1"
const TAILSCALE = "tailscale"
const TAILNET_ADDRESS = "100.101.102.103"
const CONNECT_MS = 20_000
// The supervisor's backoff caps at 30 s, so a reconnect can take that long plus the attempt.
const RECONNECT_MS = 45_000
const STOP_MS = 15_000
const TEST_MS = 110_000

function bindFailure(): string | null {
  try {
    Bun.listen({ hostname: FORWARD_ADDRESS, port: 0, socket: { data() {} } }).stop(true)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const unbindable = bindFailure()
if (unbindable !== null) {
  console.info(
    `skipping the connect tunnel scenarios: ${FORWARD_ADDRESS} cannot be bound (${unbindable}); they need Linux's whole 127/8 loopback`,
  )
}

type Cleanup = () => Promise<unknown>
type Remote = { home: string; pool: string; command: string[] }

async function teardown(steps: Cleanup[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

const portsOf = (pool: string) => {
  const [first = 0, last = -1] = pool.split("-").map(Number)
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

const forwardingLine = (pool: string, machineName: string) => {
  const ports = portsOf(pool)
  return `Forwarding ${ports[0]}–${ports.at(-1)} from ${HOST} (${machineName}). Pages opened there open here.`
}

const inheritedEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith("ITER8_") &&
        !entry[0].startsWith("FAKE_") &&
        entry[0] !== "CLAUDE_CODE_SESSION_ID",
    ),
  )

function exitedAlready(code: number): Spawned {
  const empty = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  return {
    exited: Promise.resolve(code),
    exitCode: code,
    stdout: empty(),
    stderr: empty(),
    kill() {},
  }
}

async function startDevbox(
  cleanups: Cleanup[],
): Promise<{ service: RunningService; remote: Remote }> {
  const pool = await poolRange(2)
  const service = await startService({ env: { [ENV.pool]: pool } })
  cleanups.push(() => service.stop())
  return { service, remote: { home: service.home, pool, command: cliCommand() } }
}

async function startLaptop(
  cleanups: Cleanup[],
  remote: () => Remote,
  vars: Record<string, string> = {},
) {
  const home = await throwawayHome()
  cleanups.push(home.dispose)
  const scratch = await throwawayHome()
  cleanups.push(scratch.dispose)
  const sshLog = join(scratch.path, "ssh.jsonl")
  const downMarker = join(scratch.path, "down")
  const lines: string[] = []
  const opened: string[] = []
  let offsetMs = 0
  let interrupt: (() => void) | null = null
  let stopRequested = false

  const system: ConnectSystem = {
    spawn(argv) {
      const [program, ...rest] = argv
      if (program === "xdg-open" || program === "open") {
        opened.push(rest[0] ?? "")
        return exitedAlready(0)
      }
      const entry =
        program === "ssh" ? FAKE_SSH_ENTRY : program === TAILSCALE ? FAKE_TAILSCALE_ENTRY : null
      if (entry === null)
        throw new Error(`connect spawned an unexpected program: ${argv.join(" ")}`)
      const target = remote()
      const child = Bun.spawn([process.execPath, entry, ...rest], {
        env: {
          ...inheritedEnv(),
          FAKE_SSH_LOG: sshLog,
          FAKE_SSH_DOWN: downMarker,
          FAKE_SSH_ITER8: JSON.stringify(target.command),
          FAKE_SSH_REMOTE_ENV: JSON.stringify({ [ENV.home]: target.home, [ENV.pool]: target.pool }),
          ...vars,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      reapWithParent(child)
      return child
    },
    clock: {
      now: () => Date.now() + offsetMs,
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    platform: "linux",
    laptopName: LAPTOP,
    home: home.path,
    forwardAddress: FORWARD_ADDRESS,
    tailscale: () => TAILSCALE,
    localPool: async () => null,
    nonce: () => randomBytes(4).toString("hex"),
    out: (line) => lines.push(line),
    onInterrupt(stop) {
      interrupt = stop
      if (stopRequested) stop()
    },
  }

  let exit: { code: number } | { error: unknown } | null = null
  const running = runConnect(HOST, system).then(
    (code) => {
      exit = { code }
    },
    (error: unknown) => {
      exit = { error }
    },
  )
  const stop = async () => {
    stopRequested = true
    interrupt?.()
    await waitFor("connect to stop", async () => exit, { timeoutMs: STOP_MS })
    await running
  }
  cleanups.push(stop)

  const lineAfter = (from: number, wanted: string | RegExp, timeoutMs: number): Promise<number> =>
    waitFor(
      `connect to print ${wanted}${from > 0 ? ` after line ${from}` : ""}`,
      async () => {
        if (exit !== null)
          throw new Error(`connect ended early: ${Bun.inspect(exit)}\n${lines.join("\n")}`)
        const index = lines.findIndex(
          (line, at) =>
            at >= from && (typeof wanted === "string" ? line === wanted : wanted.test(line)),
        )
        return index === -1 ? null : index
      },
      { timeoutMs },
    )

  const tunnels = async (): Promise<string[][]> => {
    const log = Bun.file(sshLog)
    if (!(await log.exists())) return []
    return (await log.text())
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      .filter((argv) => argv.includes("-N"))
  }

  return {
    lines,
    opened,
    lineAfter,
    tunnels,
    linkDown: () => writeFile(downMarker, ""),
    linkUp: () => rm(downMarker),
    sleep(ms: number) {
      offsetMs += ms
    },
  }
}

async function reachesService(port: number): Promise<void> {
  const host = `connect-probe.localhost:${port}`
  const read = async (address: string) => {
    const response = await fetch(`http://${address}:${port}/`, {
      headers: { host },
      redirect: "manual",
    })
    return { status: response.status, body: await response.text() }
  }
  const forwarded = await read(FORWARD_ADDRESS)
  expect(forwarded.body).toContain(`No iter8 page is open at ${host}`)
  expect(forwarded).toEqual(await read(SERVICE_ADDRESS))
}

test.skipIf(unbindable !== null)(
  "connect forwards every pool port over plain SSH and names the devbox it reached",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const { service, remote } = await startDevbox(cleanups)
      const laptop = await startLaptop(cleanups, () => remote)

      await laptop.lineAfter(0, forwardingLine(remote.pool, service.status.machineName), CONNECT_MS)
      expect(laptop.lines[0]).toBe(`Connecting to ${HOST} over SSH…`)
      for (const port of portsOf(remote.pool)) await reachesService(port)

      const tunnels = await laptop.tunnels()
      expect(tunnels).toHaveLength(1)
      expect(tunnels[0]?.some((arg) => arg.startsWith("HostName="))).toBe(false)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "a dropped link is reported and the tunnel comes back on its own once the link returns",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const { service, remote } = await startDevbox(cleanups)
      const laptop = await startLaptop(cleanups, () => remote)
      const forwarding = forwardingLine(remote.pool, service.status.machineName)
      const up = await laptop.lineAfter(0, forwarding, CONNECT_MS)

      await laptop.linkDown()
      const lost = await laptop.lineAfter(
        up + 1,
        new RegExp(`^Lost ${HOST}: .+\\. Reconnecting in \\d+ s\\.$`),
        CONNECT_MS,
      )
      expect(laptop.lines[lost]).toEndWith("Reconnecting in 1 s.")

      await laptop.linkUp()
      await laptop.lineAfter(lost + 1, forwarding, RECONNECT_MS)
      expect(await laptop.tunnels()).toHaveLength(2)
      for (const port of portsOf(remote.pool)) await reachesService(port)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "a wall-clock jump reads as waking from sleep and reconnects at once, without a backoff wait",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const { service, remote } = await startDevbox(cleanups)
      const laptop = await startLaptop(cleanups, () => remote)
      const forwarding = forwardingLine(remote.pool, service.status.machineName)
      const up = await laptop.lineAfter(0, forwarding, CONNECT_MS)

      laptop.sleep(120_000)
      const woke = await laptop.lineAfter(
        up + 1,
        `This computer woke from sleep. Reconnecting to ${HOST}.`,
        CONNECT_MS,
      )
      const back = await laptop.lineAfter(woke + 1, forwarding, CONNECT_MS)

      expect(laptop.lines.slice(woke + 1, back).filter((line) => line.startsWith("Lost "))).toEqual(
        [],
      )
      const tunnels = await laptop.tunnels()
      expect(tunnels).toHaveLength(2)
      const localForwards = (argv: string[] = []) =>
        argv.flatMap((arg, at) => (argv[at - 1] === "-L" ? [arg] : []))
      expect(localForwards(tunnels[1])).toEqual(localForwards(tunnels[0]))
      for (const port of portsOf(remote.pool)) await reachesService(port)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "with the devbox an online tailnet peer, ssh keeps the alias and goes to its Tailscale address",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const { service, remote } = await startDevbox(cleanups)
      const tailnet = await throwawayHome()
      cleanups.push(tailnet.dispose)
      const statusFile = join(tailnet.path, "tailscale-status.json")
      await writeFile(
        statusFile,
        JSON.stringify({
          BackendState: "Running",
          Peer: {
            "nodekey:devbox": {
              HostName: HOST,
              DNSName: `${HOST}.tail1234.ts.net.`,
              TailscaleIPs: [TAILNET_ADDRESS, "fd7a:115c:a1e0::1"],
              Online: true,
            },
          },
        }),
      )
      const laptop = await startLaptop(cleanups, () => remote, {
        FAKE_TAILSCALE_STATUS: statusFile,
      })

      await laptop.lineAfter(0, forwardingLine(remote.pool, service.status.machineName), CONNECT_MS)
      expect(laptop.lines[0]).toBe(`Connecting to ${HOST} over Tailscale (${TAILNET_ADDRESS})…`)
      const [tunnel = []] = await laptop.tunnels()
      const named = tunnel.indexOf(`HostName=${TAILNET_ADDRESS}`)
      expect(named).toBeGreaterThan(0)
      expect(tunnel[named - 1]).toBe("-o")
      expect(tunnel.slice(tunnel.indexOf("--") + 1)).toEqual([HOST])
      for (const port of portsOf(remote.pool)) await reachesService(port)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "a laptop port that is already taken is named, and the tunnel comes up once it is free",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const { service, remote } = await startDevbox(cleanups)
      const [taken = 0] = portsOf(remote.pool)
      const blocker = Bun.listen({ hostname: FORWARD_ADDRESS, port: taken, socket: { data() {} } })
      let blocking = true
      cleanups.push(async () => {
        if (blocking) blocker.stop(true)
      })
      const laptop = await startLaptop(cleanups, () => remote)

      const named = await laptop.lineAfter(
        0,
        `Port ${taken} on this computer is taken.`,
        CONNECT_MS,
      )
      blocking = false
      blocker.stop(true)

      await laptop.lineAfter(
        named + 1,
        forwardingLine(remote.pool, service.status.machineName),
        RECONNECT_MS,
      )
      for (const port of portsOf(remote.pool)) await reachesService(port)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "connect started before the devbox service says it is waiting, then forwards once the service runs",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const idle = await throwawayHome()
      cleanups.push(idle.dispose)
      let remote: Remote = { home: idle.path, pool: await poolRange(2), command: cliCommand() }
      const laptop = await startLaptop(cleanups, () => remote)

      const waiting = await laptop.lineAfter(
        0,
        `iter8 is not running on ${HOST} yet. It starts with the first Claude Code session or iter8 open there. Waiting.`,
        CONNECT_MS,
      )
      expect(await laptop.tunnels()).toEqual([])

      const devbox = await startDevbox(cleanups)
      remote = devbox.remote
      await laptop.lineAfter(
        waiting + 1,
        forwardingLine(remote.pool, devbox.service.status.machineName),
        CONNECT_MS,
      )
      expect(laptop.lines.filter((line) => line.startsWith("Lost "))).toEqual([])
      for (const port of portsOf(remote.pool)) await reachesService(port)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)
