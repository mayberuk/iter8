import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"

const TOKENS_CSS = Bun.file(new URL("../../../apps/overlay/src/ui/tokens.css", import.meta.url))
const SKETCH = Bun.file(
  new URL("../../../docs/design/sketches/overlay-reference.html", import.meta.url),
)

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

beforeAll(async () => {
  const sketch = await SKETCH.text()
  sketchDark = pairs(between(sketch, "const DARK = `", "`;"))
  sketchLight = pairs(between(sketch, "\n.root{", "font-family:var(--sans)"))
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

const darkNames = () => Array.from(sketchDark.keys())

test("a dark root applies the sketch's dark token values", async () => {
  const { colorScheme, values } = await tokens("dark", "light", darkNames())
  expect(colorScheme).toBe("dark")
  expectValues(values, sketchDark)
})

test("a light root applies the sketch's light values even when the system is dark", async () => {
  const lightOfDark = new Map(
    Array.from(sketchDark.keys(), (name) => [name, sketchLight.get(name)] as const).filter(
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
  expectValues(dark.values, sketchDark)

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
    expect(values["--sans"]).toStartWith('"iter8 Figtree"')
    expect(values["--mono"]).toStartWith('"iter8 Spline Sans Mono"')
  }
})
