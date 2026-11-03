import { expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, rm, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import { ENV } from "@iter8/protocol"
import type { Page } from "playwright"
import { type ConnectSystem, runConnect, type Spawned } from "../../../apps/iter8/src/connect/run"
import { BUILD_OUTPUTS } from "../../../scripts/build"
import { launchChromium, newPage } from "../../rig/browser"
import { runCli } from "../../rig/cli"
import { fixtureDir } from "../../rig/fixtures"
import { throwawayHome } from "../../rig/home"
import { poolRange } from "../../rig/ports"
import { reapWithParent } from "../../rig/reap"
import { type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { FAKE_SSH_ENTRY } from "./fake-ssh"

const REPO = join(import.meta.dir, "..", "..", "..")
const HOST = "devhost"
const LAPTOP = "studio-laptop"
const FORWARD_ADDRESS = "127.0.0.2"
const CONNECT_MS = 20_000
// The supervisor's backoff caps at 30 s, so a reconnect can take that long plus the attempt.
const RECONNECT_MS = 45_000
const UI_TIMEOUT_MS = 10_000
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
    `skipping the connect page scenarios: ${FORWARD_ADDRESS} cannot be bound (${unbindable}); they need Linux's whole 127/8 loopback`,
  )
}

type Cleanup = () => Promise<unknown>

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

const forwardingLine = (pool: string, machineName: string, pages: boolean) => {
  const ports = portsOf(pool)
  return `Forwarding ${ports[0]}–${ports.at(-1)} from ${HOST} (${machineName}).${
    pages ? " Pages opened there open here." : ""
  }`
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

async function startDevhost(
  cleanups: Cleanup[],
): Promise<{ service: RunningService; pool: string }> {
  const override = process.env.ITER8_TEST_BINARY
  const binary =
    override !== undefined && override !== "" ? override : join(REPO, BUILD_OUTPUTS.bin)
  if (!(await Bun.file(binary).exists())) {
    throw new Error(`built binary missing at ${binary} — run bun run build`)
  }
  const pool = await poolRange(2)
  const service = await startService({ binary, env: { [ENV.pool]: pool } })
  cleanups.push(() => service.stop())
  if (service.status.overlay !== "present") {
    throw new Error(`the built binary at ${binary} reports no embedded overlay — run bun run build`)
  }
  return { service, pool }
}

async function startBrowser(cleanups: Cleanup[]): Promise<Page> {
  const browser = await launchChromium({
    args: [`--host-resolver-rules=MAP *.localhost ${FORWARD_ADDRESS}`],
  })
  cleanups.push(() => browser.close())
  const { page, close } = await newPage(browser)
  cleanups.push(close)
  return page
}

async function startLaptop(
  cleanups: Cleanup[],
  devhost: { service: RunningService; pool: string },
  options: { page: Page; vars?: Record<string, string> },
) {
  const home = await throwawayHome()
  cleanups.push(home.dispose)
  const scratch = await throwawayHome()
  cleanups.push(scratch.dispose)
  const sshLog = join(scratch.path, "ssh.jsonl")
  const downMarker = join(scratch.path, "down")
  const lines: string[] = []
  const opened: string[] = []
  const navigations: Promise<unknown>[] = []
  let interrupt: (() => void) | null = null
  let stopRequested = false

  const system: ConnectSystem = {
    spawn(argv) {
      const [program, ...rest] = argv
      if (program === "xdg-open" || program === "open") {
        const url = rest[0] ?? ""
        opened.push(url)
        navigations.push(options.page.goto(url))
        return exitedAlready(0)
      }
      if (program !== "ssh") {
        throw new Error(`connect spawned an unexpected program: ${argv.join(" ")}`)
      }
      const child = Bun.spawn([process.execPath, FAKE_SSH_ENTRY, ...rest], {
        env: {
          ...inheritedEnv(),
          FAKE_SSH_LOG: sshLog,
          FAKE_SSH_DOWN: downMarker,
          FAKE_SSH_ITER8: JSON.stringify(devhost.service.env.command),
          FAKE_SSH_REMOTE_ENV: JSON.stringify({
            [ENV.home]: devhost.service.home,
            [ENV.pool]: devhost.pool,
          }),
          ...options.vars,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      reapWithParent(child)
      return child
    },
    clock: {
      now: () => Date.now(),
      setTimeout: (run, ms) => setTimeout(run, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    platform: "linux",
    laptopName: LAPTOP,
    home: home.path,
    forwardAddress: FORWARD_ADDRESS,
    tailscale: () => null,
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
  cleanups.push(async () => {
    stopRequested = true
    interrupt?.()
    await waitFor("connect to stop", async () => exit, { timeoutMs: STOP_MS })
    await running
  })

  const lineAfter = (from: number, wanted: string | RegExp, timeoutMs: number): Promise<number> =>
    waitFor(
      `connect to print ${wanted}${from > 0 ? ` after line ${from}` : ""}`,
      async () => {
        if (exit !== null) {
          throw new Error(`connect ended early: ${Bun.inspect(exit)}\n${lines.join("\n")}`)
        }
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
    navigated: () => Promise.all(navigations),
    linkDown: () => writeFile(downMarker, ""),
    linkUp: () => rm(downMarker),
  }
}

async function openOnDevhost(service: RunningService) {
  const run = await runCli(service.env, ["open", fixtureDir("static")], { cwd: service.home })
  expect(run.exitCode).toBe(0)
  const [url = "", , hint = ""] = run.stdout.split("\n")
  return { url, hint, stdout: run.stdout }
}

async function laptopSockets(home: string): Promise<string[]> {
  return (await readdir(home)).filter(
    (entry) => entry.startsWith("laptop-") && entry.endsWith(".sock"),
  )
}

// The fake ssh's listener unlinks its socket when the link drops; an sshd that dies with the link
// leaves the file behind, which is the case iter8 open has to clean up.
async function leaveDeadSocket(path: string): Promise<void> {
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); setInterval(() => {}, 1000)`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "inherit" },
  )
  reapWithParent(holder)
  try {
    await waitFor("the stale socket file to exist", async () => (existsSync(path) ? true : null), {
      timeoutMs: UI_TIMEOUT_MS,
    })
  } finally {
    holder.kill("SIGKILL")
    await holder.exited
  }
}

async function showsFixtureWithOverlay(page: Page, url: string): Promise<void> {
  await waitFor(
    "the laptop page to reach the opened URL",
    async () => (page.url() === url ? true : null),
    { timeoutMs: UI_TIMEOUT_MS },
  )
  await waitFor(
    "the static fixture and the overlay host element",
    async () =>
      (await page.getByRole("heading", { name: "static", level: 1 }).count()) === 1 &&
      (await page.locator("iter8-overlay").count()) === 1
        ? true
        : null,
    { timeoutMs: UI_TIMEOUT_MS },
  )
}

test.skipIf(unbindable !== null)(
  "iter8 open on the devhost opens the page in the laptop's browser with the overlay loaded",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const devhost = await startDevhost(cleanups)
      const page = await startBrowser(cleanups)
      const laptop = await startLaptop(cleanups, devhost, { page })
      await laptop.lineAfter(
        0,
        forwardingLine(devhost.pool, devhost.service.status.machineName, true),
        CONNECT_MS,
      )

      const open = await openOnDevhost(devhost.service)
      expect(open.hint).toBe(`Opened in the browser on ${LAPTOP}.`)
      expect(laptop.opened).toEqual([open.url])
      await laptop.navigated()
      await showsFixtureWithOverlay(page, open.url)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "after a dropped link, iter8 open reaches the laptop through the fresh socket and clears the stale one",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const devhost = await startDevhost(cleanups)
      const page = await startBrowser(cleanups)
      const laptop = await startLaptop(cleanups, devhost, { page })
      const forwarding = forwardingLine(devhost.pool, devhost.service.status.machineName, true)
      const up = await laptop.lineAfter(0, forwarding, CONNECT_MS)
      const first = await openOnDevhost(devhost.service)
      expect(first.hint).toBe(`Opened in the browser on ${LAPTOP}.`)
      const before = await laptopSockets(devhost.service.home)
      expect(before).toHaveLength(1)

      await laptop.linkDown()
      const lost = await laptop.lineAfter(up + 1, new RegExp(`^Lost ${HOST}: `), CONNECT_MS)
      await laptop.linkUp()
      await laptop.lineAfter(lost + 1, forwarding, RECONNECT_MS)

      const [stale = ""] = before
      await leaveDeadSocket(join(devhost.service.home, stale))
      const reconnected = await laptopSockets(devhost.service.home)
      expect(reconnected).toContain(stale)
      expect(reconnected).toHaveLength(2)

      const second = await openOnDevhost(devhost.service)
      expect(second.hint).toBe(`Opened in the browser on ${LAPTOP}.`)
      expect(laptop.opened).toEqual([first.url, second.url])
      const after = await laptopSockets(devhost.service.home)
      expect(after).toEqual(reconnected.filter((entry) => entry !== stale))
      await laptop.navigated()
      await showsFixtureWithOverlay(page, second.url)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)

test.skipIf(unbindable !== null)(
  "when the devhost's SSH server refuses socket forwarding, the pool still forwards and iter8 open says to run connect",
  async () => {
    const cleanups: Cleanup[] = []
    try {
      const devhost = await startDevhost(cleanups)
      const page = await startBrowser(cleanups)
      const laptop = await startLaptop(cleanups, devhost, {
        page,
        vars: { FAKE_SSH_REFUSE_STREAMLOCAL: "1" },
      })

      const refused = await laptop.lineAfter(
        0,
        `${HOST}'s SSH server refuses socket forwarding, so pages opened there will not open here.`,
        CONNECT_MS,
      )
      await laptop.lineAfter(
        refused + 1,
        forwardingLine(devhost.pool, devhost.service.status.machineName, false),
        CONNECT_MS,
      )
      expect(laptop.lines.filter((line) => line.startsWith("Lost "))).toEqual([])
      expect((await laptop.tunnels()).at(-1)).not.toContain("-R")

      const open = await openOnDevhost(devhost.service)
      expect(open.hint).toStartWith(
        `Browser on another machine? Run there: iter8 connect ${hostname()} (or forward the pool yourself: ssh -N `,
      )
      expect(laptop.opened).toEqual([])
      expect(await laptopSockets(devhost.service.home)).toEqual([])

      await page.goto(open.url)
      await showsFixtureWithOverlay(page, open.url)
    } finally {
      await teardown(cleanups)
    }
  },
  TEST_MS,
)
