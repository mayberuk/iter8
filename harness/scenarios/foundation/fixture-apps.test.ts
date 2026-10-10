import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { type Fixture, fixtureDir, MANIFEST, startFixture } from "../../rig/fixtures"
import { WORKER } from "../../rig/ports"
import { type Scratch, scratchDir } from "../../rig/scratch"

const SKIPPED_DIRS = new Set(["node_modules", ".next", ".svelte-kit", ".astro", "dist"])
const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".svelte",
  ".vue",
  ".astro",
])
// Above the rig's readiness ceiling, so a slow start fails with the dev log, not a bare timeout.
const FIXTURE_TIMEOUT_MS = 240_000

type SourceLine = { file: string; line: number; text: string }

async function sourceLines(dir: string): Promise<SourceLine[]> {
  const lines: SourceLine[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) lines.push(...(await sourceLines(path)))
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      const text = await Bun.file(path).text()
      text.split("\n").forEach((line, index) => {
        lines.push({ file: path, line: index + 1, text: line })
      })
    }
  }
  return lines
}

function targetLine(fixture: string, target: string, lines: SourceLine[]) {
  const marker = `data-source-target="${target}"`
  const found = lines.filter((line) => line.text.includes(marker))
  const [only] = found
  if (found.length !== 1 || !only) {
    const where = found.map((line) => `${line.file}:${line.line}`).join(", ")
    throw new Error(
      `${fixture}: target "${target}" is on ${found.length} source lines, expected exactly one${where ? ` (${where})` : ""}`,
    )
  }
  const visible = only.text.match(new RegExp(`${marker}[^>]*>([^<{]+)<`))?.[1]?.trim()
  if (!visible) {
    throw new Error(
      `${fixture}: target "${target}" at ${only.file}:${only.line} carries no literal visible text`,
    )
  }
  return { ...only, visible }
}

async function targets(fixture: Fixture) {
  const dir = fixtureDir(fixture.name)
  const lines = await sourceLines(dir)
  return fixture.targets.map((target) => ({ target, ...targetLine(fixture.name, target, lines) }))
}

function portIsFree(port: number): boolean {
  try {
    Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

describe("source markers", () => {
  test("a target on no line or on two lines fails naming the fixture and the target", () => {
    const line = (text: string, at: number): SourceLine => ({ file: "Card.jsx", line: at, text })
    expect(() => targetLine("demo", "card", [line("<p>Card</p>", 1)])).toThrow(
      'demo: target "card" is on 0 source lines',
    )
    const twice = [
      line('<p data-source-target="card">Card</p>', 1),
      line('<p data-source-target="card">Card</p>', 2),
    ]
    expect(() => targetLine("demo", "card", twice)).toThrow(
      'demo: target "card" is on 2 source lines',
    )
    expect(() => targetLine("demo", "card", [line('<p data-source-target="card">', 1)])).toThrow(
      'demo: target "card" at Card.jsx:1 carries no literal visible text',
    )
    expect(targetLine("demo", "card", [twice[0] as SourceLine]).visible).toBe("Card")
  })

  for (const fixture of MANIFEST) {
    test(`${fixture.name} carries each target on exactly one source line with its visible text`, async () => {
      const lines = await sourceLines(fixtureDir(fixture.name))
      for (const found of await targets(fixture)) {
        expect(relative(fixtureDir(fixture.name), found.file)).not.toStartWith("..")
        const carrying = lines.filter((line) => line.text.includes(found.visible))
        expect(carrying.map((line) => `${line.file}:${line.line}`)).toEqual([
          `${found.file}:${found.line}`,
        ])
      }
    })
  }
})

describe("fixture apps in Chromium", () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await launchChromium()
  })

  afterAll(async () => {
    await browser?.close()
  })

  for (const fixture of MANIFEST) {
    test(
      `${fixture.name} serves one element per target with its unique visible text`,
      async () => {
        const expected = await targets(fixture)
        const running = await startFixture(fixture.name)
        try {
          const { page, errors, close } = await newPage(browser)
          try {
            await page.goto(running.url(fixture.readyPath))
            for (const { target, visible } of expected) {
              const element = page.locator(`[data-source-target="${target}"]`)
              await element.first().waitFor({ timeout: 30_000 })
              expect({ target, count: await element.count() }).toEqual({ target, count: 1 })
              expect((await element.innerText()).trim()).toBe(visible)
              expect({
                visible,
                count: await page.getByText(visible, { exact: true }).count(),
              }).toEqual({ visible, count: 1 })
            }
            expect(errors).toEqual([])
          } finally {
            await close()
          }
        } finally {
          await running.stop()
        }
        expect(portIsFree(running.port)).toBe(true)
      },
      FIXTURE_TIMEOUT_MS,
    )
  }
})

type Throwaway = {
  /** Wait this long before listening at all. */
  listenAfterMs?: number
  /** Answer `status` until this long after the process started, then 200. */
  readyAfterMs?: number
  status?: number
  /** Exit with this code before listening. */
  exitCode?: number
}

const THROWAWAY_SERVER = `
import { readFileSync, writeFileSync } from "node:fs"
const config = JSON.parse(readFileSync("config.json", "utf8"))
const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const started = Date.now()
writeFileSync("pid", String(process.pid))
writeFileSync("port", String(port))
if (config.exitCode !== undefined) {
  console.error("throwaway fixture refusing to start")
  process.exit(config.exitCode)
}
await Bun.sleep(config.listenAfterMs ?? 0)
Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch() {
    const ready = Date.now() - started >= (config.readyAfterMs ?? 0)
    return new Response(ready ? "ready" : "warming", { status: ready ? 200 : (config.status ?? 503) })
  },
})
`

const throwaways: Scratch[] = []

afterAll(async () => {
  await Promise.all(throwaways.map((entry) => entry.dispose()))
})

async function throwawayFixture(config: Throwaway): Promise<string> {
  const entry = await scratchDir(`/tmp/iter8-w${WORKER}-throwaway-`)
  throwaways.push(entry)
  await writeFile(
    join(entry.path, "package.json"),
    JSON.stringify({ name: "throwaway", private: true, scripts: { dev: "bun server.ts" } }),
  )
  await writeFile(join(entry.path, "server.ts"), THROWAWAY_SERVER)
  await writeFile(join(entry.path, "config.json"), JSON.stringify(config))
  return entry.path
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function recorded(dir: string, file: "pid" | "port"): Promise<number> {
  return Number(await readFile(join(dir, file), "utf8"))
}

async function logDirs(): Promise<string[]> {
  return (await readdir("/tmp")).filter((name) => name.startsWith(`iter8-w${WORKER}-vite-react-`))
}

async function expectNothingLeft(dir: string, logsBefore: string[]) {
  expect(processAlive(await recorded(dir, "pid"))).toBe(false)
  expect(portIsFree(await recorded(dir, "port"))).toBe(true)
  expect(await logDirs()).toEqual(logsBefore)
}

async function failedStart(config: Throwaway, readyTimeoutMs: number) {
  const dir = await throwawayFixture(config)
  const logsBefore = await logDirs()
  const started = performance.now()
  const error = await startFixture("vite-react", { dir, readyTimeoutMs }).then(
    () => null,
    (cause: Error) => cause,
  )
  const elapsedMs = performance.now() - started
  if (error === null) throw new Error("startFixture resolved for a fixture that never became ready")
  await expectNothingLeft(dir, logsBefore)
  return { error, elapsedMs }
}

const THROWAWAY_TIMEOUT_MS = 2_000
const NAMED_FAILURE = /^vite-react did not become ready; dev log:/

describe("startFixture readiness", () => {
  test("returns only after the server is listening, not when the process spawns", async () => {
    const dir = await throwawayFixture({ listenAfterMs: 1_200 })
    const logsBefore = await logDirs()
    const started = performance.now()
    const running = await startFixture("vite-react", { dir, readyTimeoutMs: 20_000 })
    try {
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_100)
      const response = await fetch(running.url("/"))
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "ready",
      })
    } finally {
      await running.stop()
    }
    await expectNothingLeft(dir, logsBefore)
  }, 30_000)

  test("returns only after the ready path answers 200, not after any HTTP answer", async () => {
    const dir = await throwawayFixture({ readyAfterMs: 1_200, status: 503 })
    const started = performance.now()
    const running = await startFixture("vite-react", { dir, readyTimeoutMs: 20_000 })
    try {
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_100)
      const response = await fetch(running.url("/"))
      expect({ status: response.status, body: await response.text() }).toEqual({
        status: 200,
        body: "ready",
      })
    } finally {
      await running.stop()
    }
  }, 30_000)

  test("a server that never listens fails with the fixture's name at the timeout and leaves nothing behind", async () => {
    const { error, elapsedMs } = await failedStart({ listenAfterMs: 120_000 }, THROWAWAY_TIMEOUT_MS)
    expect(error.message).toMatch(NAMED_FAILURE)
    expect((error.cause as Error).message).toContain(`after ${THROWAWAY_TIMEOUT_MS} ms`)
    expect(elapsedMs).toBeGreaterThanOrEqual(THROWAWAY_TIMEOUT_MS - 100)
    expect(elapsedMs).toBeLessThan(THROWAWAY_TIMEOUT_MS + 5_000)
  }, 30_000)

  test("a server that only answers non-200 fails with the fixture's name at the timeout and leaves nothing behind", async () => {
    const { error, elapsedMs } = await failedStart(
      { readyAfterMs: 120_000, status: 503 },
      THROWAWAY_TIMEOUT_MS,
    )
    expect(error.message).toMatch(NAMED_FAILURE)
    expect((error.cause as Error).message).toContain(`after ${THROWAWAY_TIMEOUT_MS} ms`)
    expect(elapsedMs).toBeGreaterThanOrEqual(THROWAWAY_TIMEOUT_MS - 100)
    expect(elapsedMs).toBeLessThan(THROWAWAY_TIMEOUT_MS + 5_000)
  }, 30_000)

  test("a server that exits early fails at once with its output and leaves nothing behind", async () => {
    const { error, elapsedMs } = await failedStart({ exitCode: 3 }, 60_000)
    expect(error.message).toMatch(NAMED_FAILURE)
    expect(error.message).toContain("throwaway fixture refusing to start")
    expect((error.cause as Error).message).toContain("vite-react dev server exited early")
    expect(elapsedMs).toBeLessThan(10_000)
  }, 30_000)
})
