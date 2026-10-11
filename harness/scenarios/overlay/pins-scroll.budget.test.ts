import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type ElementAnchor, Note, Pairing } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { calibrateThrottle, throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)

const REST_TOLERANCE_PX = 1
const MIN_SCROLLING_FRAMES = 30
const WHEEL_STEP_PX = 20
const WHEEL_STEPS = 40
const WHEEL_AT = { x: 640, y: 150 }
const VIEWPORT = { width: 1280, height: 300 }

type Target = Pick<ElementAnchor, "selector" | "role" | "text"> & Partial<ElementAnchor>

function draft(id: string, target: Target) {
  return Note.parse({
    ...noteJson,
    id,
    pageId: "mockpage",
    target: {
      kind: "element",
      anchor: { box: { x: 0, y: 0, width: 100, height: 30 }, renderGeneration: 0, ...target },
    },
  })
}

const OVERVIEW = { selector: ["h2#overview-heading"], role: "heading", text: "Overview" }
const DETAILS = { selector: ["h2#details-heading"], role: "heading", text: "Details" }
const IN_SCROLLER = { selector: ["p#scroller-target"], text: "Inside the scroller" }

type Pair = { pin: string; target: string }
type Offset = { x: number; y: number }
type Measured = {
  rest: Offset[]
  samples: { scroll: number; offsets: Offset[] }[]
  styleWrites: number
}

const DOCUMENT_PAIRS: Pair[] = [
  { pin: "Note 1, Fix", target: "h2#overview-heading" },
  { pin: "Note 2, Fix", target: "h2#details-heading" },
]
const NESTED_PAIRS: Pair[] = [{ pin: "Note 1, Fix", target: "p#scroller-target" }]

let browser: Browser
let overlayBuild: Scratch
let throttledRate = 1

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  throttledRate = (await calibrateThrottle(browser)).rate
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

const SPEEDS = ["normal speed", "4× CPU throttle"] as const
const rateOf = (speed: (typeof SPEEDS)[number]) => (speed === "normal speed" ? 1 : throttledRate)

function addDocumentRoom(page: Page) {
  return page.evaluate(() => {
    const room = document.createElement("div")
    room.style.height = "3000px"
    document.body.append(room)
  })
}

function addScroller(page: Page) {
  return page.evaluate(() => {
    const template = document.createElement("template")
    template.innerHTML =
      '<div id="scroller" style="overflow: auto; height: 200px"><div style="height: 150px"></div><p id="scroller-target" style="margin: 0">Inside the scroller</p><div style="height: 3000px"></div></div>'
    const node = template.content.firstElementChild
    if (!node) throw new Error("nothing to inject")
    document.body.prepend(node)
  })
}

function pinsAtRest(page: Page, pairs: Pair[]) {
  return page.evaluate((pairs) => {
    const root = document.querySelector("iter8-overlay")?.shadowRoot
    return pairs.every(({ pin }) => {
      const node = root?.querySelector(`[aria-label="${pin}"]`)
      return node?.hasAttribute("data-placed") === true && node.getAnimations().length === 0
    })
  }, pairs)
}

/**
 * Samples run in a frame callback registered from a scroll listener installed after the overlay's
 * own, so they run after the overlay's frame callback and see the placement the user sees.
 * A scroll event fires once per frame in which the position changed, so every scrolling frame is
 * sampled.
 */
function installSampler(page: Page, pairs: Pair[], scroller: string | null) {
  const key = `iter8-pin-samples-${crypto.randomUUID()}`
  return page
    .evaluate(
      ({ key, pairs, scroller }) => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        const layer = root?.querySelector(".pinlayer")
        const box = scroller === null ? null : document.querySelector(scroller)
        if (!root || !layer) throw new Error("no pin layer")
        const tracked = pairs.map(({ pin, target }) => {
          const node = root.querySelector(`[aria-label="${pin}"]`)
          const el = document.querySelector(target)
          if (!node || !el || !layer.contains(node)) throw new Error(`no pin ${pin} in the layer`)
          return { node, el }
        })
        const read = () =>
          tracked.map(({ node, el }) => {
            const p = node.getBoundingClientRect()
            const t = el.getBoundingClientRect()
            return { x: p.left - t.left, y: p.top - t.top }
          })
        const rest = read()
        const samples: { scroll: number; offsets: { x: number; y: number }[] }[] = []
        let styleWrites = 0
        const observer = new MutationObserver((records) => {
          styleWrites += records.length
        })
        observer.observe(layer, { attributes: true, attributeFilter: ["style"], subtree: true })
        let queued = false
        const onScroll = () => {
          if (queued) return
          queued = true
          requestAnimationFrame(() => {
            queued = false
            samples.push({ scroll: box === null ? window.scrollY : box.scrollTop, offsets: read() })
          })
        }
        window.addEventListener("scroll", onScroll, { capture: true, passive: true })
        const position = () => (box === null ? window.scrollY : box.scrollTop)
        Reflect.set(window, key, {
          progress: () => ({ scroll: position(), frames: samples.length }),
          stop: () => {
            window.removeEventListener("scroll", onScroll, { capture: true })
            styleWrites += observer.takeRecords().length
            observer.disconnect()
            samples.push({ scroll: position(), offsets: read() })
            Reflect.deleteProperty(window, key)
            return { rest, samples, styleWrites }
          },
        })
      },
      { key, pairs, scroller },
    )
    .then(() => ({
      progress: () =>
        page.evaluate(
          (key) =>
            (
              Reflect.get(window, key) as { progress: () => { scroll: number; frames: number } }
            ).progress(),
          key,
        ),
      stop: (): Promise<Measured> =>
        page.evaluate((key) => (Reflect.get(window, key) as { stop: () => Measured }).stop(), key),
    }))
}

async function measureWheelScroll(
  page: Page,
  rate: number,
  pairs: Pair[],
  scroller: string | null,
): Promise<Measured> {
  await waitFor(
    "every pin placed and still",
    async () => ((await pinsAtRest(page, pairs)) ? true : null),
    {
      timeoutMs: 10_000,
      everyMs: 100,
    },
  )
  const throttle = await throttleCpu(page, rate)
  try {
    const sampler = await installSampler(page, pairs, scroller)
    await page.mouse.move(WHEEL_AT.x, WHEEL_AT.y)
    for (let step = 0; step < WHEEL_STEPS; step++) {
      const { frames } = await sampler.progress()
      await page.mouse.wheel(0, WHEEL_STEP_PX)
      await waitFor(
        "the wheel step to scroll a frame",
        async () => ((await sampler.progress()).frames > frames ? true : null),
        { timeoutMs: 10_000, everyMs: 100 },
      )
    }
    let last = -1
    await waitFor(
      "the scroll to settle",
      async () => {
        const { scroll } = await sampler.progress()
        const settled = scroll > 0 && scroll === last
        last = scroll
        return settled ? true : null
      },
      { timeoutMs: 20_000, everyMs: 150 },
    )
    return await sampler.stop()
  } finally {
    await throttle.restore()
  }
}

function worstDeviationPx(measured: Measured): number {
  let worst = 0
  for (const { offsets } of measured.samples)
    offsets.forEach((offset, i) => {
      const rest = measured.rest[i]
      if (!rest) throw new Error("a sample has more pins than the rest reading")
      worst = Math.max(worst, Math.abs(offset.x - rest.x), Math.abs(offset.y - rest.y))
    })
  return worst
}

function scrollingFrames(measured: Measured): number {
  return measured.samples.filter(
    ({ scroll }, i) => i > 0 && scroll !== measured.samples[i - 1]?.scroll,
  ).length
}

describe("pins while scrolling", () => {
  for (const speed of SPEEDS) {
    test(`a document scroll at ${speed} keeps every pin on its element and writes no pin position`, async () => {
      const o = await openOverlay({
        overlayDir: overlayBuild.path,
        folder: STATIC,
        mock: {
          pairing: LIVE,
          pageState: {
            drafts: [draft("N21", OVERVIEW), draft("N22", DETAILS)],
            rounds: [],
            agentNotes: [],
          },
        },
        browser,
      })
      try {
        await o.page.setViewportSize(VIEWPORT)
        await addDocumentRoom(o.page)
        const measured = await measureWheelScroll(o.page, rateOf(speed), DOCUMENT_PAIRS, null)

        expect(scrollingFrames(measured)).toBeGreaterThanOrEqual(MIN_SCROLLING_FRAMES)
        expect(worstDeviationPx(measured)).toBeLessThanOrEqual(REST_TOLERANCE_PX)
        expect(measured.styleWrites).toBe(0)
      } finally {
        await o.close()
      }
    }, 60_000)

    test(`a scroll inside a container at ${speed} keeps the pin on its element in every frame`, async () => {
      const o = await openOverlay({
        overlayDir: overlayBuild.path,
        folder: STATIC,
        mock: {
          pairing: LIVE,
          pageState: { drafts: [draft("N21", IN_SCROLLER)], rounds: [], agentNotes: [] },
        },
        browser,
      })
      try {
        await o.page.setViewportSize(VIEWPORT)
        await addScroller(o.page)
        const measured = await measureWheelScroll(
          o.page,
          rateOf(speed),
          NESTED_PAIRS,
          "div#scroller",
        )

        expect(scrollingFrames(measured)).toBeGreaterThanOrEqual(MIN_SCROLLING_FRAMES)
        expect(worstDeviationPx(measured)).toBeLessThanOrEqual(REST_TOLERANCE_PX)
      } finally {
        await o.close()
      }
    }, 60_000)
  }
})
