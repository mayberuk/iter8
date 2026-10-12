import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { Intent } from "@iter8/protocol"
import type { Browser, Page, Route } from "playwright"
import type { IconName } from "../../../apps/overlay/src/ui/glyphs"
import { ASSET_PREFIX } from "../../../scripts/build"
import { launchChromium, newPage } from "../../rig/browser"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import fixture from "./icons-mingcute-fluent.json"
import type { Item, UiHarness } from "./ui-assets.entry"

const ORIGIN = "http://engine.localhost"
const FONT_ROOT = new URL("../../../apps/overlay/assets/fonts/", import.meta.url)

const ICON_CATALOG = {
  pick: true,
  region: true,
  shot: true,
  send: true,
  x: true,
  edit: true,
  trash: true,
  grip: true,
  check: true,
  file: true,
  arrow: true,
  box: true,
  hl: true,
  undo: true,
  search: true,
  keys: true,
  term: true,
  layers: true,
  compare: true,
  eye: true,
  history: true,
  collapse: true,
  more: true,
  sun: true,
  moon: true,
  auto: true,
  copy: true,
  down: true,
  up: true,
  right: true,
  info: true,
  bulb: true,
  flag: true,
  alert: true,
  octagon: true,
  lock: true,
} satisfies Record<IconName, true>

const ICON_NAMES = Object.keys(ICON_CATALOG) as IconName[]

const ICON_FIXTURE: Record<IconName, { viewBox?: string; inner: string }> = fixture.icons

const STATUS_KEYS = ["queued", "delivered", "working", "done", "answered", "failed"] as const
const METER_KEYS = ["live", "busy", "gone", "checking", "delivered", "unattached"] as const

const INTENT_TOKENS = {
  fix: ["#010203", "#040506"],
  change: ["#070809", "#0a0b0c"],
  question: ["#0d0e0f", "#101112"],
  keep: ["#131415", "#161718"],
} as const

const TOKEN_STYLE = Object.entries(INTENT_TOKENS)
  .map(([intent, [color, dark]]) => `--${intent}:${color};--${intent}-d:${dark}`)
  .join(";")

const PAGE = `<!doctype html>
<html lang="en"><head><title>ui assets</title></head>
<body>
<div id="stage" style="${TOKEN_STYLE}"></div>
<script type="module" src="/ui.js"></script>
</body></html>`

let browser: Browser
let bundle: Scratch
let assetFiles: string[]
const openPages: (() => Promise<void>)[] = []

beforeAll(async () => {
  bundle = await scratchDir(`${SCRATCH_ROOT}ui-assets-`)
  const result = await Bun.build({
    entrypoints: [Bun.fileURLToPath(new URL("./ui-assets.entry.tsx", import.meta.url))],
    outdir: bundle.path,
    target: "browser",
    format: "esm",
    publicPath: ASSET_PREFIX,
    naming: { entry: "ui.js", asset: "[name]-[hash].[ext]" },
  })
  if (!result.success) throw new Error(`Bundling the ui entry failed:\n${result.logs.join("\n")}`)
  assetFiles = result.outputs.map((output) => output.path.slice(bundle.path.length + 1))
  browser = await launchChromium()
})

afterEach(async () => {
  await Promise.all(openPages.splice(0).map((close) => close()))
})

afterAll(async () => {
  await browser?.close()
  await bundle?.dispose()
})

async function serve(route: Route, failFonts: boolean): Promise<void> {
  const { pathname } = new URL(route.request().url())
  if (pathname === "/") return route.fulfill({ body: PAGE, contentType: "text/html" })
  if (pathname === "/ui.js") {
    return route.fulfill({ path: join(bundle.path, "ui.js"), contentType: "text/javascript" })
  }
  if (pathname.startsWith(ASSET_PREFIX) && pathname.endsWith(".woff2")) {
    if (failFonts) return route.fulfill({ status: 404, body: "not found" })
    const file = assetFiles.find((name) => pathname === `${ASSET_PREFIX}${name}`)
    if (file !== undefined) {
      return route.fulfill({ path: join(bundle.path, file), contentType: "font/woff2" })
    }
  }
  return route.fulfill({ status: 404, body: "not found" })
}

async function openUi(options: { failFonts?: boolean } = {}) {
  const { page, errors, close } = await newPage(browser)
  openPages.push(close)
  const fontRequests: string[] = []
  page.on("request", (request) => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith(".woff2")) fontRequests.push(pathname)
  })
  await page.addInitScript(() => {
    Reflect.set(window, "__rejections", [])
    window.addEventListener("unhandledrejection", (event) => {
      ;(Reflect.get(window, "__rejections") as unknown[]).push(String(event.reason))
    })
  })
  await page.route(`${ORIGIN}/**`, (route) => serve(route, options.failFonts ?? false))
  await page.goto(`${ORIGIN}/`)
  await waitFor("the ui harness", () =>
    page.evaluate(() => (Reflect.has(window, "__iter8Ui") ? true : null)),
  )
  return { page, errors, fontRequests }
}

function show(page: Page, items: Item[]): Promise<void> {
  return page.evaluate(
    (items) => (Reflect.get(window, "__iter8Ui") as UiHarness).show(items),
    items,
  )
}

type Painted = {
  tag: string | null
  width: number
  height: number
  viewBox: string | null
  ariaHidden: string | null
  box: { x: number; y: number; width: number; height: number } | null
}

function painted(page: Page): Promise<Painted[]> {
  return page.evaluate(() => {
    const root = document.getElementById("stage")?.shadowRoot
    if (!root) throw new Error("nothing was shown")
    return Array.from(root.querySelectorAll("[data-item]"), (cell) => {
      const svg = cell.querySelector("svg")
      const shape = svg?.querySelector("path, rect, circle")
      const box = svg?.getBBox()
      const rendered = svg?.getBoundingClientRect()
      return {
        tag: shape?.tagName ?? null,
        width: rendered?.width ?? 0,
        height: rendered?.height ?? 0,
        viewBox: svg?.getAttribute("viewBox") ?? null,
        ariaHidden: svg?.getAttribute("aria-hidden") ?? null,
        box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null,
      }
    })
  })
}

function inspectIcons(page: Page, inners: string[]) {
  return page.evaluate((inners) => {
    const root = document.getElementById("stage")?.shadowRoot
    if (!root) throw new Error("nothing was shown")
    return Array.from(root.querySelectorAll("[data-item]"), (cell, index) => {
      const svg = cell.querySelector("svg")
      const groups = Array.from(svg?.querySelectorAll(":scope > g") ?? [])
      const shade = groups[0] as SVGGraphicsElement | undefined
      const ink = groups[1] as SVGGraphicsElement | undefined
      if (!svg || !shade || !ink)
        throw new Error("an icon must draw an svg with a shade and an ink group")
      const parsed = new DOMParser().parseFromString(
        `<svg xmlns="http://www.w3.org/2000/svg">${inners[index]}</svg>`,
        "image/svg+xml",
      )
      const box = ink.getBBox()
      return {
        viewBox: svg.getAttribute("viewBox"),
        ariaHidden: svg.getAttribute("aria-hidden"),
        width: svg.getBoundingClientRect().width,
        height: svg.getBoundingClientRect().height,
        groups: groups.length,
        expected: Array.from(parsed.querySelectorAll("path"), (path) => ({
          d: path.getAttribute("d"),
          fillRule: path.getAttribute("fill-rule") ?? "nonzero",
        })),
        shadePaths: Array.from(shade.querySelectorAll("path"), (path) => ({
          d: path.getAttribute("d"),
          fillRule: getComputedStyle(path).fillRule,
        })),
        ink: {
          fill: ink.getAttribute("fill"),
          stroke: ink.getAttribute("stroke"),
          paths: Array.from(ink.querySelectorAll("path"), (path) => ({
            d: path.getAttribute("d"),
            fillRule: getComputedStyle(path).fillRule,
          })),
          bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
        },
      }
    })
  }, inners)
}

describe("the glyph set", () => {
  test("every IconName renders a size-pixel svg that paints the fixture's paths inside its viewBox", async () => {
    const { page } = await openUi()
    await show(
      page,
      ICON_NAMES.map((name) => ({ kind: "icon", props: { name } })),
    )
    const icons = await inspectIcons(
      page,
      ICON_NAMES.map((name) => ICON_FIXTURE[name].inner),
    )
    expect(icons).toHaveLength(ICON_NAMES.length)
    icons.forEach((icon, index) => {
      const name = ICON_NAMES[index] as IconName
      const entry = ICON_FIXTURE[name]
      const unit = (entry.viewBox ?? fixture.viewBox).split(" ")[2]
      expect({ name, viewBox: icon.viewBox, ariaHidden: icon.ariaHidden }).toEqual({
        name,
        viewBox: entry.viewBox ?? fixture.viewBox,
        ariaHidden: "true",
      })
      expect({ name, width: icon.width, height: icon.height }).toEqual({
        name,
        width: 16,
        height: 16,
      })
      expect(icon.groups, `${name} draws two copies`).toBe(2)
      expect(icon.expected.length, `${name} has no paths in the fixture`).toBeGreaterThan(0)
      expect({ name, paths: icon.ink.paths }).toEqual({ name, paths: icon.expected })
      expect({ name, paths: icon.shadePaths }).toEqual({ name, paths: icon.ink.paths })
      expect(icon.ink.bbox.width, `${name} paints nothing`).toBeGreaterThan(0)
      expect(icon.ink.bbox.height, `${name} paints nothing`).toBeGreaterThan(0)
      expect(icon.ink.bbox.x).toBeGreaterThanOrEqual(0)
      expect(icon.ink.bbox.y).toBeGreaterThanOrEqual(0)
      expect(icon.ink.bbox.x + icon.ink.bbox.width).toBeLessThanOrEqual(Number(unit))
      expect(icon.ink.bbox.y + icon.ink.bbox.height).toBeLessThanOrEqual(Number(unit))
    })
  }, 30_000)

  test("pick, region, shot and auto have a 16-unit viewBox and every other icon a 24-unit one", async () => {
    const { page } = await openUi()
    await show(
      page,
      ICON_NAMES.map((name) => ({ kind: "icon", props: { name } })),
    )
    const icons = await painted(page)
    const sixteen: IconName[] = ["pick", "region", "shot", "auto"]
    expect(ICON_NAMES.map((name, index) => [name, icons[index]?.viewBox])).toEqual(
      ICON_NAMES.map((name) => [name, sixteen.includes(name) ? "0 0 16 16" : "0 0 24 24"]),
    )
  }, 30_000)

  test("pick alone is stroked; every other icon is filled with currentColor", async () => {
    const { page } = await openUi()
    await show(
      page,
      ICON_NAMES.map((name) => ({ kind: "icon", props: { name } })),
    )
    const icons = await inspectIcons(
      page,
      ICON_NAMES.map((name) => ICON_FIXTURE[name].inner),
    )
    icons.forEach((icon, index) => {
      const name = ICON_NAMES[index] as IconName
      if (name === "pick") {
        expect({ name, fill: icon.ink.fill, stroke: icon.ink.stroke }).toEqual({
          name,
          fill: "none",
          stroke: "currentColor",
        })
      } else {
        expect({ name, fill: icon.ink.fill, stroke: icon.ink.stroke }).toEqual({
          name,
          fill: "currentColor",
          stroke: null,
        })
      }
    })
  }, 30_000)

  test("an icon draws its shapes twice, the shaded copy exactly one CSS pixel lower, the ink in currentColor, and takes a size", async () => {
    const { page } = await openUi()
    const names = ["trash", "pick"] as const
    const sizes = [8, 15, 16, 24]
    await show(
      page,
      names.flatMap((name) => sizes.map((size) => ({ kind: "icon", props: { name, size } }))),
    )
    const results = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      return Array.from(root?.querySelectorAll("[data-item] svg") ?? [], (svg) => {
        const chosen = "rgb(12, 34, 56)"
        ;(svg as SVGSVGElement).style.color = chosen
        const [shade, ink] = Array.from(svg.querySelectorAll(":scope > g"))
        if (!shade || !ink) throw new Error("an icon must draw two groups")
        const paint = getComputedStyle(ink)
        const rendered = svg.getBoundingClientRect()
        return {
          size: [rendered.width, rendered.height],
          offset: shade.getBoundingClientRect().top - ink.getBoundingClientRect().top,
          shadeShapes: shade.children.length,
          inkShapes: ink.children.length,
          fill: paint.fill,
          stroke: paint.stroke,
          chosen,
        }
      })
    })
    expect(results).toHaveLength(names.length * sizes.length)
    results.forEach((result, index) => {
      const name = names[Math.floor(index / sizes.length)]
      const size = sizes[index % sizes.length] as number
      expect(result.size, `${name} at ${size}`).toEqual([size, size])
      expect(result.offset, `${name} at ${size}`).toBeCloseTo(1, 5)
      expect(result.shadeShapes).toBeGreaterThan(0)
      expect(result.shadeShapes).toBe(result.inkShapes)
      if (name === "pick") {
        expect({ fill: result.fill, stroke: result.stroke }).toEqual({
          fill: "none",
          stroke: result.chosen,
        })
      } else {
        expect(result.fill).toBe(result.chosen)
      }
    })
  }, 30_000)

  test("IntentGlyph renders a distinct 20px glyph for each intent, shaded from that intent's tokens", async () => {
    const { page } = await openUi()
    const intents = Intent.options
    await show(
      page,
      intents.map((intent) => ({ kind: "intent", props: { intent } })),
    )
    const glyphs = await painted(page)
    expect(glyphs).toHaveLength(4)
    for (const glyph of glyphs) {
      expect(glyph).toMatchObject({
        viewBox: "0 0 20 20",
        width: 20,
        height: 20,
        ariaHidden: "true",
      })
      expect(glyph.box?.width).toBeGreaterThan(0)
      expect(glyph.box?.height).toBeGreaterThan(0)
    }

    const details = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      return Array.from(root?.querySelectorAll("[data-item] svg") ?? [], (svg) => ({
        markup: svg.innerHTML,
        colour: getComputedStyle(svg).getPropertyValue("--c").trim(),
        dark: getComputedStyle(svg).getPropertyValue("--cd").trim(),
      }))
    })
    expect(new Set(details.map((detail) => detail.markup)).size).toBe(4)
    expect(details.map(({ colour, dark }) => [colour, dark])).toEqual(
      intents.map((intent) => [...INTENT_TOKENS[intent]]),
    )
  }, 30_000)

  test("IntentGlyph takes a size", async () => {
    const { page } = await openUi()
    await show(page, [{ kind: "intent", props: { intent: "keep", size: 32 } }])
    const [glyph] = await painted(page)
    expect(glyph).toMatchObject({ width: 32, height: 32, viewBox: "0 0 20 20" })
  }, 30_000)

  test("every note state has a status glyph that paints, and failed is the cross", async () => {
    const { page } = await openUi()
    await show(
      page,
      STATUS_KEYS.map((state) => ({ kind: "status", props: { state } })),
    )
    const glyphs = await painted(page)
    expect(glyphs).toHaveLength(STATUS_KEYS.length)
    glyphs.forEach((glyph, index) => {
      expect(glyph.viewBox).toBe("0 0 18 18")
      expect(glyph.box?.width, `${STATUS_KEYS[index]} paints nothing`).toBeGreaterThan(0)
      expect(glyph.box?.height, `${STATUS_KEYS[index]} paints nothing`).toBeGreaterThan(0)
    })
    const failed = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      const svg = root?.querySelectorAll("[data-item] svg")[5]
      return Array.from(svg?.querySelectorAll("path") ?? [], (path) => path.getAttribute("d"))
    })
    expect(failed).toEqual(["m4 4 8 8M12 4l-8 8", "m4 4 8 8M12 4l-8 8"])
  }, 30_000)

  test("each delivered glyph in one shadow root clips with an id of its own", async () => {
    const { page } = await openUi()
    await show(page, [
      { kind: "status", props: { state: "delivered" } },
      { kind: "status", props: { state: "delivered" } },
    ])
    const ids = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      return Array.from(root?.querySelectorAll("clipPath") ?? [], (clip) => clip.id)
    })
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe("")
    expect(ids[0]).not.toBe(ids[1])
  }, 30_000)

  test("the meter has five bars for every dock state, and checking and unattached sit still and faint", async () => {
    const { page } = await openUi()
    await show(
      page,
      METER_KEYS.map((state) => ({ kind: "meter", props: { state } })),
    )
    const meters = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      return Array.from(root?.querySelectorAll("[data-item] svg") ?? [], (svg) => ({
        bars: svg.querySelectorAll(".mf").length,
        classes: Array.from(svg.classList),
      }))
    })
    expect(meters.map((meter) => meter.bars)).toEqual([5, 5, 5, 5, 5, 5])
    const byState = new Map(METER_KEYS.map((state, index) => [state, meters[index]?.classes ?? []]))
    for (const state of ["checking", "unattached"] as const) {
      expect(byState.get(state)).toContain("still")
      expect(byState.get(state)).toContain("faint")
    }
    for (const state of ["live", "busy", "gone", "delivered"] as const) {
      expect(byState.get(state)).not.toContain("faint")
    }
  }, 30_000)

  test("the Claude avatar draws the mark from the shared symbol; any other agent is a two-letter monogram", async () => {
    const { page } = await openUi()
    await show(page, [
      { kind: "avatar", props: { agent: "claude", size: 24 } },
      { kind: "avatar", props: { agent: "codex", size: 20 } },
    ])
    const result = await page.evaluate(() => {
      const root = document.getElementById("stage")?.shadowRoot
      const [claude, codex] = Array.from(root?.querySelectorAll("[role=img]") ?? [])
      const use = claude?.querySelector("use") as SVGGraphicsElement | null
      const target = use?.getAttribute("href")
      return {
        claudeName: claude?.getAttribute("aria-label"),
        codexName: codex?.getAttribute("aria-label"),
        codexText: codex?.textContent,
        symbolCount: root?.querySelectorAll("symbol#claude-mark").length,
        target,
        markPainted: (use?.getBBox().width ?? 0) > 0,
        codexHasMark: codex?.querySelector("use") !== null,
        claudeSize: claude ? getComputedStyle(claude).getPropertyValue("--s") : null,
        codexSize: codex ? getComputedStyle(codex).getPropertyValue("--s") : null,
      }
    })
    expect(result).toMatchObject({
      claudeName: "Claude",
      codexName: "codex",
      codexText: "co",
      symbolCount: 1,
      target: "#claude-mark",
      markPainted: true,
      codexHasMark: false,
      claudeSize: "24px",
      codexSize: "20px",
    })
  }, 30_000)
})

describe("the font assets", () => {
  test("both variable fonts and the licence are committed", async () => {
    for (const name of ["RedditSans-Variable.woff2", "JetBrainsMono-Variable.woff2"]) {
      const bytes = new Uint8Array(await Bun.file(new URL(name, FONT_ROOT)).arrayBuffer())
      expect(bytes.length).toBeGreaterThan(1000)
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("wOF2")
    }
    const licence = await Bun.file(new URL("OFL.txt", FONT_ROOT)).text()
    expect(licence).toContain("SIL OPEN FONT LICENSE")
    expect(licence).toContain("Reddit Sans")
    expect(licence).toContain("JetBrains Mono")
  })

  test("the build emits both fonts as hashed files under the asset path", () => {
    const fonts = assetFiles.filter((name) => name.endsWith(".woff2"))
    expect(fonts.map((name) => name.replace(/-[0-9a-z]+\.woff2$/, "")).sort()).toEqual([
      "JetBrainsMono-Variable",
      "RedditSans-Variable",
    ])
  })

  test("registerFonts adds both iter8 families with their weight ranges, loaded from the asset path, and touches no element", async () => {
    const { page, errors, fontRequests } = await openUi()
    const before = await page.evaluate(() => document.documentElement.outerHTML)
    await page.evaluate(() => {
      Reflect.set(window, "__records", [])
      new MutationObserver((records) => {
        ;(Reflect.get(window, "__records") as unknown[]).push(...records)
      }).observe(document, { childList: true, subtree: true, attributes: true })
      ;(Reflect.get(window, "__iter8Ui") as UiHarness).registerFonts()
    })
    const faces = await waitFor("both faces to load", async () => {
      const current = await page.evaluate(() =>
        Array.from(document.fonts, (face) => ({
          family: face.family.replaceAll('"', ""),
          weight: face.weight,
          status: face.status,
        })),
      )
      return current.length === 2 && current.every((face) => face.status === "loaded")
        ? current
        : null
    })
    expect(faces.sort((a, b) => a.family.localeCompare(b.family))).toEqual([
      { family: "iter8 JetBrains Mono", weight: "100 800", status: "loaded" },
      { family: "iter8 Reddit Sans", weight: "200 900", status: "loaded" },
    ])

    expect(fontRequests).toHaveLength(2)
    for (const path of fontRequests) {
      expect(path.startsWith(ASSET_PREFIX)).toBe(true)
    }
    expect(fontRequests.some((path) => path.includes("RedditSans-Variable"))).toBe(true)
    expect(fontRequests.some((path) => path.includes("JetBrainsMono-Variable"))).toBe(true)

    const after = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      records: (Reflect.get(window, "__records") as unknown[]).length,
      pending: (Reflect.get(window, "__rejections") as unknown[]).length,
    }))
    expect(after.html).toBe(before)
    expect(after.records).toBe(0)
    expect(after.pending).toBe(0)
    expect(errors).toEqual([])
  }, 30_000)

  test("a registered face is the one text in its family renders with", async () => {
    const { page } = await openUi()
    await page.evaluate(() => (Reflect.get(window, "__iter8Ui") as UiHarness).registerFonts())
    await waitFor("both faces to load", () =>
      page.evaluate(() =>
        Array.from(document.fonts).every((face) => face.status === "loaded") &&
        document.fonts.size === 2
          ? true
          : null,
      ),
    )
    const widths = await page.evaluate(() => {
      const width = (family: string) => {
        const span = document.createElement("span")
        span.style.cssText = `font:400 32px ${family};white-space:nowrap`
        span.textContent = "Wishing well, 1,000 times"
        document.body.append(span)
        const measured = span.getBoundingClientRect().width
        span.remove()
        return measured
      }
      return {
        sans: width('"iter8 Reddit Sans", sans-serif'),
        fallback: width("sans-serif"),
        mono: width('"iter8 JetBrains Mono", monospace'),
        monoFallback: width("monospace"),
      }
    })
    expect(widths.sans).not.toBe(widths.fallback)
    expect(widths.mono).not.toBe(widths.monoFallback)
  }, 30_000)

  test("a font file that fails to load leaves text in the system fallback and raises nothing", async () => {
    const { page, errors } = await openUi({ failFonts: true })
    await page.evaluate(() => (Reflect.get(window, "__iter8Ui") as UiHarness).registerFonts())
    await waitFor("both faces to fail", () =>
      page.evaluate(() =>
        document.fonts.size === 2 && Array.from(document.fonts).every((f) => f.status === "error")
          ? true
          : null,
      ),
    )
    await Bun.sleep(100)
    const result = await page.evaluate(() => {
      const width = (family: string) => {
        const span = document.createElement("span")
        span.style.cssText = `font:400 32px ${family};white-space:nowrap`
        span.textContent = "Wishing well, 1,000 times"
        document.body.append(span)
        const measured = span.getBoundingClientRect().width
        span.remove()
        return measured
      }
      return {
        sans: width('"iter8 Reddit Sans", sans-serif'),
        fallback: width("sans-serif"),
        mono: width('"iter8 JetBrains Mono", monospace'),
        monoFallback: width("monospace"),
        rejections: Reflect.get(window, "__rejections") as unknown[],
      }
    })
    expect(result.sans).toBe(result.fallback)
    expect(result.mono).toBe(result.monoFallback)
    expect(result.rejections).toEqual([])
    for (const error of errors) expect(error).toContain("Failed to load resource")
  }, 30_000)
})
