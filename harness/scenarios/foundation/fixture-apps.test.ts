import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { type Fixture, fixtureDir, MANIFEST, startFixture } from "../../rig/fixtures"

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
