import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { buildFixture, HEAVY_PAGE } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import type { Scratch } from "../../rig/scratch"
import { calibrateThrottle, throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"
import { startMockService } from "../../stubs/mock-service"
import { buildOverlay, openOverlay } from "./support"

const TYPING_BUDGET_MS = 50
const TYPED =
  "This ticking cell should pause while I read it, and the row label needs more contrast."
const TICKER_CELL = "Row 5941, cell 2,"

let browser: Browser
let overlayBuild: Scratch
let probeBuild: Scratch
let heavy: Scratch
let throttledRate = 1

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  probeBuild = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  heavy = await buildFixture("vite-react")
  throttledRate = (await calibrateThrottle(browser)).rate
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await probeBuild?.dispose()
  await heavy?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

type Window = {
  late: number
  frames: number
  worstFrameMs: number
  longestMs: number
  count: number
  elapsedMs: number
}

async function measure(page: Page, during: () => Promise<void>): Promise<Window> {
  const frames = await startFrameProbe(page)
  const tasks = await startLongTaskProbe(page)
  await during()
  const { longestMs, count } = await tasks.stop()
  const { late, intervals, worstMs, elapsedMs } = await frames.stop()
  return { late, frames: intervals.length, worstFrameMs: worstMs, longestMs, count, elapsedMs }
}

async function waitPageMs(page: Page, ms: number): Promise<void> {
  const started = await page.evaluate(() => performance.now())
  await waitFor(
    `${Math.round(ms)} ms of page time`,
    () =>
      page.evaluate(({ started, ms }) => (performance.now() - started >= ms ? true : null), {
        started,
        ms,
      }),
    { timeoutMs: ms + 30_000, everyMs: 100 },
  )
}

async function showTickerCell(page: Page) {
  const cell = page.locator("td").filter({ hasText: TICKER_CELL })
  await until("the ticking rows to render", () => cell.isVisible().catch(() => false), 30_000)
  await cell.scrollIntoViewIfNeeded()
  return cell
}

/** The heavy page with the probe stub in place of the overlay, idle for the same span. */
async function pageAlone(rate: number, span: number): Promise<Window> {
  const mock = await startMockService({ folder: heavy.path, overlayDir: probeBuild.path })
  try {
    const { page, close } = await newPage(browser)
    try {
      await page.goto(mock.pageUrl(HEAVY_PAGE))
      await showTickerCell(page)
      const throttle = await throttleCpu(page, rate)
      try {
        return await measure(page, () => waitPageMs(page, span))
      } finally {
        await throttle.restore()
      }
    } finally {
      await close()
    }
  } finally {
    await mock.stop()
  }
}

const describeWindow = (name: string, w: Window) =>
  `${name}: longest task ${w.longestMs.toFixed(1)} ms, ${w.count} over 50 ms, ${w.late} late of ${w.frames} frames (worst ${w.worstFrameMs.toFixed(1)} ms) in ${Math.round(w.elapsedMs)} ms`

const margin = (base: number) => Math.max(2, Math.ceil(0.1 * base))

const shadowHas = (page: Page, selector: string) =>
  page.evaluate(
    (selector) =>
      document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(selector) ? true : null,
    selector,
  )

const SPEEDS = [
  { name: "normal speed", rate: () => 1 },
  { name: "the calibrated 4x CPU throttle", rate: () => throttledRate },
]

for (const speed of SPEEDS) {
  test(`typing a note on the heavy page while enrichment runs keeps every main-thread task within budget at ${speed.name}`, async () => {
    const rate = speed.rate()
    const o = await openOverlay({
      overlayDir: overlayBuild.path,
      folder: heavy.path,
      path: HEAVY_PAGE,
      browser,
    })
    let typing: Window
    try {
      const cell = await showTickerCell(o.page)
      await o.page.keyboard.press("c")
      const pick = o.overlay.getByRole("button", { name: "Pick element" })
      await until("pick mode", async () => (await pick.getAttribute("aria-pressed")) === "true")
      await cell.click()
      await waitFor("the note field to take focus", () =>
        o.page.evaluate(() => {
          const active = document.querySelector("iter8-overlay")?.shadowRoot?.activeElement
          return active?.matches('textarea[aria-label="Note"]') ? true : null
        }),
      )

      const throttle = rate === 1 ? null : await throttleCpu(o.page, rate)
      try {
        typing = await measure(o.page, async () => {
          await o.page.keyboard.type(TYPED, { delay: 25 })
          if (rate === 1) {
            await waitFor(
              "the screenshot to attach once typing pauses",
              () => shadowHas(o.page, 'img[alt="Screenshot attached"]'),
              { timeoutMs: 15_000, everyMs: 100 },
            )
          }
          await o.page.keyboard.press("ControlOrMeta+Enter")
          await waitFor(
            "the enriched draft to be stored",
            async () => {
              const capture = o.mock.draft()[0]?.capture
              return capture !== undefined &&
                (capture.screenshot !== undefined || capture.omittedParts.includes("screenshot"))
                ? true
                : null
            },
            { timeoutMs: 30_000, everyMs: 100 },
          )
        })
      } finally {
        await throttle?.restore()
      }
      expect(o.mock.draft()[0]?.body).toBe(TYPED)
      if (rate === 1) expect(o.mock.draft()[0]?.capture?.screenshot).toBeDefined()
      expect(o.errors).toEqual([])
    } finally {
      await o.close()
    }

    const summary = `${describeWindow("typing", typing)}; rate ${rate.toFixed(2)}`
    if (rate === 1) {
      expect(
        typing.longestMs,
        `typing longest task bound ${TYPING_BUDGET_MS} ms. ${summary}`,
      ).toBeLessThanOrEqual(TYPING_BUDGET_MS)
      return
    }

    const alone = await pageAlone(rate, typing.elapsedMs)
    const context = `${summary}; ${describeWindow("page alone", alone)}`
    console.info(context)
    const longestBound = Math.max(TYPING_BUDGET_MS, 1.3 * alone.longestMs)
    const countBound = alone.count + margin(alone.count)
    expect(
      typing.longestMs,
      `longest task bound ${longestBound.toFixed(1)} ms. ${context}`,
    ).toBeLessThanOrEqual(longestBound)
    expect(typing.count, `long-task count bound ${countBound}. ${context}`).toBeLessThanOrEqual(
      countBound,
    )
  }, 240_000)
}

test("the composer is never shown without its note field focused, so no keystroke reaches the page", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: heavy.path,
    path: HEAVY_PAGE,
    browser,
  })
  try {
    const cell = o.page.locator("td").filter({ hasText: "Row 5941, cell 2," })
    await until("the ticking rows to render", () => cell.isVisible().catch(() => false))
    await cell.scrollIntoViewIfNeeded()
    await o.page.keyboard.press("c")
    const pick = o.overlay.getByRole("button", { name: "Pick element" })
    await until("pick mode", async () => (await pick.getAttribute("aria-pressed")) === "true")

    await o.page.evaluate(() => {
      const watch = { shown: 0, shownUnfocused: 0, done: false }
      Object.assign(window, { __composerFocus: watch })
      const field = (root: Document | ShadowRoot): HTMLTextAreaElement | null => {
        for (const el of root.querySelectorAll("*")) {
          const inner =
            el.shadowRoot && (el.shadowRoot.querySelector("textarea") ?? field(el.shadowRoot))
          if (inner) return inner
        }
        return null
      }
      const sample = () => {
        const note = field(document)
        if (
          note &&
          getComputedStyle(note).visibility === "visible" &&
          note.getClientRects().length > 0
        ) {
          watch.shown++
          if ((note.getRootNode() as ShadowRoot).activeElement !== note) watch.shownUnfocused++
        }
        if (watch.shown < 50) setTimeout(sample, 0)
        else watch.done = true
      }
      sample()
    })
    await cell.click()
    const watched = () =>
      o.page.evaluate(
        () =>
          (
            window as unknown as {
              __composerFocus: { shown: number; shownUnfocused: number; done: boolean }
            }
          ).__composerFocus,
      )
    await until("fifty samples of the shown composer", async () => (await watched()).done)
    expect((await watched()).shownUnfocused).toBe(0)
  } finally {
    await o.close()
  }
}, 60_000)
