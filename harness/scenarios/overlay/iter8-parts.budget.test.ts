import { afterAll, beforeAll, expect, test } from "bun:test"
import { Note, OVERLAY_ROUTES, Pairing } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import iter8NoteJson from "../../../packages/protocol/fixtures/Note.iter8.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
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
const PREFS = {
  theme: "light",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
} as const
const DRAFTS = ["One", "Two", "Three", "Four"].map((word, index) =>
  Note.parse({
    ...iter8NoteJson,
    id: `N${50 + index}`,
    pageId: "mockpage",
    body: `${word} note about the ring`,
    capture: undefined,
  }),
)

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
}

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

const SPEEDS = [
  { name: "normal speed", rate: () => 1 },
  { name: "the calibrated 4x CPU throttle", rate: () => throttledRate },
]

for (const speed of SPEEDS) {
  test(`hovering and picking overlay parts with the modifier held stay within their frame and task budgets at ${speed.name}`, async () => {
    const rate = speed.rate()
    const o = await openOverlay({
      overlayDir: overlayBuild.path,
      folder: heavy.path,
      path: HEAVY_PAGE,
      mock: {
        prefs: PREFS,
        pairing: Pairing.parse(pairingJson),
        pageState: { drafts: DRAFTS, rounds: [], agentNotes: [] },
      },
      browser,
    })
    let sweep: Window
    let still: Window
    let pick: Window
    try {
      await showTickerCell(o.page)
      await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
      const sheet = o.overlay.locator("[data-iter8-part='sheet']")
      await waitFor("the round sheet", async () => ((await sheet.isVisible()) ? true : null))
      const box = await sheet.boundingBox()
      if (!box) throw new Error("the sheet has no box")
      const grid = {
        left: box.x + 8,
        top: box.y + 8,
        right: box.x + box.width - 8,
        bottom: box.y + box.height - 8,
      }
      const path = sweepPath(grid)
      expect(path).toHaveLength(PASSES * STEPS_PER_PASS)

      await o.page.keyboard.press("c")
      const pickButton = o.overlay.getByRole("button", { name: "Pick element" })
      await waitFor("pick mode", async () =>
        (await pickButton.getAttribute("aria-pressed")) === "true" ? true : null,
      )
      await o.page.keyboard.down("Alt")
      await o.page.mouse.move(grid.left, grid.top)

      const header = await o.overlay.locator("[data-iter8-part='sheet.header']").boundingBox()
      if (!header) throw new Error("the sheet header has no box")
      const uploads = () =>
        o.mock
          .requests()
          .filter((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.uploadScreenshot.path)
          .length

      const throttle = rate === 1 ? null : await throttleCpu(o.page, rate)
      try {
        sweep = await measure(o.page, async () => {
          for (const point of path) await o.page.mouse.move(point.x, point.y)
        })
        still = await measure(o.page, () => waitPageMs(o.page, sweep.elapsedMs))
        pick = await measure(o.page, async () => {
          await o.page.mouse.click(header.x + header.width / 2, header.y + header.height / 2)
          await waitFor(
            "the part's screenshot to upload",
            async () => (uploads() > 0 ? true : null),
            {
              timeoutMs: 60_000,
              everyMs: 100,
            },
          )
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
