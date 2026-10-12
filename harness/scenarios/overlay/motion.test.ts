import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { ConversationMessage, Note, OverlayPrefs, Pairing, Round } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLayoutProbe } from "../../rig/layout"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const PAGE = "mockpage"
const DRAFT = Note.parse({ ...noteJson, pageId: PAGE })
const SENT = Round.parse({
  ...roundJson,
  pageId: PAGE,
  notes: roundJson.notes.map((note) => ({ ...note, pageId: PAGE })),
})
const SEEDED = { drafts: [DRAFT], rounds: [SENT], agentNotes: [] }
const TOUR_DONE = OverlayPrefs.parse({
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
})
const SPRING = "cubic-bezier(0.32, 1.42, 0.52, 1)"
const COMPOSITOR = ["transform", "translate", "scale", "rotate", "opacity", "visibility"]
const SHEET_FILES = 8
const MOVES = 30
const MAX_LAYOUTS = 2
const MIN_SETTLE_FRAMES = 15
/** Far enough from the tl anchor that the release sits outside the dock's 90 px snap pull. */
const RELEASE_OFFSET = { x: 120, y: 110 }
const SETTLED = { timeoutMs: 5000, everyMs: 100 }

let browser: Browser
let overlayBuild: Scratch
let opened: Awaited<ReturnType<typeof openOverlay>> | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

async function open() {
  opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE, pageState: SEEDED, prefs: TOUR_DONE },
    browser,
  })
  const o = opened
  await until("the dock to be ready", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  await dockAtRest(o.page)
  return o
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

const dock = (overlay: Locator) => overlay.getByRole("toolbar", { name: "iter8 annotation tools" })

function dockAtRest(page: Page) {
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
    SETTLED,
  )
}

function animationsDone(page: Page, selector: string) {
  return waitFor(
    `${selector} to finish animating`,
    () =>
      page.evaluate((selector) => {
        const el = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(selector)
        return el?.getAnimations().every((a) => a.playState === "finished") ? true : null
      }, selector),
    SETTLED,
  )
}

/** Puts the pointer on the dock's grip and presses it; moving by (dx, dy) moves the dock's corner by the same. */
async function grabDock(o: Awaited<ReturnType<typeof open>>) {
  const grip = dock(o.overlay).getByRole("button", { name: /^Session / })
  const box = await dock(o.overlay).boundingBox()
  const handle = await grip.boundingBox()
  const viewport = o.page.viewportSize()
  if (!box || !handle || !viewport) throw new Error("no dock to grab")
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await o.page.mouse.move(x, y)
  await o.page.mouse.down()
  const pointerFor = (cornerX: number, cornerY: number) => ({
    x: x + cornerX - box.x,
    y: y + cornerY - box.y,
  })
  return { box, viewport, pointerFor }
}

function dockBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".dock")
    if (!el) throw new Error("no dock")
    const rect = el.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  })
}

function inventory(page: Page) {
  return page.evaluate((allowedList) => {
    const root = document.querySelector("iter8-overlay")?.shadowRoot
    if (!root) throw new Error("no overlay")
    const allowed = new Set(allowedList)
    const timing = new Set([
      "ease",
      "ease-in",
      "ease-out",
      "ease-in-out",
      "linear",
      "step-start",
      "step-end",
      "normal",
      "allow-discrete",
    ])
    const cssWide = new Set(["initial", "inherit", "unset", "revert", "revert-layer"])
    const offenders = new Set<string>()
    let styleRules = 0
    let keyframes = 0
    // A shorthand holding var() leaves its longhands empty in the CSSOM, so read its text.
    const transitioned = (style: CSSStyleDeclaration): string[] => {
      const longhand = style.getPropertyValue("transition-property").trim()
      if (cssWide.has(longhand)) return []
      if (longhand) return longhand.split(",").map((part) => part.trim())
      let text = style.getPropertyValue("transition").trim()
      if (!text || cssWide.has(text)) return []
      while (/[\w-]+\([^()]*\)/.test(text)) text = text.replace(/[\w-]+\([^()]*\)/g, " ")
      return text.split(",").map(
        (item) =>
          item
            .trim()
            .split(/\s+/)
            .find((token) => /^-?[a-z][\w-]*$/i.test(token) && !timing.has(token)) ?? "all",
      )
    }
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule) {
          keyframes++
          for (const frame of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
            for (let i = 0; i < frame.style.length; i++) {
              const property = frame.style.item(i)
              if (property !== "animation-timing-function" && !allowed.has(property))
                offenders.add(`@keyframes ${rule.name} ${frame.keyText}: ${property}`)
            }
          }
          continue
        }
        if (rule instanceof CSSStyleRule) {
          styleRules++
          for (const property of transitioned(rule.style)) {
            if (property !== "none" && !allowed.has(property))
              offenders.add(`${rule.selectorText}: transition ${property}`)
          }
        }
        const nested = (rule as Partial<CSSGroupingRule>).cssRules
        if (nested) walk(nested)
      }
    }
    for (const sheet of root.adoptedStyleSheets) walk(sheet.cssRules)
    return {
      sheets: root.adoptedStyleSheets.length,
      styleRules,
      keyframes,
      offenders: [...offenders].sort(),
    }
  }, COMPOSITOR)
}

/** Records every animation in the shadow root, each frame, until stopped. */
async function watchAnimations(page: Page) {
  const key = `iter8-animations-${crypto.randomUUID()}`
  await page.evaluate((key) => {
    const root = document.querySelector("iter8-overlay")?.shadowRoot
    if (!root) throw new Error("no overlay")
    const seen = new Map<string, string[]>()
    const name = (target: Element | null) =>
      target ? [target.tagName.toLowerCase(), ...Array.from(target.classList)].join(".") : "?"
    const kebab = (property: string) => property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    let handle = 0
    const tick = () => {
      for (const animation of root.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null
        const where = name(effect?.target ?? null)
        if (animation instanceof CSSTransition) {
          seen.set(`${where} transition ${animation.transitionProperty}`, [
            animation.transitionProperty,
          ])
        } else if (animation instanceof CSSAnimation && effect) {
          const properties = new Set<string>()
          for (const frame of effect.getKeyframes()) {
            for (const property of Object.keys(frame)) {
              if (!["offset", "computedOffset", "easing", "composite"].includes(property))
                properties.add(kebab(property))
            }
          }
          seen.set(`${where} animation ${animation.animationName}`, [...properties])
        }
      }
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    Reflect.set(window, key, () => {
      cancelAnimationFrame(handle)
      Reflect.deleteProperty(window, key)
      return [...seen]
    })
  }, key)
  return {
    async stop() {
      const seen = await page.evaluate((key) => {
        const stop = Reflect.get(window, key) as () => [string, string[]][]
        return stop()
      }, key)
      const offenders = seen.flatMap(([label, properties]) =>
        properties.filter((p) => !COMPOSITOR.includes(p)).map((p) => `${label}: ${p}`),
      )
      return { seen: seen.map(([label]) => label), offenders: offenders.sort() }
    },
  }
}

/** Samples the dock's box and its laid-out left/top every frame until stopped. */
async function sampleDock(page: Page) {
  const key = `iter8-dock-samples-${crypto.randomUUID()}`
  await page.evaluate((key) => {
    const el = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".dock")
    if (!(el instanceof HTMLElement)) throw new Error("no dock")
    const samples: { x: number; y: number; left: number; top: number }[] = []
    let handle = 0
    const tick = () => {
      const rect = el.getBoundingClientRect()
      samples.push({ x: rect.left, y: rect.top, left: el.offsetLeft, top: el.offsetTop })
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    Reflect.set(window, key, () => {
      cancelAnimationFrame(handle)
      Reflect.deleteProperty(window, key)
      return samples
    })
  }, key)
  return {
    stop: () =>
      page.evaluate((key) => {
        const stop = Reflect.get(window, key) as () => {
          x: number
          y: number
          left: number
          top: number
        }[]
        return stop()
      }, key),
  }
}

/** Drags the dock off its br anchor and releases it beside tl; `arm` runs just before the release. */
async function releaseNearTopLeft<T>(
  o: Awaited<ReturnType<typeof open>>,
  arm: () => Promise<T>,
): Promise<{ released: { x: number; y: number }; armed: T }> {
  const { pointerFor } = await grabDock(o)
  const released = { x: 16 + RELEASE_OFFSET.x, y: 16 + RELEASE_OFFSET.y }
  const to = pointerFor(released.x, released.y)
  await o.page.mouse.move(to.x, to.y, { steps: 12 })
  await waitFor(
    "the dock to follow the pointer",
    async () => {
      const at = await dockBox(o.page)
      return Math.abs(at.x - released.x) < 1 ? true : null
    },
    SETTLED,
  )
  const armed = await arm()
  await o.page.mouse.up()
  return { released, armed }
}

async function adoptEverySheet(o: Awaited<ReturnType<typeof open>>) {
  const { page, overlay } = o
  await page.keyboard.press("r")
  const sheet = overlay.getByRole("complementary", { name: "Round sheet" })
  await until("the round sheet", () => sheet.isVisible())
  await sheet.getByRole("tab", { name: /^History/ }).click()
  await until("History", () => sheet.getByRole("tabpanel", { name: "History" }).isVisible())
  await sheet.getByRole("tab", { name: "Conversation" }).click()
  await until("Conversation", () =>
    sheet.getByRole("tabpanel", { name: "Conversation" }).isVisible(),
  )
  await page.keyboard.press("Escape")
  await until("the sheet to close", async () => !(await sheet.isVisible()))

  await page.keyboard.press("ControlOrMeta+K")
  const palette = overlay.getByRole("dialog", { name: "Command palette" })
  await until("the palette", () => palette.isVisible())
  await page.keyboard.press("Escape")
  await until("the palette to close", async () => !(await palette.isVisible()))

  await page.keyboard.press("s")
  await until("shot mode", async () => (await overlay.locator(".shotlayer").count()) === 1)
  await page.keyboard.press("Escape")
  await until("shot mode to end", async () => (await overlay.locator(".shotlayer").count()) === 0)

  await page.keyboard.press("c")
  await page.locator("#overview-heading").click()
  await until("the composer", () => overlay.locator(".composer.on").isVisible())
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
}

describe("motion: the stylesheets", () => {
  test("every rule and keyframe in every adopted sheet moves only compositor properties", async () => {
    const o = await open()
    await adoptEverySheet(o)
    const scan = await inventory(o.page)
    expect(scan.sheets).toBeGreaterThanOrEqual(SHEET_FILES)
    expect(scan.styleRules).toBeGreaterThan(100)
    expect(scan.keyframes).toBeGreaterThan(5)
    expect(scan.offenders).toEqual([])
  }, 60_000)
})

describe("motion: live animations", () => {
  test("opening the round sheet runs only compositor animations", async () => {
    const o = await open()
    const watch = await watchAnimations(o.page)
    await o.page.keyboard.press("r")
    await until("the round sheet", () =>
      o.overlay.getByRole("complementary", { name: "Round sheet" }).isVisible(),
    )
    await animationsDone(o.page, ".sheet")
    await dockAtRest(o.page)
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.includes("sheet-in"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)

  test("opening the palette runs only compositor animations", async () => {
    const o = await open()
    const watch = await watchAnimations(o.page)
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette", () =>
      o.overlay.getByRole("dialog", { name: "Command palette" }).isVisible(),
    )
    await animationsDone(o.page, ".palette")
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.includes("palette-in"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)

  test("a toast runs only compositor animations", async () => {
    const o = await open()
    const watch = await watchAnimations(o.page)
    await o.page.keyboard.press("p")
    await until("a toast", () => o.overlay.locator(".toast").first().isVisible())
    await animationsDone(o.page, ".toast")
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.includes("animation tin"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)

  test("closing the round sheet runs only compositor animations", async () => {
    const o = await open()
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.page.keyboard.press("r")
    await until("the round sheet", () => sheet.isVisible())
    await animationsDone(o.page, ".sheet")
    await dockAtRest(o.page)
    const watch = await watchAnimations(o.page)
    await o.page.keyboard.press("Escape")
    await until("the sheet to close", async () => !(await sheet.isVisible()))
    await dockAtRest(o.page)
    const { offenders } = await watch.stop()
    expect(offenders).toEqual([])
  }, 30_000)

  test("closing the palette runs only compositor animations", async () => {
    const o = await open()
    const palette = o.overlay.getByRole("dialog", { name: "Command palette" })
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette", () => palette.isVisible())
    await animationsDone(o.page, ".palette")
    const watch = await watchAnimations(o.page)
    await o.page.keyboard.press("Escape")
    await until("the palette to close", async () => !(await palette.isVisible()))
    const { offenders } = await watch.stop()
    expect(offenders).toEqual([])
  }, 30_000)

  test("a toast leaving runs only compositor animations", async () => {
    const o = await open()
    await o.page.keyboard.press("p")
    const toast = o.overlay.locator(".toast")
    await until("a toast", () => toast.first().isVisible())
    await animationsDone(o.page, ".toast")
    const watch = await watchAnimations(o.page)
    await until("the toast to leave", async () => (await toast.count()) === 0)
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.includes("animation tout"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)

  test("a pushed message and a sent one run only compositor animations", async () => {
    const message = (n: number) =>
      ConversationMessage.parse({
        ...agentJson,
        id: `M${n}`,
        pageId: PAGE,
        roundId: null,
        text: `Agent message ${n}`,
        at: new Date(Date.UTC(2026, 9, 9, 10, n)).toISOString(),
      })
    opened = await openOverlay({
      overlayDir: overlayBuild.path,
      folder: STATIC,
      mock: { pairing: LIVE, pageState: SEEDED, prefs: TOUR_DONE, messages: [message(1)] },
      browser,
    })
    const o = opened
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.page.keyboard.press("r")
    await until("the round sheet", () => sheet.isVisible())
    await sheet.getByRole("tab", { name: "Conversation" }).click()
    const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
    const rows = panel.getByRole("log").getByRole("article")
    await until("the first message", async () => (await rows.count()) === 1)
    await animationsDone(o.page, ".sheet")
    const watch = await watchAnimations(o.page)
    o.mock.pushMessage(message(2))
    await until("the pushed message", async () => (await rows.count()) === 2)
    await panel.getByRole("textbox", { name: /^Message / }).fill("Make the header sticky")
    await panel.getByRole("button", { name: "Send message" }).click()
    await until("the sent message", async () => (await rows.count()) === 3)
    await animationsDone(o.page, ".cv-msg.mine")
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.endsWith("animation cv-in"))).toBe(true)
    expect(seen.some((label) => label.endsWith("animation cv-in-own"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)

  test("dragging the dock to another anchor runs only compositor animations", async () => {
    const o = await open()
    const watch = await watchAnimations(o.page)
    await releaseNearTopLeft(o, async () => undefined)
    await until("the saved anchor", () => o.mock.prefs().dock === "tl")
    await dockAtRest(o.page)
    const { seen, offenders } = await watch.stop()
    expect(seen.some((label) => label.startsWith("div.dock"))).toBe(true)
    expect(offenders).toEqual([])
  }, 30_000)
})

describe("motion: layout per move", () => {
  test("the dock settles to a new anchor over at least 15 frames with at most 2 layouts", async () => {
    const o = await open()
    const { armed } = await releaseNearTopLeft(o, async () => ({
      layout: await startLayoutProbe(o.page),
      frames: await startFrameProbe(o.page),
    }))
    let layouts: number | undefined
    let frames: number | undefined
    try {
      await waitFor(
        "the saved anchor",
        async () => (o.mock.prefs().dock === "tl" ? true : null),
        SETTLED,
      )
      await dockAtRest(o.page)
    } finally {
      layouts = (await armed.layout.stop()).layouts
      frames = (await armed.frames.stop()).intervals.length
    }
    expect(layouts).toBeLessThanOrEqual(MAX_LAYOUTS)
    expect(frames).toBeGreaterThanOrEqual(MIN_SETTLE_FRAMES)
  }, 30_000)

  test("a 30-move dock drag lays out at most twice", async () => {
    const o = await open()
    const { box, viewport, pointerFor } = await grabDock(o)
    const corner = {
      x: Math.round((viewport.width - box.width) / 2),
      y: Math.round(viewport.height / 2 - box.height / 2),
    }
    const to = pointerFor(corner.x, corner.y)
    const layout = await startLayoutProbe(o.page)
    let layouts: number | undefined
    try {
      await o.page.mouse.move(to.x, to.y, { steps: MOVES })
      await waitFor(
        "the dock to reach the pointer",
        async () => {
          const at = await dockBox(o.page)
          return Math.abs(at.x - corner.x) < 1 ? true : null
        },
        SETTLED,
      )
    } finally {
      layouts = (await layout.stop()).layouts
    }
    await o.page.mouse.up()
    expect(layouts).toBeLessThanOrEqual(MAX_LAYOUTS)
  }, 30_000)

  async function enterShotMode(o: Awaited<ReturnType<typeof open>>) {
    await o.page.keyboard.press("s")
    await until("shot mode", async () => (await o.overlay.locator(".shotlayer.on").count()) === 1)
    await animationsDone(o.page, ".shotlayer")
  }

  function crosshairAt(page: Page, x: number, y: number) {
    return waitFor(
      `the crosshair at ${x}, ${y}`,
      () =>
        page.evaluate(
          ({ x, y }) => {
            const root = document.querySelector("iter8-overlay")?.shadowRoot
            const vertical = root?.querySelector(".xh.v")?.getBoundingClientRect()
            const horizontal = root?.querySelector(".xh.h")?.getBoundingClientRect()
            if (!vertical || !horizontal) return null
            return Math.abs(vertical.left - x) < 1 && Math.abs(horizontal.top - y) < 1 ? true : null
          },
          { x, y },
        ),
      SETTLED,
    )
  }

  test("the screenshot crosshair follows 30 pointer moves with at most 2 layouts", async () => {
    const o = await open()
    await enterShotMode(o)
    await o.page.mouse.move(200, 200)
    await crosshairAt(o.page, 200, 200)
    const layout = await startLayoutProbe(o.page)
    let layouts: number | undefined
    try {
      await o.page.mouse.move(520, 410, { steps: MOVES })
      await crosshairAt(o.page, 520, 410)
    } finally {
      layouts = (await layout.stop()).layouts
    }
    expect(layouts).toBeLessThanOrEqual(MAX_LAYOUTS)
  }, 30_000)

  test("dragging a screenshot region over 30 moves draws the selection with at most 2 layouts", async () => {
    const o = await open()
    await enterShotMode(o)
    await o.page.mouse.move(200, 200)
    await crosshairAt(o.page, 200, 200)
    await o.page.mouse.down()
    const layout = await startLayoutProbe(o.page)
    let layouts: number | undefined
    try {
      await o.page.mouse.move(520, 410, { steps: MOVES })
      await crosshairAt(o.page, 520, 410)
    } finally {
      layouts = (await layout.stop()).layouts
    }
    const drawn = await o.page.evaluate(() => {
      const selection = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".xsel")
      if (!selection || getComputedStyle(selection).visibility === "hidden") return null
      const boxes = [selection, ...Array.from(selection.querySelectorAll("*"))]
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.width > 0 || rect.height > 0)
      return {
        left: Math.min(...boxes.map((rect) => rect.left)),
        top: Math.min(...boxes.map((rect) => rect.top)),
        right: Math.max(...boxes.map((rect) => rect.right)),
        bottom: Math.max(...boxes.map((rect) => rect.bottom)),
      }
    })
    await o.page.mouse.up()
    expect(layouts).toBeLessThanOrEqual(MAX_LAYOUTS)
    expect(drawn?.left).toBeCloseTo(200, 0)
    expect(drawn?.top).toBeCloseTo(200, 0)
    expect(drawn?.right).toBeCloseTo(520, 0)
    expect(drawn?.bottom).toBeCloseTo(410, 0)
  }, 30_000)
})

describe("motion: the spring", () => {
  test("the dock settles by translate along the spring, overshooting before it rests", async () => {
    const o = await open()
    const { released, armed: sampler } = await releaseNearTopLeft(o, () => sampleDock(o.page))
    await until("the saved anchor", () => o.mock.prefs().dock === "tl")
    await dockAtRest(o.page)
    const samples = await sampler.stop()
    const rest = { x: 16, y: 16 }
    const travel = { x: rest.x - released.x, y: rest.y - released.y }
    const length = Math.hypot(travel.x, travel.y)
    const past = samples.map(
      (s) => ((s.x - rest.x) * travel.x + (s.y - rest.y) * travel.y) / length,
    )
    const last = samples.at(-1)
    const moving = new Set(samples.map((s) => `${s.x.toFixed(1)},${s.y.toFixed(1)}`))

    expect(Math.max(...past)).toBeGreaterThan(1)
    expect(Math.abs((last?.x ?? 0) - rest.x)).toBeLessThanOrEqual(1)
    expect(Math.abs((last?.y ?? 0) - rest.y)).toBeLessThanOrEqual(1)
    expect(moving.size).toBeGreaterThanOrEqual(MIN_SETTLE_FRAMES)
    expect(new Set(samples.map((s) => `${s.left},${s.top}`)).size).toBe(1)

    const position = await dock(o.overlay).evaluate((el) => {
      const style = getComputedStyle(el)
      const properties = style.transitionProperty.split(",").map((p) => p.trim())
      const timings = style.transitionTimingFunction.split(/,\s*(?![^()]*\))/)
      const at = properties.indexOf("translate")
      return { at, timing: timings[at]?.trim() }
    })
    expect(position.at).toBeGreaterThanOrEqual(0)
    expect(position.timing).toBe(SPRING)
  }, 30_000)
})

describe("motion: reduced motion", () => {
  test("with reduced motion every element shows its resting state and nothing animates", async () => {
    const o = await open()
    await o.page.keyboard.press("r")
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await until("the round sheet", () => sheet.isVisible())
    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("History", () => sheet.getByRole("tabpanel", { name: "History" }).isVisible())
    const snapshot = () =>
      o.page.evaluate(async () => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        if (!root) throw new Error("no overlay")
        const finite = root
          .getAnimations()
          .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)))
        const endless = new Set(
          root
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().endTime === Infinity)
            .map((animation) => (animation.effect as KeyframeEffect | null)?.target),
        )
        const glyphs = Array.from(root.querySelectorAll(".sg *, .meter *"))
        return glyphs.map((el, index) => {
          const style = getComputedStyle(el)
          return {
            index,
            endless: endless.has(el),
            rest: [
              style.opacity,
              style.transform,
              style.translate,
              style.scale,
              style.strokeDashoffset,
            ].join(" | "),
          }
        })
      })
    const animated = await snapshot()
    expect(animated.some((glyph) => !glyph.endless)).toBe(true)

    await o.page.emulateMedia({ reducedMotion: "reduce" })
    const still = await snapshot()
    const finishedRest = animated
      .filter((glyph) => !glyph.endless)
      .map(({ index, rest }) => [index, rest])
    expect(
      still
        .filter((glyph) => !animated[glyph.index]?.endless)
        .map(({ index, rest }) => [index, rest]),
    ).toEqual(finishedRest)
    const running = await o.page.evaluate(() =>
      (document.querySelector("iter8-overlay")?.shadowRoot?.getAnimations() ?? [])
        .filter((animation) => animation instanceof CSSAnimation)
        .map((animation) => (animation as CSSAnimation).animationName),
    )
    expect(running).toEqual([])

    await o.page.keyboard.press("Escape")
    await until("the sheet to close", async () => !(await sheet.isVisible()))
    await dockAtRest(o.page)
    const watch = await watchAnimations(o.page)
    const { released, armed: sampler } = await releaseNearTopLeft(o, () => sampleDock(o.page))
    await until("the saved anchor", () => o.mock.prefs().dock === "tl")
    await dockAtRest(o.page)
    const samples = await sampler.stop()
    const { seen } = await watch.stop()
    const durations = await dock(o.overlay).evaluate((el) =>
      getComputedStyle(el)
        .transitionDuration.split(",")
        .map((d) => d.trim()),
    )
    const rest = { x: 16, y: 16 }
    const travel = { x: rest.x - released.x, y: rest.y - released.y }
    const length = Math.hypot(travel.x, travel.y)
    const past = samples.map(
      (s) => ((s.x - rest.x) * travel.x + (s.y - rest.y) * travel.y) / length,
    )
    const left = samples.findIndex((s) => Math.abs(s.x - released.x) > 1)
    const atRest = (s: { x: number; y: number }) =>
      Math.abs(s.x - rest.x) <= 1 && Math.abs(s.y - rest.y) <= 1

    expect(seen.filter((label) => label.includes(" animation "))).toEqual([])
    expect(durations.every((d) => d === "0.001s")).toBe(true)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(Math.max(...past)).toBeLessThanOrEqual(1)
    expect(samples.slice(left + 1).every(atRest)).toBe(true)
  }, 60_000)
})
