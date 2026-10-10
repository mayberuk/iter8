import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OwnerId, ServiceStatus } from "@iter8/protocol"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { cliCommand } from "../../rig/cli"
import { nextPort, portBlock, WORKER } from "../../rig/ports"
import { type Scratch, scratchDir } from "../../rig/scratch"
import { openThroughProxy, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { FAKE_CLI_ENTRY, FAKE_CLI_TOKEN, readFakeCliCalls } from "../../stubs/fake-cli"

const scratches: Scratch[] = []

afterAll(async () => {
  await Promise.all(scratches.map((entry) => entry.dispose()))
})

async function scratch(): Promise<string> {
  const entry = await scratchDir(`/tmp/iter8-fake-w${WORKER}-`)
  scratches.push(entry)
  return entry.path
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

async function ownHomes(): Promise<string[]> {
  return (await readdir("/tmp")).filter((name) => name.startsWith(`iter8-w${WORKER}-`)).sort()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function rangeOf(pool: string): { first: number; last: number } {
  const match = /^(\d+)-(\d+)$/.exec(pool)
  if (match === null) throw new Error(`not a port range: ${pool}`)
  return { first: Number(match[1]), last: Number(match[2]) }
}

async function startFake(vars: Record<string, string> = {}) {
  const log = join(await scratch(), "calls.jsonl")
  const service = await startService({
    entry: FAKE_CLI_ENTRY,
    env: { FAKE_CLI_LOG: log, ...vars },
  })
  return { service, log }
}

async function serveCall(log: string) {
  const calls = await readFakeCliCalls(log)
  const serve = calls.find((call) => call.argv[0] === "serve")
  if (serve === undefined) throw new Error(`no serve call in ${JSON.stringify(calls)}`)
  return serve
}

test("startService waits for the serve process to report ready and exposes its status", async () => {
  const before = new Set(await readdir("/tmp"))
  const { service, log } = await startFake()
  try {
    const serve = await serveCall(log)
    expect(service.status.state).toBe("ready")
    expect(ServiceStatus.parse(service.status)).toEqual(service.status)
    expect(service.status.pid).toBe(serve.pid)
    expect(service.pid).toBe(serve.pid)
    expect(service.machineId).toBe(service.status.machineId)
    expect(service.status.home).toBe(service.home)

    expect(serve.env.ITER8_HOME).toBe(service.home)
    expect(service.home).toMatch(new RegExp(`^/tmp/iter8-w${WORKER}-[A-Za-z0-9]{6}$`))
    expect(before.has(service.home.slice("/tmp/".length))).toBe(false)

    const block = portBlock(WORKER)
    const pool = rangeOf(serve.env.ITER8_POOL ?? "")
    expect(pool.first).toBeGreaterThanOrEqual(block.first)
    expect(pool.last).toBeLessThanOrEqual(block.last)
    expect(service.poolPorts).toEqual(
      Array.from({ length: pool.last - pool.first + 1 }, (_, index) => pool.first + index),
    )
    expect(service.status.pool).toEqual(service.poolPorts)

    const version = await service.cli(["--version"])
    expect(version.exitCode).toBe(0)
    expect(version.stdout.trim()).toBe("iter8 0.0.0-fake")
    expect(service.logs()).toContain(`serving as ${serve.pid}`)
  } finally {
    await service.stop()
  }
}, 30_000)

test("two services in one file get different homes and disjoint pools", async () => {
  const first = await startFake()
  const second = await startFake()
  try {
    expect(first.service.home).not.toBe(second.service.home)
    const a = rangeOf(first.service.env.pool)
    const b = rangeOf(second.service.env.pool)
    expect(a.last < b.first || b.last < a.first).toBe(true)
    expect((await serveCall(first.log)).env.ITER8_HOME).toBe(first.service.home)
    expect((await serveCall(second.log)).env.ITER8_HOME).toBe(second.service.home)
  } finally {
    await first.service.stop()
    await second.service.stop()
  }
}, 30_000)

test("a serve that exits before ready fails startService with its exit code and output", async () => {
  const entry = join(await scratch(), "exits-early.ts")
  await writeFile(entry, 'console.error("serve refused to start")\nprocess.exit(7)\n')
  const homesBefore = await ownHomes()
  const started = performance.now()
  await expect(startService({ entry })).rejects.toThrow(
    /serve exited with code 7 before reporting ready[\s\S]*serve refused to start/,
  )
  expect(performance.now() - started).toBeLessThan(10_000)
  expect(await ownHomes()).toEqual(homesBefore)
}, 30_000)

test("stop removes the throwaway home, and only that one", async () => {
  const first = await startFake()
  const second = await startFake()
  try {
    expect(await exists(first.service.home)).toBe(true)
    await first.service.stop()
    expect(await exists(first.service.home)).toBe(false)
    expect(await exists(second.service.home)).toBe(true)
  } finally {
    await first.service.stop()
    await second.service.stop()
  }
  expect(await exists(second.service.home)).toBe(false)
}, 30_000)

test("stop leaves no serve process behind", async () => {
  const { service } = await startFake()
  expect(alive(service.pid)).toBe(true)
  await service.stop()
  expect(alive(service.pid)).toBe(false)
  await service.stop()
}, 30_000)

test("openThroughProxy runs open as the stub session's child, returns the page token and navigates", async () => {
  const port = await nextPort()
  const hosts: string[] = []
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      hosts.push(request.headers.get("host") ?? "")
      return new Response("<!doctype html><title>fake page</title><h1>rig-served</h1>", {
        headers: { "content-type": "text/html" },
      })
    },
  })
  const url = `http://fakepage.localhost:${port}/`
  const { service, log } = await startFake({ FAKE_CLI_OPEN_URL: url })
  const browser = await launchChromium()
  try {
    const session = await startAgentSession(service)
    const { page, close } = await newPage(browser)
    try {
      const { open, token } = await openThroughProxy(service, page, "http://127.0.0.1:5173", {
        session,
      })
      expect(token).toBe(FAKE_CLI_TOKEN)
      expect(open.url).toBe(url)
      expect(page.url()).toBe(url)
      expect(await page.locator("h1").textContent()).toBe("rig-served")
      expect(hosts).toContain(`fakepage.localhost:${port}`)

      const opens = await waitFor("the recorded open call", async () => {
        const found = (await readFakeCliCalls(log)).filter((call) => call.argv[0] === "open")
        return found.length === 1 ? found : null
      })
      expect(opens[0]?.argv).toEqual(["open", "http://127.0.0.1:5173", "--json"])
      expect(opens[0]?.ppid).toBe(session.pid)
      expect(opens[0]?.env.CLAUDE_CODE_SESSION_ID).toBe(session.label)
    } finally {
      await close()
      await session.exit()
    }
  } finally {
    await browser.close()
    await service.stop()
    await app.stop(true)
  }
}, 60_000)

test("openThroughProxy with an owner passes --owner and runs from the test process", async () => {
  const port = await nextPort()
  const app = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () =>
      new Response("<!doctype html><p>owned</p>", { headers: { "content-type": "text/html" } }),
  })
  const url = `http://ownerpage.localhost:${port}/`
  const { service, log } = await startFake({
    FAKE_CLI_OPEN_URL: url,
  })
  const browser = await launchChromium()
  try {
    const { page, close } = await newPage(browser)
    try {
      const { token } = await openThroughProxy(service, page, "/srv/mock", {
        owner: OwnerId.parse("own_test"),
      })
      expect(token).toBe(FAKE_CLI_TOKEN)
      expect(page.url()).toBe(url)
      const opens = (await readFakeCliCalls(log)).filter((call) => call.argv[0] === "open")
      expect(opens.map((call) => call.argv)).toEqual([
        ["open", "/srv/mock", "--json", "--owner", "own_test"],
      ])
      expect(opens[0]?.ppid).toBe(process.pid)
    } finally {
      await close()
    }
  } finally {
    await browser.close()
    await service.stop()
    await app.stop(true)
  }
}, 60_000)

describe("cliCommand", () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..")
  const defaultCommand = [process.execPath, join(repoRoot, "apps", "iter8", "src", "main.ts")]
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.ITER8_TEST_BINARY
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.ITER8_TEST_BINARY
    else process.env.ITER8_TEST_BINARY = saved
  })

  test("a given binary is the whole command", () => {
    delete process.env.ITER8_TEST_BINARY
    expect(cliCommand("/opt/iter8/given")).toEqual(["/opt/iter8/given"])
  })

  test("without a binary, ITER8_TEST_BINARY is the whole command", () => {
    process.env.ITER8_TEST_BINARY = "/opt/iter8/from-env"
    expect(cliCommand()).toEqual(["/opt/iter8/from-env"])
  })

  test("a given binary wins over ITER8_TEST_BINARY", () => {
    process.env.ITER8_TEST_BINARY = "/opt/iter8/from-env"
    expect(cliCommand("/opt/iter8/given")).toEqual(["/opt/iter8/given"])
  })

  test("with neither, the command runs the repo's CLI entry on the current bun", () => {
    delete process.env.ITER8_TEST_BINARY
    expect(cliCommand()).toEqual(defaultCommand)
  })
})
