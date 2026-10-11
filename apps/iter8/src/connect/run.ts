import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { ExitCode, ServiceStatus } from "@iter8/protocol"
import type { z } from "zod"
import { acceptablePage, laptopSocketName, listenForPages } from "./page-channel"
import { pickRoute, type Route, resolvedHostname } from "./route"
import {
  assertHost,
  classifyFailure,
  configArgs,
  remoteCommandArgs,
  type SshFailure,
  tunnelArgs,
} from "./ssh"
import { type Attempt, type AttemptEnd, type Clock, superviseTunnel } from "./supervisor"

export type Spawned = {
  exited: Promise<number>
  exitCode: number | null
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  kill(signal?: NodeJS.Signals): void
}

export type ConnectSystem = {
  spawn: (argv: string[]) => Spawned
  clock: Clock
  platform: "linux" | "darwin"
  laptopName: string
  home: string
  /** The laptop address the port forwards bind; null keeps ssh's own loopback default. */
  forwardAddress: string | null
  tailscale: () => string | null
  /** This laptop's own iter8 pool, to explain a port another local service already holds. */
  localPool: () => Promise<number[] | null>
  nonce: () => string
  out: (line: string) => void
  onInterrupt: (stop: () => void) => void
}

const READY_POLL_MS = 200
const READY_TIMEOUT_MS = 15_000 // ssh's ConnectTimeout is 10 s; the rest covers authentication.
const SERVICE_POLL_MS = 3_000

const RemoteStatus = ServiceStatus.pick({
  machineId: true,
  machineName: true,
  home: true,
  pool: true,
})
type RemoteStatus = z.infer<typeof RemoteStatus>

type Finished = { code: number; stdout: string; stderr: string }

async function finished(child: Spawned): Promise<Finished> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function accepts(hostname: string, port: number): Promise<void> {
  const socket = await Bun.connect({ hostname, port, socket: { data() {} } })
  socket.end()
}

function lostReason(failure: SshFailure, code: number): string {
  const detail = failure.kind === "transient" ? failure.detail.replace(/\.$/, "") : ""
  return detail === "" ? `ssh exited with code ${code}` : detail
}

function portRange(ports: readonly number[]): string {
  return `${ports[0]}–${ports.at(-1)}`
}

/** Keeps the devbox's pool forwarded to this laptop until interrupted; resolves the exit code. */
export async function runConnect(host: string, system: ConnectSystem): Promise<number> {
  assertHost(host)
  const { clock, out } = system
  const sshRefused = `SSH to ${host} needs a password or a host-key confirmation. Run ssh ${host} once, then retry.`

  await mkdir(system.home, { recursive: true, mode: 0o700 })
  const localSocket = join(system.home, `connect-${process.pid}.sock`)
  let expected: { machineId: string; ports: readonly number[] } | null = null
  const listener = await listenForPages({
    socketPath: localSocket,
    accept(message) {
      if (expected === null || !acceptablePage(message, expected)) return false
      const opener = system.platform === "darwin" ? "open" : "xdg-open"
      void finished(system.spawn([opener, message.url])).catch(() => {})
      return true
    },
  })

  const live = new Set<Spawned>()
  let socketForwardRefused = false
  let waitingForService = false
  let quietEnd = false
  let upLine = ""
  let previousTunnel: Spawned | undefined

  function attempt(): Attempt {
    let stopped = false
    let active: Spawned | undefined
    let markReady: () => void = () => {}
    let failReady: (error: Error) => void = () => {}
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      failReady = reject
    })
    const stoppedEnd: AttemptEnd = { retry: "backoff", reason: "stopped" }

    function start(argv: string[]): Spawned {
      const child = system.spawn(argv)
      active = child
      live.add(child)
      void child.exited.then(
        () => live.delete(child),
        () => live.delete(child),
      )
      return child
    }

    async function tailscaleStatus(): Promise<unknown> {
      const path = system.tailscale()
      if (path === null) return null
      try {
        const result = await finished(start([path, "status", "--json"]))
        return result.code === 0 ? parseJson(result.stdout) : null
      } catch {
        return null
      }
    }

    async function run(): Promise<AttemptEnd> {
      quietEnd = false
      const config = await finished(start(["ssh", ...configArgs(host)]))
      if (stopped) return stoppedEnd
      const route = pickRoute(host, resolvedHostname(config.stdout), await tailscaleStatus())
      if (stopped) return stoppedEnd
      if (!waitingForService) {
        out(
          route.kind === "tailscale"
            ? `Connecting to ${host} over Tailscale (${route.address})…`
            : `Connecting to ${host} over SSH…`,
        )
      }

      const remote = await finished(
        start(["ssh", ...remoteCommandArgs(host, route, ["iter8", "status", "--json"])]),
      )
      if (stopped) return stoppedEnd
      if (remote.code !== 0) {
        const failure = classifyFailure(remote.code, remote.stderr)
        if (failure.kind === "service-down") {
          if (!waitingForService) {
            out(
              `iter8 is not running on ${host} yet. It starts with the first Claude Code session or iter8 open there. Waiting.`,
            )
          }
          waitingForService = true
          quietEnd = true
          return { retry: "after", ms: SERVICE_POLL_MS, reason: `iter8 is not running on ${host}` }
        }
        waitingForService = false
        switch (failure.kind) {
          case "no-iter8":
            out(`iter8 was not found on ${host}'s PATH for non-interactive SSH.`)
            return { retry: "never", reason: "iter8 not found" }
          case "auth":
          case "host-key":
            out(sshRefused)
            return { retry: "never", reason: failure.kind }
          default:
            return { retry: "backoff", reason: lostReason(failure, remote.code) }
        }
      }
      waitingForService = false
      const parsed = RemoteStatus.safeParse(parseJson(remote.stdout))
      if (!parsed.success || parsed.data.pool.length === 0) {
        return { retry: "backoff", reason: `iter8 status on ${host} reported no usable pool` }
      }
      return tunnel(route, parsed.data)
    }

    async function tunnel(route: Route, status: RemoteStatus): Promise<AttemptEnd> {
      // ssh releases the forwarded ports only on exit; binding them again sooner fails as taken.
      await previousTunnel?.exited
      if (stopped) return stoppedEnd
      const remoteSocket = socketForwardRefused
        ? null
        : join(status.home, laptopSocketName(system.laptopName, system.nonce()))
      const child = start([
        "ssh",
        ...tunnelArgs(host, route, {
          ports: status.pool,
          bindAddress: system.forwardAddress,
          remoteSocket,
          localSocket,
        }),
      ])
      previousTunnel = child
      const page = { machineId: status.machineId, ports: status.pool }
      expected = page
      upLine = `Forwarding ${portRange(status.pool)} from ${host} (${status.machineName}).${
        remoteSocket === null ? "" : " Pages opened there open here."
      }`

      const result = finished(child)
      let alive = true
      void child.exited.then(() => {
        alive = false
      })
      let timedOut = false
      const address = system.forwardAddress ?? "127.0.0.1"
      const deadline = clock.now() + READY_TIMEOUT_MS
      void (async () => {
        for (;;) {
          const accepting = await Promise.all(
            status.pool.map((port) => accepts(address, port)),
          ).then(
            () => true,
            () => false,
          )
          if (!alive) throw new Error("ssh exited before its forwards accepted connections")
          if (accepting) return
          if (clock.now() >= deadline) {
            timedOut = true
            child.kill("SIGTERM")
            throw new Error("forwards did not accept connections in time")
          }
          await new Promise<void>((resolve) => clock.setTimeout(resolve, READY_POLL_MS))
        }
      })().then(markReady, failReady)

      const exit = await result
      if (expected === page) expected = null
      if (stopped) return stoppedEnd
      if (timedOut) {
        return {
          retry: "backoff",
          reason: `the forwarded ports did not accept connections within ${READY_TIMEOUT_MS / 1000} s`,
        }
      }
      const failure = classifyFailure(exit.code, exit.stderr)
      switch (failure.kind) {
        case "port-taken": {
          const pool = await system.localPool().catch(() => null)
          const own = pool?.includes(failure.port)
            ? ` This computer's own iter8 service holds it (pool ${portRange(pool)}); give one machine a different pool in its config.json.`
            : ""
          out(`Port ${failure.port} on this computer is taken.${own}`)
          return { retry: "backoff", reason: `port ${failure.port} is taken` }
        }
        case "socket-forward-refused":
          out(
            `${host}'s SSH server refuses socket forwarding, so pages opened there will not open here.`,
          )
          socketForwardRefused = true
          quietEnd = true
          return { retry: "after", ms: 0, reason: "socket forwarding refused" }
        case "auth":
        case "host-key":
          out(sshRefused)
          return { retry: "never", reason: failure.kind }
        default:
          return { retry: "backoff", reason: lostReason(failure, exit.code) }
      }
    }

    const ended = run().catch(
      (error: unknown): AttemptEnd => ({
        retry: "backoff",
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
    void ended.then(() => failReady(new Error("attempt ended")))
    return {
      ready,
      ended,
      stop() {
        stopped = true
        active?.kill("SIGTERM")
      },
    }
  }

  const supervisor = superviseTunnel({
    attempt,
    clock,
    report(event) {
      switch (event.kind) {
        case "up":
          out(upLine)
          break
        case "down":
          if (quietEnd) quietEnd = false
          else {
            out(
              `Lost ${host}: ${event.reason}. Reconnecting in ${Math.ceil(event.retryInMs / 1000)} s.`,
            )
          }
          break
        case "woke":
          out(`This computer woke from sleep. Reconnecting to ${host}.`)
          break
      }
    },
  })
  system.onInterrupt(() => {
    void supervisor.stop()
  })

  const end = await supervisor.finished
  await Promise.all([...live].map((child) => child.exited.catch(() => 0)))
  await listener.close()
  return end === null ? ExitCode.ok : ExitCode.failure
}
