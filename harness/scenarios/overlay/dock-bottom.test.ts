import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { OVERLAY_ROUTES, type OverlayPrefs, Pairing, TOKEN_HEADER } from "@iter8/protocol"
import { type Browser, chromium, type Locator, type Page } from "playwright"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const LIVE = Pairing.parse(pairingJson)
const TEST_MS = 60_000
const PAGE_PADDING = "12px"
const PREFS: OverlayPrefs = {
  theme: "light",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
}

const PAGE_HTML = `<!doctype html>
<html lang="en" style="padding-bottom:${PAGE_PADDING}">
<head>
<meta charset="utf-8">
<title>Dock bottom</title>
<style>
  html::-webkit-scrollbar { width: 15px }
  html::-webkit-scrollbar-thumb { background: #999 }
  body { margin: 0; background: #fff }
  #tall { height: 1600px; background: #fff }
  #last { height: 60px; background: #fde68a }
</style>
</head>
<body><div id="tall"></div><div id="last"></div></body>
</html>
`

let browser: Browser
let overlayBuild: Scratch
let site: Scratch
let opened: Opened | null = null

type Opened = Awaited<ReturnType<typeof openOverlay>>
type Rect = { x: number; y: number; w: number; h: number }

beforeAll(async () => {
  // Headless Playwright hides scrollbars, and the bar must be shown stopping short of a real one.
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] })
  overlayBuild = await buildOverlay()
  site = await scratchDir(`${SCRATCH_ROOT}dock-bottom-`)
  await writeFile(join(site.path, "index.html"), PAGE_HTML)
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await site?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 8000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open(prefs: Partial<OverlayPrefs> = {}) {
  opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: site.path,
    mock: { prefs: { ...PREFS, ...prefs }, pairing: LIVE },
    browser,
  })
  await ready(opened)
  return opened
}

async function ready(o: Opened) {
  await until("the dock to be ready", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  await atRest(o.page)
}

/** Playwright's stability check passes on the first frames of a compositor animation, which still show the old box. */
function atRest(page: Page) {
  return waitFor(
    "the dock to come to rest",
    () =>
      page.evaluate(() => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        const moving = [root?.querySelector(".dock"), root?.querySelector(".iter8btn")].some(
          (el) => !el || el.getAnimations().some((a) => a.playState !== "finished"),
        )
        return moving ? null : true
      }),
    { timeoutMs: 5000, everyMs: 100 },
  )
}

const dock = (o: Opened) => o.overlay.getByRole("toolbar", { name: "iter8 annotation tools" })
const edgeChoice = (o: Opened) => o.overlay.getByRole("radiogroup", { name: "Dock to" })

async function chooseEdge(o: Opened, label: "Float" | "Bottom") {
  const group = edgeChoice(o)
  if (!(await group.isVisible()))
    await dock(o).getByRole("button", { name: "More options" }).click()
  await group.locator("label").filter({ hasText: label }).click()
  await atRest(o.page)
}

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
}

const htmlPadding = (page: Page) =>
  page.evaluate(() => document.documentElement.style.paddingBottom)

const viewport = (page: Page) =>
  page.evaluate(() => ({
    inner: { w: window.innerWidth, h: window.innerHeight },
    client: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
  }))

describe("docking to the bottom", () => {
  test(
    "Bottom turns the dock into a full-width compact bar, the page makes room, and Float puts everything back",
    async () => {
      const o = await open()
      const view = await viewport(o.page)
      expect(view.inner.w, "the fixture shows a classic scrollbar").toBeGreaterThan(view.client.w)
      expect(await htmlPadding(o.page)).toBe(PAGE_PADDING)
      const floating = await rectOf(dock(o))

      await chooseEdge(o, "Bottom")
      const bar = await rectOf(dock(o))
      expect(bar.x).toBe(0)
      expect(bar.w).toBe(view.client.w)
      expect(bar.y + bar.h).toBe(view.client.h)
      expect(bar.h).toBeGreaterThan(30)
      expect(bar.h).toBeLessThanOrEqual(46)
      const radius = await dock(o).evaluate((el) => getComputedStyle(el).borderTopLeftRadius)
      expect(radius).toBe("0px")
      expect(await htmlPadding(o.page)).toBe(`${bar.h}px`)
      await until("the choice to be saved", () => o.mock.prefs().dockEdge === "bottom")

      await o.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const last = await o.page.evaluate(() => {
        const r = document.getElementById("last")?.getBoundingClientRect()
        return r ? { bottom: r.bottom } : null
      })
      expect(last?.bottom).toBeLessThanOrEqual(bar.y)

      for (const name of ["Pick element", "Draw region", "Screenshot", "Send"]) {
        const control = await rectOf(dock(o).getByRole("button", { name, exact: true }))
        expect(control.h, name).toBeGreaterThanOrEqual(28)
      }
      const counter = await rectOf(dock(o).getByRole("button", { name: "Open round sheet" }))
      expect(counter.h).toBeGreaterThanOrEqual(28)

      await chooseEdge(o, "Float")
      expect(await htmlPadding(o.page)).toBe(PAGE_PADDING)
      const back = await rectOf(dock(o))
      for (const key of ["x", "y", "w", "h"] as const)
        expect(Math.abs(back[key] - floating[key]), key).toBeLessThan(1)
      await until("the choice to be saved", () => o.mock.prefs().dockEdge === "float")
    },
    TEST_MS,
  )

  test(
    "the bar does not drag",
    async () => {
      const o = await open({ dockEdge: "bottom" })
      const before = await rectOf(dock(o))
      const grip = await rectOf(dock(o).getByRole("button", { name: /^Session larkspur/ }))
      await o.page.mouse.move(grip.x + grip.w / 2, grip.y + grip.h / 2)
      await o.page.mouse.down()
      await o.page.mouse.move(300, 100, { steps: 10 })
      await o.page.mouse.up()
      expect(await rectOf(dock(o))).toEqual(before)
      expect(o.mock.prefs().dock).toBe("br")
    },
    TEST_MS,
  )

  test(
    "collapsing removes the room and shows the button at the bottom right, and expanding brings the bar back",
    async () => {
      const o = await open({ dockEdge: "bottom" })
      const bar = await rectOf(dock(o))
      expect(await htmlPadding(o.page)).toBe(`${bar.h}px`)

      await dock(o).getByRole("button", { name: "Collapse dock" }).click()
      await atRest(o.page)
      expect(await htmlPadding(o.page)).toBe(PAGE_PADDING)
      const button = o.overlay.getByRole("button", { name: "Expand iter8 dock" })
      await button.waitFor({ state: "visible" })
      const at = await rectOf(button)
      const view = await viewport(o.page)
      expect(view.client.w - (at.x + at.w)).toBeLessThanOrEqual(24)
      expect(view.client.h - (at.y + at.h)).toBeLessThanOrEqual(24)
      expect(at.x).toBeGreaterThan(view.client.w / 2)
      expect(at.y).toBeGreaterThan(view.client.h / 2)

      await button.click()
      await atRest(o.page)
      expect(await htmlPadding(o.page)).toBe(`${bar.h}px`)
      expect(await rectOf(dock(o))).toEqual(bar)
    },
    TEST_MS,
  )

  test(
    "the choice survives a reload",
    async () => {
      const o = await open()
      await chooseEdge(o, "Bottom")
      await until("the choice to be saved", () => o.mock.prefs().dockEdge === "bottom")

      await o.page.reload()
      await ready(o)
      const view = await viewport(o.page)
      const bar = await rectOf(dock(o))
      expect(bar.w).toBe(view.client.w)
      expect(bar.y + bar.h).toBe(view.client.h)
      expect(await htmlPadding(o.page)).toBe(`${bar.h}px`)
      await dock(o).getByRole("button", { name: "More options" }).click()
      expect(await edgeChoice(o).getByRole("radio", { name: "Bottom" }).isChecked()).toBe(true)
    },
    TEST_MS,
  )

  test(
    "a region screenshot taken over the bar holds only the page",
    async () => {
      const o = await open({ dockEdge: "bottom", theme: "dark" })
      const view = await viewport(o.page)
      await o.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      const end = { x: view.inner.w - 4, y: view.client.h - 4 }
      const region = {
        x: 60,
        y: view.client.h - 110,
        w: end.x - 60,
        h: end.y - (view.client.h - 110),
      }

      await o.overlay.getByRole("button", { name: "Draw region" }).click()
      await o.page.mouse.move(region.x, region.y)
      await o.page.mouse.down()
      await o.page.mouse.move(end.x, end.y, { steps: 6 })
      await o.page.mouse.up()
      const composer = o.overlay.getByRole("dialog", { name: "New note" })
      await composer.waitFor({ timeout: 10_000 })
      await composer.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 15_000 })
      await o.overlay.getByRole("textbox", { name: "Note" }).fill("Over the bar")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the screenshot on the draft", () => {
        return o.mock.draft()[0]?.capture?.screenshot !== undefined
      })

      const ref = o.mock.draft()[0]?.capture?.screenshot?.ref
      if (!ref) throw new Error("the saved draft has no screenshot")
      const shot = await o.page.evaluate(
        async ({ path, header, token }) => {
          const response = await fetch(path, { headers: { [header]: token } })
          const bitmap = await createImageBitmap(await response.blob())
          const canvas = document.createElement("canvas")
          canvas.width = bitmap.width
          canvas.height = bitmap.height
          const pen = canvas.getContext("2d")
          if (!pen) throw new Error("no 2d canvas")
          pen.drawImage(bitmap, 0, 0)
          const { data } = pen.getImageData(0, 0, bitmap.width, bitmap.height)
          let leastRed = 255
          for (let at = 0; at < data.length; at += 4)
            if ((data[at + 3] ?? 0) > 200) leastRed = Math.min(leastRed, data[at] ?? 255)
          return { width: bitmap.width, height: bitmap.height, leastRed }
        },
        {
          path: OVERLAY_ROUTES.getScreenshot.path.replace(":ref", ref),
          header: TOKEN_HEADER,
          token: o.mock.token,
        },
      )
      expect([shot.width, shot.height]).toEqual([view.client.w - region.x, region.h])
      expect(shot.leastRed, "the dark bar would show as pixels with little red").toBeGreaterThan(
        200,
      )
    },
    TEST_MS,
  )

  test(
    "holding Alt in pick mode over the bar picks the Dock part with the bar's own box",
    async () => {
      const o = await open({ dockEdge: "bottom" })
      await o.page.keyboard.press("c")
      await until(
        "pick mode",
        async () =>
          (await o.overlay
            .getByRole("button", { name: "Pick element" })
            .getAttribute("aria-pressed")) === "true",
      )
      await o.page.keyboard.down("Alt")
      const bar = await rectOf(dock(o))
      await o.page.mouse.move(bar.x + bar.w / 2, bar.y + bar.h / 2)
      const ring = o.overlay.locator(".layer.pick .ring")
      await until("the highlight to settle on the bar", async () => {
        const drawn = await rectOf(ring)
        return (["x", "y", "w", "h"] as const).every((key) => Math.abs(drawn[key] - bar[key]) < 1)
      })
      await until("the chip to name the part", async () =>
        ((await o.overlay.locator(".layer.pick .chip").textContent()) ?? "").includes("Dock"),
      )
    },
    TEST_MS,
  )
})

describe("the collapse glyph", () => {
  const A2 = [
    "M4 4l6 6",
    "M4.5 10H10V4.5",
    "M14 12h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z",
  ]

  async function glyph(o: Opened) {
    return o.overlay
      .getByRole("button", { name: "Collapse dock" })
      .locator("svg")
      .evaluate((svg) => {
        const ink = svg.querySelectorAll(":scope > g")[1]
        const paths = Array.from(ink?.querySelectorAll("path") ?? [])
        const centre = (el: Element) => {
          const r = el.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        }
        const arrow = paths[0] ? centre(paths[0]) : null
        const square = paths[2] ? centre(paths[2]) : null
        return {
          d: paths.map((path) => path.getAttribute("d")),
          stroke: ink ? getComputedStyle(ink).strokeWidth : null,
          towards:
            arrow && square
              ? {
                  right: square.x > arrow.x,
                  down: square.y > arrow.y,
                }
              : null,
        }
      })
  }

  const CORNERS = [
    ["br", { right: true, down: true }],
    ["bl", { right: false, down: true }],
    ["tr", { right: true, down: false }],
    ["tl", { right: false, down: false }],
  ] as const

  for (const [dockAnchor, expected] of CORNERS) {
    test(
      `draws the shrink-to-the-corner paths and points at the ${dockAnchor} corner`,
      async () => {
        const o = await open({ dock: dockAnchor })
        const drawn = await glyph(o)
        expect(drawn.d).toEqual(A2)
        expect(drawn.towards).toEqual(expected)
      },
      TEST_MS,
    )
  }

  test(
    "points at the bottom right while docked, wherever the floating dock was left",
    async () => {
      const o = await open({ dock: "tl", dockEdge: "bottom" })
      const drawn = await glyph(o)
      expect(drawn.d).toEqual(A2)
      expect(drawn.towards).toEqual({ right: true, down: true })
    },
    TEST_MS,
  )
})

describe("the iter8 label in the note composer", () => {
  function channel(value: string): number {
    const c = Number(value) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  function luminance(color: string): number {
    const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number)
    return 0.2126 * channel(String(r)) + 0.7152 * channel(String(g)) + 0.0722 * channel(String(b))
  }

  test(
    "is readable in dark mode: at least 4.5:1 against its header",
    async () => {
      const o = await open({ theme: "dark" })
      await o.page.keyboard.press("c")
      await o.page.keyboard.down("Alt")
      const ring = o.overlay.locator('[data-iter8-part="dock.ring"]:visible')
      const box = await rectOf(ring)
      await o.page.mouse.move(box.x + box.w / 2, box.y + box.h / 2)
      await until("the highlight to settle on the ring", async () => {
        const drawn = await rectOf(o.overlay.locator(".layer.pick .ring"))
        return (["x", "y", "w", "h"] as const).every((key) => Math.abs(drawn[key] - box[key]) < 1)
      })
      await o.page.mouse.click(box.x + box.w / 2, box.y + box.h / 2)
      const label = o.overlay.locator(".cmp-h .comp")
      await label.waitFor({ state: "visible" })
      expect(await label.textContent()).toBe("iter8")

      const colors = await label.evaluate((el) => ({
        text: getComputedStyle(el).color,
        background: getComputedStyle(el.closest(".cmp-h") ?? el).backgroundColor,
      }))
      expect(colors.background).not.toContain("rgba")
      const [light, dark] = [luminance(colors.text), luminance(colors.background)].sort(
        (a, b) => b - a,
      ) as [number, number]
      expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(4.5)
    },
    TEST_MS,
  )
})
