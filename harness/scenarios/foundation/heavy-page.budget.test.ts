import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { buildFixture, HEAVY_PAGE, startFixture } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import { calibrateThrottle, throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"
import { startMockService } from "../../stubs/mock-service"

const MIN_GRID_ELEMENTS = 25_000
// Normal speed only: this keeps a normal-speed breach the overlay's. At 4× the ticker alone runs
// tasks over 50 ms, so throttled budgets compare the overlay with a page-alone window instead.
const PAGE_LONGEST_TASK_MS = 50
// The ticker updates every 250 ms, so twelve ticks is the 3 s idle window.
const IDLE_TICKS = 12

let browser: Browser
let throttledRate: number

beforeAll(async () => {
  browser = await launchChromium()
  throttledRate = (await calibrateThrottle(browser)).rate
})

afterAll(async () => {
  await browser?.close()
})

async function measureIdle(url: string, rate: number | null) {
  const { page, errors, close } = await newPage(browser)
  try {
    if (rate !== null) await throttleCpu(page, rate)
    await page.goto(url)
    const tick = () =>
      page.evaluate(() => {
        const cell = document.querySelector("table tbody tr:last-child td:last-child")
        const match = cell?.textContent?.match(/tick (\d+)/)
        return match ? Number(match[1]) : null
      })
    const first = await waitFor("the heavy grid's ticker", tick, { timeoutMs: 30_000 })
    // The Long Tasks API reports a rendering-only task only while a frame callback is pending, so
    // without the frame probe the ticker's updates go unseen.
    const frames = await startFrameProbe(page)
    const tasks = await startLongTaskProbe(page)
    await waitFor(
      `${IDLE_TICKS} ticker updates`,
      async () => {
        const now = await tick()
        return now !== null && now >= first + IDLE_TICKS ? now : null
      },
      { timeoutMs: 10_000, everyMs: 250 },
    )
    const { longestMs, count } = await tasks.stop()
    await frames.stop()
    const elements = await page.evaluate(() => document.querySelectorAll("table *").length)
    return { longestMs, count, elements, errors }
  } finally {
    await close()
  }
}

async function measurePrebuilt(rate: number | null) {
  const folder = await buildFixture("vite-react")
  try {
    const overlay = await buildBrowserBundle(
      Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
    )
    try {
      const mock = await startMockService({ folder: folder.path, overlayDir: overlay.path })
      try {
        return await measureIdle(mock.pageUrl(HEAVY_PAGE), rate)
      } finally {
        await mock.stop()
      }
    } finally {
      await overlay.dispose()
    }
  } finally {
    await folder.dispose()
  }
}

async function measureDevServer(rate: number | null) {
  const running = await startFixture("vite-react")
  try {
    return await measureIdle(running.url(HEAVY_PAGE), rate)
  } finally {
    await running.stop()
  }
}

const SOURCES = [
  { name: "from the dev server", measure: measureDevServer },
  { name: "prebuilt and served by the mock service", measure: measurePrebuilt },
]

for (const source of SOURCES) {
  test(`the heavy page ${source.name} idles with no task over 50 ms at normal speed`, async () => {
    const { longestMs, count, elements, errors } = await source.measure(null)
    expect(elements).toBeGreaterThanOrEqual(MIN_GRID_ELEMENTS)
    expect(
      longestMs,
      `longest task ${longestMs.toFixed(1)} ms over ${count} long tasks; bound ${PAGE_LONGEST_TASK_MS} ms at rate 1`,
    ).toBeLessThan(PAGE_LONGEST_TASK_MS)
    expect(errors).toEqual([])
  }, 120_000)

  test(`the heavy page ${source.name} reports its own long tasks at the calibrated 4x CPU throttle`, async () => {
    const { longestMs, count, elements, errors } = await source.measure(throttledRate)
    console.info(
      `heavy page ${source.name}, alone at rate ${throttledRate.toFixed(2)}: longest task ${longestMs.toFixed(1)} ms, ${count} tasks over 50 ms in ${IDLE_TICKS} ticker updates`,
    )
    expect(elements).toBeGreaterThanOrEqual(MIN_GRID_ELEMENTS)
    expect(errors).toEqual([])
  }, 120_000)
}
