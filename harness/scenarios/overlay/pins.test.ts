import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type ElementAnchor, Note, OVERLAY_ROUTES, Pairing, Round } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import unanchoredJson from "../../../packages/protocol/fixtures/Note.unanchored.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const PUT_DRAFT = new RegExp(`${OVERLAY_ROUTES.putDraft.path.replace(":noteId", "[^/]+")}$`)

type Target = Pick<ElementAnchor, "selector" | "role" | "text"> & Partial<ElementAnchor>

function anchor(target: Target): ElementAnchor {
  return {
    box: { x: 0, y: 0, width: 100, height: 30 },
    renderGeneration: 0,
    ...target,
  }
}

function draft(id: string, target: Target, extra: Record<string, unknown> = {}) {
  return Note.parse({
    ...noteJson,
    id,
    pageId: "mockpage",
    target: { kind: "element", anchor: anchor(target) },
    ...extra,
  })
}

function agentNote(id: string, target: Target, extra: Record<string, unknown> = {}) {
  return Note.parse({
    ...unanchoredJson,
    id,
    pageId: "mockpage",
    anchorStatus: "anchored",
    target: { kind: "element", anchor: anchor(target) },
    ...extra,
  })
}

const OVERVIEW = { selector: ["h2#overview-heading"], role: "heading", text: "Overview" }
const DETAILS = { selector: ["h2#details-heading"], role: "heading", text: "Details" }
const CARD = { selector: ['p[data-source-target="card"]'], text: "Card in static" }
const GONE_AGENT = { selector: ["aside.missing-panel"], text: "Docs" }

const seed = (drafts: Note[] = [], agentNotes: Note[] = []) => ({
  pairing: LIVE,
  pageState: { drafts, rounds: [], agentNotes },
})

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

async function open(mock: Parameters<typeof openOverlay>[0]["mock"] = {}) {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, mock, browser })
  return opened
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

type Opened = Awaited<ReturnType<typeof open>>

/** A pushed message reaches only an open socket, so push until its effect shows. */
async function pushUntil(
  o: Opened,
  message: Parameters<Opened["mock"]["push"]>[0],
  done: () => Promise<boolean>,
) {
  await waitFor(
    "the pushed message to take effect",
    async () => {
      o.mock.push(message)
      return (await done()) ? true : null
    },
    { timeoutMs: 8000, everyMs: 100 },
  )
}

const pinNamed = (overlay: Locator, name: string) => overlay.getByRole("button", { name })
const movedList = (overlay: Locator) => overlay.getByRole("list", { name: "Moved notes" })
const unanchoredList = (overlay: Locator) => overlay.getByRole("list", { name: "Unanchored notes" })

async function centre(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("no bounding box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function rectOf(page: Page, selector: string) {
  return page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) throw new Error(`nothing matches ${css}`)
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }, selector)
}

type ScrollRead = {
  scrolled: number
  pin: { x: number; y: number }
  target: { left: number; top: number }
}

/**
 * Scrolls the window or `scroller` to `to`, then reads the pin's centre and its element's corner:
 * at once with `when: "same frame"`, or in the first animation frame after the scroll event.
 */
function scrollAndRead(
  page: Page,
  opts: {
    pin: string
    target: string
    scroller: string | null
    to: number
    when: "same frame" | "next frame"
  },
): Promise<ScrollRead> {
  return page.evaluate(({ pin, target, scroller, to, when }) => {
    const box = scroller === null ? null : document.querySelector(scroller)
    const read = (): ScrollRead => {
      const node = document
        .querySelector("iter8-overlay")
        ?.shadowRoot?.querySelector(`[aria-label="${pin}"]`)
      const el = document.querySelector(target)
      if (!node || !el) throw new Error(`no pin ${pin} or no element ${target}`)
      const p = node.getBoundingClientRect()
      const t = el.getBoundingClientRect()
      return {
        scrolled: box === null ? window.scrollY : box.scrollTop,
        pin: { x: p.left + p.width / 2, y: p.top + p.height / 2 },
        target: { left: t.left, top: t.top },
      }
    }
    const scroll = () => {
      if (box === null) window.scrollTo(0, to)
      else box.scrollTop = to
    }
    if (when === "same frame") {
      scroll()
      return read()
    }
    return new Promise<ScrollRead>((resolve) => {
      window.addEventListener("scroll", () => requestAnimationFrame(() => resolve(read())), {
        capture: true,
        once: true,
      })
      scroll()
    })
  }, opts)
}

function expectOnCorner(read: ScrollRead) {
  expect(Math.abs(read.pin.x - (read.target.left + 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(read.pin.y - (read.target.top + 2))).toBeLessThanOrEqual(2)
}

type Step = { x: number; y: number }
type PinPair = { pin: string; target: string }
type PairRead = { pin: { x: number; y: number }; target: { left: number; top: number } }
type StepRead = { scrollX: number; scrollY: number; scrolled: PairRead[]; replaced: PairRead[] }

/**
 * Scrolls the window to each step in turn. Every pin and its element are read synchronously after
 * the scroll, then again after a resize event has made the overlay place every pin from the
 * scrolled position, which is where a wrong scrollX or scrollY offset shows.
 */
function scrollStepsAndRead(page: Page, steps: Step[], pairs: PinPair[]): Promise<StepRead[]> {
  return page.evaluate(
    async ({ steps, pairs }) => {
      const root = document.querySelector("iter8-overlay")?.shadowRoot
      const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))
      const readPairs = (): PairRead[] =>
        pairs.map(({ pin, target }) => {
          const node = root?.querySelector(`[aria-label="${pin}"]`)
          const el = document.querySelector(target)
          if (!node || !el) throw new Error(`no pin ${pin} or no element ${target}`)
          const p = node.getBoundingClientRect()
          const t = el.getBoundingClientRect()
          return {
            pin: { x: p.left + p.width / 2, y: p.top + p.height / 2 },
            target: { left: t.left, top: t.top },
          }
        })
      const reads: StepRead[] = []
      for (const step of steps) {
        window.scrollTo(step.x, step.y)
        const scrolled = readPairs()
        window.dispatchEvent(new Event("resize"))
        await nextFrame()
        await nextFrame()
        reads.push({
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          scrolled,
          replaced: readPairs(),
        })
      }
      return reads
    },
    { steps, pairs },
  )
}

function expectPairOnCorner(pair: PairRead) {
  expect(Math.abs(pair.pin.x - (pair.target.left + 2))).toBeLessThanOrEqual(2)
  expect(Math.abs(pair.pin.y - (pair.target.top + 2))).toBeLessThanOrEqual(2)
}

const WIDE_A = { selector: ["p#wide-a"], text: "Wide A" }
const WIDE_B = { selector: ["p#wide-b"], text: "Wide B" }
const WIDE_C = { selector: ["p#wide-c"], text: "Wide C" }
const WIDE_PAGE = { width: 3200, height: 2000 }
const AT = {
  "p#wide-a": { left: 1600, top: 500 },
  "p#wide-b": { left: 2400, top: 900 },
  "p#wide-c": { left: 200, top: 1300 },
} as const

/** Makes the page wider and taller than the viewport and puts three targets at known page spots. */
function injectWide(page: Page) {
  return page.evaluate(
    ({ extent, spots }) => {
      const spacer = document.createElement("div")
      spacer.style.cssText = `position: absolute; left: 0; top: 0; width: ${extent.width}px; height: ${extent.height}px; visibility: hidden; pointer-events: none`
      document.body.append(spacer)
      for (const [selector, at] of Object.entries(spots)) {
        const p = document.createElement("p")
        p.id = selector.slice(2)
        p.textContent = `Wide ${selector.slice(-1).toUpperCase()}`
        p.style.cssText = `position: absolute; left: ${at.left}px; top: ${at.top}px; margin: 0; white-space: nowrap`
        document.body.append(p)
      }
    },
    { extent: WIDE_PAGE, spots: AT },
  )
}

async function openWide(notes: Note[]) {
  const o = await open(seed(notes))
  await o.page.setViewportSize({ width: 1280, height: 300 })
  await injectWide(o.page)
  const pins = o.overlay.getByRole("button", { name: /^Note \d+, / })
  await until("every pin", async () => (await pins.count()) === notes.length)
  return o
}

function expectFollowed(steps: Step[], reads: StepRead[], targets: (keyof typeof AT)[]) {
  expect(reads).toHaveLength(steps.length)
  reads.forEach((read, i) => {
    expect(steps[i]).toEqual({ x: read.scrollX, y: read.scrollY })
    for (const pairs of [read.scrolled, read.replaced])
      pairs.forEach((pair, j) => {
        const spot = AT[targets[j] ?? "p#wide-a"]
        expect(pair.target).toEqual({
          left: spot.left - read.scrollX,
          top: spot.top - read.scrollY,
        })
        expectPairOnCorner(pair)
      })
  })
}

const FIXED_BAR = { selector: ["p#fixed-target"], text: "Fixed bar label" }
const IN_SCROLLER = { selector: ["p#scroller-target"], text: "Inside the scroller" }
const STICKY = { selector: ["p#sticky-target"], text: "Sticky heading" }
const RIGHT_EDGE = { selector: ["p#edge-right"], text: "Right edge" }
const BOTTOM_EDGE = { selector: ["p#edge-bottom"], text: "Bottom edge" }

/** Adds a fixed bar, an element scroll container and a sticky element, each holding a target. */
function injectFrames(page: Page) {
  return page.evaluate(() => {
    const add = (html: string, first = false) => {
      const template = document.createElement("template")
      template.innerHTML = html
      const node = template.content.firstElementChild
      if (!node) throw new Error("nothing to inject")
      if (first) document.body.prepend(node)
      else document.body.append(node)
    }
    add(
      '<div style="height: 1200px"><p id="sticky-target" style="position: sticky; top: 0; margin: 0; background: white">Sticky heading</p></div>',
      true,
    )
    add(
      '<div id="fixed-bar" style="position: fixed; top: 40px; left: 300px; width: 240px; height: 32px; background: #ddd"><p id="fixed-target" style="margin: 0">Fixed bar label</p></div>',
    )
    add(
      '<div id="scroller" style="overflow: auto; height: 120px"><div style="height: 400px"></div><p id="scroller-target" style="margin: 0">Inside the scroller</p><div style="height: 400px"></div></div>',
    )
  })
}

const putBodies = (o: Opened) =>
  o.mock
    .requests()
    .filter((request) => request.method === "PUT" && PUT_DRAFT.test(request.path))
    .map((request) => request.body as { anchorStatus: string })

describe("note pins", () => {
  test("a seeded draft is pinned at its element and its hover card shows the note", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - (target.left + 2))).toBeLessThanOrEqual(2)
    expect(Math.abs(at.y - (target.top + 2))).toBeLessThanOrEqual(2)

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    const text = await card.innerText()
    expect(text).toContain("Fix")
    expect(text).toContain("The price wraps onto two lines at this width; keep it on one.")
    expect(text).toContain("Click to edit")
  }, 30_000)

  test("a window scroll moves the pin with its element in the same frame", async () => {
    const o = await open(seed([draft("N21", DETAILS)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    const before = await centre(pin)

    const read = await scrollAndRead(o.page, {
      pin: "Note 1, Fix",
      target: "h2#details-heading",
      scroller: null,
      to: 120,
      when: "same frame",
    })
    expect(read.scrolled).toBe(120)
    expectOnCorner(read)
    expect(before.y - read.pin.y).toBeGreaterThan(100)
  }, 30_000)

  test("a horizontal window scroll moves the pin with its element in the same frame", async () => {
    const o = await openWide([draft("N21", WIDE_A)])
    const pair = { pin: "Note 1, Fix", target: "p#wide-a" }
    const steps = [{ x: 700, y: 0 }]
    await until("the pin on its element", async () => {
      const [read] = await scrollStepsAndRead(o.page, [{ x: 0, y: 0 }], [pair])
      return read !== undefined && Math.abs((read.scrolled[0]?.pin.x ?? 0) - 1602) <= 2
    })
    const reads = await scrollStepsAndRead(o.page, steps, [pair])
    expectFollowed(steps, reads, ["p#wide-a"])
    expect(reads[0]?.scrolled[0]?.pin.x).toBeLessThan(1000)
  }, 30_000)

  test("scrolling down and back up keeps the pin on its element and returns it to its start", async () => {
    const o = await openWide([draft("N21", WIDE_A)])
    const pair = { pin: "Note 1, Fix", target: "p#wide-a" }
    await until("the pin on its element", async () => {
      const [read] = await scrollStepsAndRead(o.page, [{ x: 0, y: 0 }], [pair])
      return read !== undefined && Math.abs((read.scrolled[0]?.pin.y ?? 0) - 502) <= 2
    })
    const steps = [
      { x: 0, y: 0 },
      { x: 500, y: 300 },
      { x: 900, y: 450 },
      { x: 200, y: 100 },
      { x: 0, y: 0 },
    ]
    const reads = await scrollStepsAndRead(o.page, steps, [pair])
    expectFollowed(steps, reads, ["p#wide-a"])
    expect(reads[2]?.scrolled[0]?.pin.y).toBeLessThan((reads[0]?.scrolled[0]?.pin.y ?? 0) - 400)
    expect(reads[4]?.replaced[0]?.pin).toEqual(reads[0]?.replaced[0]?.pin)
  }, 30_000)

  test("repeated scrolls in succession each leave the pin on its element", async () => {
    const o = await openWide([draft("N21", WIDE_B)])
    const pair = { pin: "Note 1, Fix", target: "p#wide-b" }
    await until("the pin on its element", async () => {
      const [read] = await scrollStepsAndRead(o.page, [{ x: 0, y: 0 }], [pair])
      return read !== undefined && Math.abs((read.scrolled[0]?.pin.y ?? 0) - 902) <= 2
    })
    const steps = [
      { x: 300, y: 50 },
      { x: 300, y: 50 },
      { x: 1100, y: 250 },
      { x: 1500, y: 800 },
      { x: 400, y: 600 },
      { x: 1900, y: 1700 },
      { x: 0, y: 1200 },
    ]
    const reads = await scrollStepsAndRead(o.page, steps, [pair])
    expectFollowed(steps, reads, Array(steps.length).fill("p#wide-b"))
  }, 30_000)

  test("several pins each stay on their own element through scrolls in both axes", async () => {
    const o = await openWide([draft("N21", WIDE_A), draft("N22", WIDE_B), draft("N23", WIDE_C)])
    const pairs = [
      { pin: "Note 1, Fix", target: "p#wide-a" },
      { pin: "Note 2, Fix", target: "p#wide-b" },
      { pin: "Note 3, Fix", target: "p#wide-c" },
    ]
    await until("every pin on its element", async () => {
      const [read] = await scrollStepsAndRead(o.page, [{ x: 0, y: 0 }], pairs)
      return (
        read !== undefined &&
        read.scrolled.every(
          (pair) =>
            Math.abs(pair.pin.x - (pair.target.left + 2)) <= 2 &&
            Math.abs(pair.pin.y - (pair.target.top + 2)) <= 2,
        )
      )
    })
    const steps = [
      { x: 600, y: 200 },
      { x: 1700, y: 700 },
      { x: 100, y: 1100 },
      { x: 0, y: 0 },
      { x: 1900, y: 1500 },
    ]
    const reads = await scrollStepsAndRead(o.page, steps, pairs)
    expectFollowed(steps, reads, ["p#wide-a", "p#wide-b", "p#wide-c"])
  }, 30_000)

  test("a pin on a fixed bar stays on it in the same frame as a window scroll", async () => {
    const o = await open(seed([draft("N21", FIXED_BAR)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    await injectFrames(o.page)
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())

    const read = await scrollAndRead(o.page, {
      pin: "Note 1, Fix",
      target: "p#fixed-target",
      scroller: null,
      to: 200,
      when: "same frame",
    })
    expect(read.scrolled).toBe(200)
    expect(read.target).toEqual({ left: 300, top: 40 })
    expectOnCorner(read)
  }, 30_000)

  test("a pin inside an element scroll container is back on its element in the frame after the scroll", async () => {
    const o = await open(seed([draft("N21", IN_SCROLLER)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    await injectFrames(o.page)
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())

    const read = await scrollAndRead(o.page, {
      pin: "Note 1, Fix",
      target: "p#scroller-target",
      scroller: "div#scroller",
      to: 330,
      when: "next frame",
    })
    expect(read.scrolled).toBe(330)
    expectOnCorner(read)
  }, 30_000)

  test("a pin on a sticky element is back on it in the frame after a window scroll", async () => {
    const o = await open(seed([draft("N21", STICKY)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    await injectFrames(o.page)
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())

    const read = await scrollAndRead(o.page, {
      pin: "Note 1, Fix",
      target: "p#sticky-target",
      scroller: null,
      to: 400,
      when: "next frame",
    })
    expect(read.scrolled).toBe(400)
    expect(read.target.top).toBe(0)
    expectOnCorner(read)
  }, 30_000)

  test("a window scroll writes no pin position when no pin is in a scroller or sticky", async () => {
    const o = await open(seed([draft("N21", OVERVIEW), draft("N22", DETAILS)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    const pins = o.overlay.getByRole("button", { name: /^Note \d+, / })
    await until("both pins", async () => (await pins.count()) === 2 && pins.first().isVisible())
    const watched = await o.page.evaluate(() => {
      const nodes = [
        ...(document
          .querySelector("iter8-overlay")
          ?.shadowRoot?.querySelectorAll(".docframe .pin, .docframe .apin") ?? []),
      ]
      const record = { writes: 0 }
      Object.defineProperty(window, "__pinWrites", { value: record })
      const observer = new MutationObserver((mutations) => {
        record.writes += mutations.length
      })
      for (const node of nodes)
        observer.observe(node, { attributeFilter: ["style", "data-placed"] })
      return nodes.length
    })
    expect(watched).toBe(2)

    await o.page.mouse.move(640, 150)
    await o.page.mouse.wheel(0, 240)
    let last = -1
    await waitFor(
      "the scroll to settle",
      async () => {
        const y = await o.page.evaluate(() => window.scrollY)
        const settled = y > 0 && y === last
        last = y
        return settled ? true : null
      },
      { timeoutMs: 5000, everyMs: 100 },
    )
    const writes = await o.page.evaluate(
      () => (window as unknown as { __pinWrites: { writes: number } }).__pinWrites.writes,
    )
    expect(writes).toBe(0)
  }, 30_000)

  test("pins at the page's right and bottom edges never grow the page", async () => {
    const o = await open(
      seed([draft("N21", RIGHT_EDGE), draft("N22", BOTTOM_EDGE)], [agentNote("N31", RIGHT_EDGE)]),
    )
    await o.page.evaluate(() => {
      const right = document.createElement("p")
      right.id = "edge-right"
      right.textContent = "Right edge"
      right.style.cssText =
        "position: absolute; right: 0; top: 200px; width: 10px; height: 20px; margin: 0; overflow: hidden"
      const bottom = document.createElement("p")
      bottom.id = "edge-bottom"
      bottom.textContent = "Bottom edge"
      bottom.style.cssText = `position: absolute; left: 100px; top: ${document.documentElement.scrollHeight - 10}px; height: 10px; margin: 0; overflow: hidden`
      document.body.append(right, bottom)
    })
    const notes = o.overlay.getByRole("button", { name: /^Note \d+, / })
    const agent = pinNamed(o.overlay, "Claude note")
    await until(
      "all three pins",
      async () =>
        (await notes.count()) === 2 &&
        (await notes.nth(0).isVisible()) &&
        (await notes.nth(1).isVisible()) &&
        (await agent.isVisible()),
    )

    const extents = await o.page.evaluate(() => {
      const host = document.querySelector("iter8-overlay")
      if (!(host instanceof HTMLElement)) throw new Error("no overlay host")
      const root = document.documentElement
      host.style.display = "none"
      const hidden = { width: root.scrollWidth, height: root.scrollHeight }
      host.style.display = ""
      const shown = { width: root.scrollWidth, height: root.scrollHeight }
      return { hidden, shown, viewport: { width: root.clientWidth } }
    })
    expect(extents.hidden.width).toBe(extents.viewport.width)
    expect(extents.shown).toEqual(extents.hidden)
  }, 30_000)

  test("a pin hovered after the page has scrolled shows its card beside it", async () => {
    const o = await open(seed([draft("N21", DETAILS)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    await o.page.evaluate(() => window.scrollTo(0, 120))
    await until("the scroll", async () => (await o.page.evaluate(() => window.scrollY)) === 120)

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    const pinBox = await pin.boundingBox()
    const cardBox = await card.boundingBox()
    if (!pinBox || !cardBox) throw new Error("no pin or card box")
    expect(Math.abs(cardBox.x - (pinBox.x + pinBox.width + 10))).toBeLessThanOrEqual(4)
    expect(cardBox.y).toBeLessThanOrEqual(pinBox.y + pinBox.height)
    expect(cardBox.y + cardBox.height).toBeGreaterThanOrEqual(pinBox.y)
  }, 30_000)

  test("after the page reloads the pins are restored from the service drafts", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    await o.page.evaluate(() => document.body.setAttribute("data-before-reload", ""))
    const helloCount = () =>
      o.mock.requests().filter((request) => request.path === OVERLAY_ROUTES.hello.path).length
    const hellosBefore = helloCount()

    await pushUntil(
      o,
      { type: "upstream-failure", port: 5173, url: "http://localhost:5173/src/main.tsx" },
      () => o.overlay.getByText(/port 5173 failed/).isVisible(),
    )
    const loaded = o.page.waitForEvent("load", { timeout: 8000 })
    o.mock.push({ type: "reload" })
    await loaded
    await until("the pin to come back", () => pin.isVisible())
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(
      false,
    )
    expect(helloCount()).toBeGreaterThan(hellosBefore)
    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - (target.left + 2))).toBeLessThanOrEqual(2)
  }, 30_000)

  test("a removed element moves the note to the tray and saves it as moved", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    expect(putBodies(o)).toEqual([])

    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())

    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const row = list.getByRole("listitem")
    expect(await row.count()).toBe(1)
    const text = await row.innerText()
    expect(text).toContain("Moved")
    expect(text).toContain("element gone")
    expect(text).toContain("The price wraps onto two lines")
    expect(await pin.count()).toBe(0)
    expect(await o.overlay.getByText("1 note lost its element").isVisible()).toBe(true)

    await until("the PUT", () => putBodies(o).length > 0)
    expect(putBodies(o).map((body) => body.anchorStatus)).toEqual(["moved"])
    expect(o.mock.draft().map((note) => note.anchorStatus)).toEqual(["moved"])
  }, 30_000)

  test("a note whose element matches several equally near candidates says more than one match", async () => {
    const probe = await open()
    const centres = await probe.page.evaluate(() =>
      Array.from(document.querySelectorAll("main button"), (button) => {
        const r = button.getBoundingClientRect()
        return {
          x: r.left + r.width / 2 + window.scrollX,
          y: r.top + r.height / 2 + window.scrollY,
        }
      }),
    )
    await probe.close()
    opened = null
    const [first, second] = centres
    if (!first || !second || centres.length !== 3) throw new Error("expected three Save buttons")
    const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const equidistant = { x: middle.x - 100, y: middle.y - 100, width: 200, height: 200 }

    const o = await open(
      seed([
        draft("N21", {
          selector: ["button#removed-save"],
          role: "button",
          text: "Save",
          box: equidistant,
        }),
      ]),
    )
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const text = await list.getByRole("listitem").innerText()
    expect(text).toContain("more than one match")
    expect(text).toContain("Moved")
    expect(await pinNamed(o.overlay, "Note 1, Fix").count()).toBe(0)
  }, 40_000)

  test("Re-pick puts the page in pick mode", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const pickTool = o.overlay.getByRole("button", { name: "Pick element" })
    expect(await pickTool.getAttribute("aria-pressed")).toBe("false")

    await list.getByRole("button", { name: "Re-pick" }).click()
    await until("pick mode", async () => (await pickTool.getAttribute("aria-pressed")) === "true")
  }, 30_000)

  test("Re-pick saves the next picked element as the note's target and empties the tray", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    await until("the moved PUT", () => putBodies(o).length > 0)

    await list.getByRole("button", { name: "Re-pick" }).click()
    const target = await rectOf(o.page, "h2#details-heading")
    await o.page.mouse.move(target.left + 4, target.top + 4)
    await o.page.mouse.click(target.left + 4, target.top + 4)

    await until("the tray to empty", async () => (await list.count()) === 0, 8000)
    await until("the anchored PUT", () => putBodies(o).at(-1)?.anchorStatus === "anchored")
    const saved = o.mock.draft()[0]
    expect(saved?.target).toMatchObject({
      kind: "element",
      anchor: { selector: ["h2#details-heading"] },
    })
    expect(saved?.anchorStatus).toBe("anchored")
    expect(Note.parse(noteJson).capture).toBeDefined()
    expect(saved?.capture).toBeUndefined()
    expect(saved?.body).toBe("The price wraps onto two lines at this width; keep it on one.")

    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin on the new element", () => pin.isVisible())
    const moved = await rectOf(o.page, "h2#details-heading")
    const at = await centre(pin)
    expect(Math.abs(at.y - (moved.top + 2))).toBeLessThanOrEqual(2)
  }, 30_000)
})

describe("agent pins", () => {
  test("a pushed agent note appears as an avatar pin on its element and can be removed", async () => {
    const o = await open(seed())
    const note = agentNote("N31", OVERVIEW)
    const pin = pinNamed(o.overlay, "Claude note")
    await pushUntil(o, { type: "agent-note", note }, () => pin.isVisible())

    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - target.right)).toBeLessThanOrEqual(20)
    expect(Math.abs(at.y - target.top)).toBeLessThanOrEqual(20)
    expect(await pin.getByRole("img", { name: "Claude" }).count()).toBe(1)

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    const text = await card.innerText()
    expect(text).toContain("Claude")
    expect(text).toContain("This footer link points at the old docs.")

    await pushUntil(
      o,
      { type: "agent-note-removed", noteId: note.id },
      async () => (await pin.count()) === 0,
    )
  }, 30_000)

  test("an agent note whose element is not on the page is listed as unanchored", async () => {
    const o = await open(seed([], [agentNote("N32", GONE_AGENT)]))
    const list = unanchoredList(o.overlay)
    await until("the unanchored list", () => list.isVisible())
    const row = list.getByRole("listitem")
    expect(await row.count()).toBe(1)
    const text = await row.innerText()
    expect(text).toContain("Unanchored")
    expect(text).toContain("This footer link points at the old docs.")
    expect(await pinNamed(o.overlay, "Claude note").count()).toBe(0)
    expect(await movedList(o.overlay).count()).toBe(0)
  }, 30_000)
})

describe("resolved notes", () => {
  const SENT_BODY = "The price wraps onto two lines at this width; keep it on one."
  const OPEN_BODY = "Details need the same treatment."
  const DONE = { status: "done", at: "2026-10-09T18:45:00.000Z" } as const
  const ANSWERED = {
    status: "answered",
    reply: "Yes, it stays on one line.",
    at: "2026-10-09T18:46:00.000Z",
  } as const

  const roundSheet = (o: Opened) => o.overlay.getByRole("complementary", { name: "Round sheet" })
  const notePins = (o: Opened) => o.overlay.getByRole("button", { name: /^Note \d+, / })

  async function sendFromSheet(o: Opened) {
    const sheet = roundSheet(o)
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await until("the round sheet", () => sheet.isVisible())
    await sheet.getByRole("button", { name: "Send round" }).click()
    await until("the sent round in History", () =>
      sheet.getByRole("status", { name: "Queued", exact: true }).isVisible(),
    )
    return sheet
  }

  function resolved(o: Opened, resolutions: Record<string, Note["resolution"]>) {
    const [round] = o.mock.rounds()
    if (!round) throw new Error("no round was sent")
    return Round.parse({
      ...round,
      notes: round.notes.map((note) => ({
        ...note,
        resolution: resolutions[note.id] ?? note.resolution,
      })),
    })
  }

  const reword = (page: Page, selectors: string[]) =>
    page.evaluate((targets) => {
      for (const selector of targets) {
        const el = document.querySelector(selector)
        if (!el) throw new Error(`nothing matches ${selector}`)
        el.textContent = `${el.textContent} (reworded)`
      }
    }, selectors)

  test("a sent note that lost its element is listed until the agent marks it done", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const sheet = await sendFromSheet(o)
    await until("the sent pin", () => notePins(o).first().isVisible())

    await reword(o.page, ["h2#overview-heading"])
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    expect(await list.getByRole("listitem").innerText()).toContain(SENT_BODY)
    expect(await o.overlay.getByText("1 note lost its element").isVisible()).toBe(true)

    await pushUntil(o, { type: "round", round: resolved(o, { N21: DONE }) }, () =>
      sheet.getByRole("status", { name: "done", exact: true }).isVisible(),
    )
    await until(
      "the lost panel to go",
      async () => (await o.overlay.locator(".lost").count()) === 0,
    )
    expect(await notePins(o).count()).toBe(0)
  }, 30_000)

  test("an answered note whose element changes after the answer never enters the lost panel, while a still-open note does", async () => {
    const o = await open(seed([draft("N21", OVERVIEW), draft("N22", DETAILS, { body: OPEN_BODY })]))
    const sheet = await sendFromSheet(o)
    await pushUntil(o, { type: "round", round: resolved(o, { N21: ANSWERED }) }, () =>
      sheet.getByRole("status", { name: "answered", exact: true }).isVisible(),
    )
    await until("both pins", async () => (await notePins(o).count()) === 2)

    await reword(o.page, ["h2#overview-heading", "h2#details-heading"])
    await until("the open note to be listed", () =>
      o.overlay.getByText("1 note lost its element").isVisible(),
    )
    const rows = movedList(o.overlay).getByRole("listitem")
    expect(await rows.count()).toBe(1)
    expect(await rows.innerText()).toContain(OPEN_BODY)
    expect(await o.overlay.locator(".lost").getByText(SENT_BODY).count()).toBe(0)
    expect(await notePins(o).count()).toBe(0)
  }, 40_000)

  for (const [status, resolution] of [
    ["done", DONE],
    ["answered", ANSWERED],
  ] as const) {
    test(`a ${status} note whose element is unchanged keeps its pin after a re-anchoring pass`, async () => {
      const o = await open(
        seed([draft("N21", OVERVIEW), draft("N22", DETAILS, { body: OPEN_BODY })]),
      )
      const sheet = await sendFromSheet(o)
      await pushUntil(o, { type: "round", round: resolved(o, { N21: resolution }) }, () =>
        sheet.getByRole("status", { name: status, exact: true }).isVisible(),
      )
      await until("both pins", async () => (await notePins(o).count()) === 2)

      await reword(o.page, ["h2#details-heading"])
      await until("the open note to be listed", () =>
        o.overlay.getByText("1 note lost its element").isVisible(),
      )
      const rows = movedList(o.overlay).getByRole("listitem")
      expect(await rows.count()).toBe(1)
      expect(await rows.innerText()).toContain(OPEN_BODY)

      expect(await notePins(o).count()).toBe(1)
      const pin = notePins(o).first()
      const target = await rectOf(o.page, "h2#overview-heading")
      const at = await centre(pin)
      expect(Math.abs(at.x - (target.left + 2))).toBeLessThanOrEqual(2)
      expect(Math.abs(at.y - (target.top + 2))).toBeLessThanOrEqual(2)
      expect(await o.overlay.locator(".lost").getByText(SENT_BODY).count()).toBe(0)
    }, 40_000)
  }

  test("an open draft whose heading text changes is listed as moved", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())

    await reword(o.page, ["h2#overview-heading"])
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    expect(await list.getByRole("listitem").innerText()).toContain("Moved")
    expect(await pin.count()).toBe(0)
  }, 30_000)
})

describe("pin visibility", () => {
  test("P hides the pins and shows them again", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)], [agentNote("N31", DETAILS)]))
    const note = pinNamed(o.overlay, "Note 1, Fix")
    const agent = pinNamed(o.overlay, "Claude note")
    await until("both pins", async () => (await note.isVisible()) && (await agent.isVisible()))

    await o.page.keyboard.press("p")
    await until(
      "the pins to hide",
      async () => !(await note.isVisible()) && !(await agent.isVisible()),
    )
    await until("the pref to save", () => !o.mock.prefs().pinsVisible)

    await o.page.keyboard.press("p")
    await until(
      "the pins to show",
      async () => (await note.isVisible()) && (await agent.isVisible()),
    )
  }, 30_000)
})
