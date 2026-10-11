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

const TASK_BUDGET_MS = 50
const PASSES = 4
const STEPS_PER_PASS = 60
const TICKER_CELL = "Row 5941, cell 2,"
// Keeps the sweep off the dock, which sits in the bottom-right corner and takes no hover.
const DOCK_CLEARANCE_PX = 140

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
  await waitFor(
    "the ticking rows to render",
    async () => ((await cell.isVisible().catch(() => false)) ? true : null),
    { timeoutMs: 30_000 },
  )
  await cell.scrollIntoViewIfNeeded()
  const box = await cell.boundingBox()
  if (!box) throw new Error("the ticker cell has no box")
  return box
}

/** The heavy page with the probe stub in place of the overlay, idle for the same span. */
async function pageAlone(rate: number, spans: number[]): Promise<Window[]> {
  const mock = await startMockService({ folder: heavy.path, overlayDir: probeBuild.path })
  try {
    const { page, close } = await newPage(browser)
    try {
      await page.goto(mock.pageUrl(HEAVY_PAGE))
      await showTickerCell(page)
      const throttle = await throttleCpu(page, rate)
      try {
        const windows: Window[] = []
        for (const span of spans) windows.push(await measure(page, () => waitPageMs(page, span)))
        return windows
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

function expectWithinPageAlone(name: string, overlay: Window, alone: Window, rate: number) {
  const longestBound = Math.max(TASK_BUDGET_MS, 1.3 * alone.longestMs)
  const countBound = alone.count + margin(alone.count)
  const context = `${describeWindow(name, overlay)}; ${describeWindow("page alone", alone)}; rate ${rate.toFixed(2)}`
  expect(
    overlay.longestMs,
    `longest task bound ${longestBound.toFixed(1)} ms. ${context}`,
  ).toBeLessThanOrEqual(longestBound)
  expect(overlay.count, `long-task count bound ${countBound}. ${context}`).toBeLessThanOrEqual(
    countBound,
  )
}

function sweepPath(grid: { left: number; top: number; right: number; bottom: number }) {
  const corners = {
    tl: { x: grid.left, y: grid.top },
    tr: { x: grid.right, y: grid.top },
    bl: { x: grid.left, y: grid.bottom },
    br: { x: grid.right, y: grid.bottom },
  }
  const passes = [
    [corners.tl, corners.br],
    [corners.tr, corners.bl],
    [corners.bl, corners.tr],
    [corners.br, corners.tl],
  ] as const
  return passes.flatMap(([from, to]) =>
    Array.from({ length: STEPS_PER_PASS }, (_, index) => {
      const at = (index + 1) / STEPS_PER_PASS
      return { x: from.x + (to.x - from.x) * at, y: from.y + (to.y - from.y) * at }
    }),
  )
}

const noteFocused = (page: Page) =>
  page.evaluate(() => {
    const active = document.querySelector("iter8-overlay")?.shadowRoot?.activeElement
    return active?.matches('textarea[aria-label="Note"]') ? true : null
  })

const SPEEDS = [
  { name: "normal speed", rate: () => 1 },
  { name: "the calibrated 4x CPU throttle", rate: () => throttledRate },
]

for (const speed of SPEEDS) {
  test(`hovering and picking on the heavy page stay within their frame and task budgets at ${speed.name}`, async () => {
    const rate = speed.rate()
    const o = await openOverlay({
      overlayDir: overlayBuild.path,
      folder: heavy.path,
      path: HEAVY_PAGE,
      browser,
    })
    let sweep: Window
    let still: Window
    let pick: Window
    try {
      const cell = await showTickerCell(o.page)
      const grid = await o.page.evaluate((clearance) => {
        const table = document.querySelector("table")?.getBoundingClientRect()
        if (!table) throw new Error("no table")
        return {
          left: Math.max(table.left, 0) + 8,
          top: Math.max(table.top, 0) + 8,
          right: Math.min(table.right, window.innerWidth - clearance) - 8,
          bottom: Math.min(table.bottom, window.innerHeight - clearance) - 8,
        }
      }, DOCK_CLEARANCE_PX)
      const path = sweepPath(grid)
      expect(path).toHaveLength(PASSES * STEPS_PER_PASS)

      await o.page.keyboard.press("c")
      const pickButton = o.overlay.getByRole("button", { name: "Pick element" })
      await waitFor("pick mode", async () =>
        (await pickButton.getAttribute("aria-pressed")) === "true" ? true : null,
      )
      await o.page.mouse.move(grid.left, grid.top)

      const throttle = rate === 1 ? null : await throttleCpu(o.page, rate)
      try {
        sweep = await measure(o.page, async () => {
          for (const point of path) await o.page.mouse.move(point.x, point.y)
        })
        still = await measure(o.page, () => waitPageMs(o.page, sweep.elapsedMs))
        pick = await measure(o.page, async () => {
          await o.page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2)
          await waitFor("the note field to take focus", () => noteFocused(o.page), {
            timeoutMs: 30_000,
            everyMs: 100,
          })
        })
      } finally {
        await throttle?.restore()
      }
      expect(o.errors).toEqual([])
    } finally {
      await o.close()
    }

    const summary = `${describeWindow("sweep", sweep)}; ${describeWindow("pointer still", still)}; ${describeWindow("pick", pick)}; rate ${rate.toFixed(2)}`
    if (rate === 1) {
      const sweepLateBound = Math.ceil(0.03 * sweep.frames)
      expect(
        sweep.late,
        `sweep late frames bound ${sweepLateBound}. ${summary}`,
      ).toBeLessThanOrEqual(sweepLateBound)
      expect(pick.late, `pick late frames bound 0. ${summary}`).toBe(0)
      expect(
        sweep.longestMs,
        `sweep longest task bound ${TASK_BUDGET_MS} ms. ${summary}`,
      ).toBeLessThanOrEqual(TASK_BUDGET_MS)
      expect(
        pick.longestMs,
        `pick longest task bound ${TASK_BUDGET_MS} ms. ${summary}`,
      ).toBeLessThanOrEqual(TASK_BUDGET_MS)
      return
    }

    const [sweepAlone, pickAlone] = await pageAlone(rate, [sweep.elapsedMs, pick.elapsedMs])
    if (!sweepAlone || !pickAlone) throw new Error("the page-alone windows did not run")
    console.info(
      `${summary}; ${describeWindow("sweep page alone", sweepAlone)}; ${describeWindow("pick page alone", pickAlone)}`,
    )
    expectWithinPageAlone("sweep", sweep, sweepAlone, rate)
    expectWithinPageAlone("pick", pick, pickAlone, rate)
    const lateBound = still.late + Math.max(2, Math.ceil(0.1 * sweep.frames))
    expect(sweep.late, `sweep late frames bound ${lateBound}. ${summary}`).toBeLessThanOrEqual(
      lateBound,
    )
  }, 240_000)
}
