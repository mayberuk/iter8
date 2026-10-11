import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"

const TOKENS_CSS = Bun.file(new URL("../../../apps/overlay/src/ui/tokens.css", import.meta.url))
const SKETCH = Bun.file(
  new URL("../../../docs/design/sketches/overlay-reference.html", import.meta.url),
)
const NEUTRAL_DARK = Bun.file(new URL("./dark-neutral-tokens.css", import.meta.url))
const UI_DIR = Bun.fileURLToPath(new URL("../../../apps/overlay/src/ui/", import.meta.url))
const LIGHTNESS_TOLERANCE = 0.004
const GREY_CHROMA_CEILING = 0.005
const SEMANTIC_TOKEN =
  /^--(fix|change|question|keep|cobalt|claude|amber|busy|mark|ring|sel|agent-card|on-accent|toast|coach)(-|$)/

const NAMED_TOKENS = [
  "--ring",
  "--ring-hatch",
  "--mark-arrow",
  "--mark-hl",
  "--toast-blue",
  "--toast-amber",
  "--toast-green",
  "--coach-step",
]

function pairs(block: string): Map<string, string> {
  return new Map(
    Array.from(block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g), (match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  )
}

function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`The sketch has no block from ${from} to ${to}`)
  return text.slice(start + from.length, end)
}

type Rgba = { r: number; g: number; b: number; a: number }

function parseColors(text: string): Rgba[] {
  const found: Rgba[] = []
  const literal = /#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|rgba?\(([^)]+)\)/gi
  for (const match of text.matchAll(literal)) {
    if (match[1]) {
      const hex = match[1].length < 6 ? Array.from(match[1], (c) => c + c).join("") : match[1]
      const byte = (at: number) => Number.parseInt(hex.slice(at, at + 2), 16)
      found.push({ r: byte(0), g: byte(2), b: byte(4), a: hex.length === 8 ? byte(6) / 255 : 1 })
    } else {
      const parts = (match[2] ?? "")
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number)
      found.push({
        r: parts[0] ?? Number.NaN,
        g: parts[1] ?? Number.NaN,
        b: parts[2] ?? Number.NaN,
        a: parts[3] ?? 1,
      })
    }
  }
  return found
}

function oklab({ r, g, b }: Rgba): [number, number, number] {
  const linear = (c: number) => {
    const v = c / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)] as const
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const lightness = (color: Rgba) => oklab(color)[0]
const chroma = (color: Rgba) => Math.hypot(oklab(color)[1], oklab(color)[2])

type Declaration = { selector: string; depth: number; property: string; value: string }

function declarations(css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const stack: string[] = []
  const found: Declaration[] = []
  let start = 0
  const flush = (end: number) => {
    const chunk = text.slice(start, end).trim()
    const colon = chunk.indexOf(":")
    const selector = stack[stack.length - 1]
    if (colon < 0 || selector === undefined) return
    found.push({
      selector,
      depth: stack.length,
      property: chunk.slice(0, colon).trim(),
      value: chunk.slice(colon + 1).trim(),
    })
  }
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]
    if (ch === "{") {
      stack.push(text.slice(start, at).trim())
      start = at + 1
    } else if (ch === "}") {
      flush(at)
      stack.pop()
      start = at + 1
    } else if (ch === ";") {
      flush(at)
      start = at + 1
    }
  }
  return found
}

function same(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(?<!\d)0\./g, ".")
}

let browser: Browser
let page: Page
let close: () => Promise<void>
let sketchDark: Map<string, string>
let sketchLight: Map<string, string>
let neutralDark: Map<string, string>
let expectedDark: Map<string, string>

beforeAll(async () => {
  const sketch = await SKETCH.text()
  sketchDark = pairs(between(sketch, "const DARK = `", "`;"))
  sketchLight = pairs(between(sketch, "\n.root{", "font-family:var(--sans)"))
  neutralDark = pairs(await NEUTRAL_DARK.text())
  expectedDark = new Map([...sketchDark, ...neutralDark])
  const css = await TOKENS_CSS.text()
  browser = await launchChromium()
  const opened = await newPage(browser)
  page = opened.page
  close = opened.close
  await page.setContent(`<!doctype html><html><body><div id="host"></div></body></html>`)
  await page.evaluate((css) => {
    const root = document.getElementById("host")?.attachShadow({ mode: "open" })
    if (!root) throw new Error("no host")
    const style = document.createElement("style")
    style.textContent = css
    root.append(style)
  }, css)
})

afterAll(async () => {
  await close?.()
  await browser?.close()
})

async function tokens(theme: string, scheme: "light" | "dark", names: string[]) {
  await page.emulateMedia({ colorScheme: scheme })
  return page.evaluate(
    ({ theme, names }) => {
      const shadow = document.getElementById("host")?.shadowRoot
      shadow?.querySelector(".root")?.remove()
      const el = document.createElement("div")
      el.className = "root"
      el.dataset.theme = theme
      shadow?.append(el)
      const style = getComputedStyle(el)
      return {
        colorScheme: style.colorScheme,
        values: Object.fromEntries(
          names.map((name) => [name, style.getPropertyValue(name).trim()]),
        ),
      }
    },
    { theme, names },
  )
}

function expectValues(actual: Record<string, string>, expected: Map<string, string>) {
  const names = Array.from(expected.keys())
  expect(names.length).toBeGreaterThan(50)
  expect(Object.fromEntries(names.map((name) => [name, same(actual[name] ?? "")]))).toEqual(
    Object.fromEntries(names.map((name) => [name, same(expected.get(name) ?? "")])),
  )
}

const darkNames = () => Array.from(expectedDark.keys())

test("a dark root applies the sketch's dark values, with the neutral fixture's greys for its tokens", async () => {
  const { colorScheme, values } = await tokens("dark", "light", darkNames())
  expect(colorScheme).toBe("dark")
  expectValues(values, expectedDark)
})

test("a light root applies the sketch's light values even when the system is dark", async () => {
  const lightOfDark = new Map(
    Array.from(expectedDark.keys(), (name) => [name, sketchLight.get(name)] as const).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  expect(lightOfDark.size).toBeGreaterThan(50)
  const { colorScheme, values } = await tokens("light", "dark", darkNames())
  expect(colorScheme).toBe("light")
  expectValues(values, lightOfDark)
})

test("an auto root follows the system colour scheme", async () => {
  const dark = await tokens("auto", "dark", darkNames())
  expect(dark.colorScheme).toBe("dark")
  expectValues(dark.values, expectedDark)

  const light = await tokens("auto", "light", ["--paper", "--ink", "--fix"])
  expect(light.colorScheme).toBe("light")
  expect(light.values).toEqual({
    "--paper": sketchLight.get("--paper")?.toLowerCase() ?? "missing",
    "--ink": sketchLight.get("--ink")?.toLowerCase() ?? "missing",
    "--fix": sketchLight.get("--fix")?.toLowerCase() ?? "missing",
  })
})

test("the named tokens exist in every theme and the font stacks lead with the iter8 families", async () => {
  for (const [theme, scheme] of [
    ["light", "light"],
    ["dark", "light"],
    ["auto", "dark"],
  ] as const) {
    const { values } = await tokens(theme, scheme, [...NAMED_TOKENS, "--sans", "--mono"])
    for (const name of NAMED_TOKENS) expect(values[name], `${name} in ${theme}`).not.toBe("")
    expect(values["--sans"]).toStartWith('"iter8 Reddit Sans"')
    expect(values["--mono"]).toStartWith('"iter8 JetBrains Mono"')
  }
})

test("every neutral dark token is grey at the sketch's lightness", async () => {
  const names = Array.from(neutralDark.keys())
  expect(names.length).toBe(48)
  const failures: string[] = []
  for (const [theme, scheme] of [
    ["dark", "light"],
    ["auto", "dark"],
  ] as const) {
    const { values } = await tokens(theme, scheme, names)
    for (const name of names) {
      const got = parseColors(values[name] ?? "")
      const warm = parseColors(sketchDark.get(name) ?? "")
      const [color, original] = [got[0], warm[0]]
      if (got.length !== 1 || warm.length !== 1 || !color || !original) {
        failures.push(
          `${name} in ${theme}: expected one colour, got ${got.length} and ${warm.length}`,
        )
        continue
      }
      if (color.r !== color.g || color.g !== color.b)
        failures.push(`${name} in ${theme}: not grey (${color.r}, ${color.g}, ${color.b})`)
      const drift = Math.abs(lightness(color) - lightness(original))
      if (!(drift <= LIGHTNESS_TOLERANCE))
        failures.push(`${name} in ${theme}: lightness drifts by ${drift.toFixed(4)}`)
      if (Math.abs(color.a - original.a) > 1e-9)
        failures.push(`${name} in ${theme}: alpha ${color.a} is not ${original.a}`)
    }
  }
  expect(failures).toEqual([])
})

test("no warm colour literal remains in the overlay's CSS", async () => {
  const files = (await Array.fromAsync(new Bun.Glob("*.css").scan({ cwd: UI_DIR }))).sort()
  const parsed = await Promise.all(
    files.map(async (file) => ({
      file,
      decls: declarations(await Bun.file(`${UI_DIR}${file}`).text()),
    })),
  )
  const semantic = new Set<string>()
  for (const { decls } of parsed)
    for (const decl of decls)
      if (SEMANTIC_TOKEN.test(decl.property))
        for (const c of parseColors(decl.value)) semantic.add(`${c.r},${c.g},${c.b}`)
  expect(semantic.size).toBeGreaterThan(10)

  const warm: string[] = []
  let scanned = 0
  for (const { file, decls } of parsed) {
    for (const decl of decls) {
      if (SEMANTIC_TOKEN.test(decl.property)) continue
      if (file === "tokens.css" && decl.selector === ".root" && decl.depth === 1) continue
      if (decl.selector.includes(".ic-d")) continue
      for (const c of parseColors(decl.value)) {
        scanned++
        if (chroma(c) > GREY_CHROMA_CEILING && !semantic.has(`${c.r},${c.g},${c.b}`))
          warm.push(`${file} ${decl.selector} { ${decl.property}: ${decl.value} }`)
      }
    }
  }
  expect(scanned).toBeGreaterThan(100)
  expect(warm).toEqual([])
})
