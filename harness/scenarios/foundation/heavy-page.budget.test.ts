import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { buildFixture, HEAVY_PAGE, startFixture } from "../../rig/fixtures"
import { startLongTaskProbe } from "../../rig/long-task"
import { waitFor } from "../../rig/wait"
import { startMockService } from "../../stubs/mock-service"

const MIN_GRID_ELEMENTS = 25_000
// Well under the overlay's 250 ms typing budget, so that budget is measurable on this page.
const PAGE_LONGEST_TASK_MS = 100
// The ticker updates every 250 ms, so twelve ticks is the 3 s idle window.
const IDLE_TICKS = 12

let browser: Browser

beforeAll(async () => {
  browser = await launchChromium()
})

afterAll(async () => {
  await browser?.close()
})

async function measureIdle(url: string) {
  const { page, errors, close } = await newPage(browser)
  try {
    await page.goto(url)
    const tick = () =>
      page.evaluate(() => {
        const cell = document.querySelector("table tbody tr:last-child td:last-child")
        const match = cell?.textContent?.match(/tick (\d+)/)
        return match ? Number(match[1]) : null
      })
    const first = await waitFor("the heavy grid's ticker", tick, { timeoutMs: 30_000 })
    const probe = await startLongTaskProbe(page)
    await waitFor(
      `${IDLE_TICKS} ticker updates`,
      async () => {
        const now = await tick()
        return now !== null && now >= first + IDLE_TICKS ? now : null
      },
      { timeoutMs: 10_000, everyMs: 250 },
    )
    const { longestMs } = await probe.stop()
    const elements = await page.evaluate(() => document.querySelectorAll("table *").length)
    return { longestMs, elements, errors }
  } finally {
    await close()
  }
}

test("the heavy page idles with its ticker running under the page's long-task bound", async () => {
  const running = await startFixture("vite-react")
  try {
    const { longestMs, elements, errors } = await measureIdle(running.url(HEAVY_PAGE))
    expect(elements).toBeGreaterThanOrEqual(MIN_GRID_ELEMENTS)
    expect(longestMs).toBeLessThan(PAGE_LONGEST_TASK_MS)
    expect(errors).toEqual([])
  } finally {
    await running.stop()
  }
}, 120_000)

test("the prebuilt heavy page served by the mock service meets the same bound", async () => {
  const folder = await buildFixture("vite-react")
  try {
    const overlay = await buildBrowserBundle(
      Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
    )
    try {
      const mock = await startMockService({
        folder: folder.path,
        overlayDir: overlay.path,
      })
      try {
        const { longestMs, elements, errors } = await measureIdle(mock.pageUrl(HEAVY_PAGE))
        expect(elements).toBeGreaterThanOrEqual(MIN_GRID_ELEMENTS)
        expect(longestMs).toBeLessThan(PAGE_LONGEST_TASK_MS)
        expect(errors).toEqual([])
      } finally {
        await mock.stop()
      }
    } finally {
      await overlay.dispose()
    }
  } finally {
    await folder.dispose()
  }
}, 120_000)
