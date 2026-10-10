import { expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { startFrameProbe } from "../../rig/frames"
import { startLayoutProbe } from "../../rig/layout"
import { nextPort } from "../../rig/ports"
import { calibrateThrottle, measureBenchmarkIndex, throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"

const QUIET_PAGE =
  "<!doctype html><title>Perf probes</title><div id=box style='width:100px'>box</div>"

const JANKY_PAGE = `<!doctype html><title>Janky frames</title><script>
  window.jankFrames = 0
  const jank = () => {
    window.jankFrames++
    if (window.jankFrames % 10 === 0) {
      const until = performance.now() + 100
      while (performance.now() < until) {}
    }
    requestAnimationFrame(jank)
  }
  requestAnimationFrame(jank)
</script>`

async function withPage(html: string, run: (page: Page, browser: Browser) => Promise<void>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: await nextPort(),
    fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
  })
  try {
    const browser = await launchChromium()
    try {
      const { page, close } = await newPage(browser)
      try {
        await page.goto(server.url.href)
        await run(page, browser)
      } finally {
        await close()
      }
    } finally {
      await browser.close()
    }
  } finally {
    await server.stop(true)
  }
}

function timeBusyLoop(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        setTimeout(() => {
          const started = performance.now()
          let sum = 0
          for (let index = 0; index < 50_000_000; index++) sum = (sum * 31 + index) | 0
          if (sum === 0.5) throw new Error("unreachable")
          resolve(performance.now() - started)
        }, 0),
      ),
  )
}

async function medianBusyLoopMs(page: Page): Promise<number> {
  const runs: number[] = []
  for (let run = 0; run < 3; run++) runs.push(await timeBusyLoop(page))
  const median = runs.toSorted((a, b) => a - b)[1]
  if (median === undefined) throw new Error("No busy-loop runs")
  return median
}

async function waitForPageMs(page: Page, ms: number): Promise<void> {
  const started = await page.evaluate(() => performance.now())
  await waitFor(
    `${ms} ms of page time`,
    async () =>
      page.evaluate(({ started, ms }) => (performance.now() - started >= ms ? true : null), {
        started,
        ms,
      }),
    { timeoutMs: ms + 5000, everyMs: 100 },
  )
}

test(
  "the raw throttle slows a page-side loop at the given rate and restores it",
  () =>
    withPage(QUIET_PAGE, async (page) => {
      await medianBusyLoopMs(page)
      const normalMs = await medianBusyLoopMs(page)
      const throttle = await throttleCpu(page, 4)
      const throttledMs = await medianBusyLoopMs(page)
      await throttle.restore()
      await throttle.restore()
      const restoredMs = await medianBusyLoopMs(page)
      expect(throttledMs).toBeGreaterThanOrEqual(2.5 * normalMs)
      expect(restoredMs).toBeLessThan(1.5 * normalMs)
    }),
  60_000,
)

test(
  "calibration targets a quarter of the reference index and the returned rate reaches it",
  () =>
    withPage(QUIET_PAGE, async (_page, browser) => {
      const { rate, targetIndex } = await calibrateThrottle(browser)
      expect(targetIndex).toBe(14_500)
      const { page, close } = await newPage(browser)
      try {
        const throttle = await throttleCpu(page, rate)
        try {
          const index = await measureBenchmarkIndex(page)
          expect(index).toBeGreaterThanOrEqual(14_500 * 0.85)
          expect(index).toBeLessThanOrEqual(14_500 * 1.15)
        } finally {
          await throttle.restore()
        }
      } finally {
        await close()
      }
    }),
  90_000,
)

test(
  "a quiet page shows no late frames and a vsync period of a real display",
  () =>
    withPage(QUIET_PAGE, async (page) => {
      const probe = await startFrameProbe(page)
      await waitForPageMs(page, 2000)
      const result = await probe.stop()
      expect(result.late).toBe(0)
      expect(result.vsyncMs).toBeGreaterThanOrEqual(8)
      expect(result.vsyncMs).toBeLessThanOrEqual(34)
    }),
  30_000,
)

test(
  "stopping the frame probe ends recording, removes its page state and is safe to repeat",
  () =>
    withPage(QUIET_PAGE, async (page) => {
      await page.evaluate(() => {
        const requestFrame = window.requestAnimationFrame.bind(window)
        Reflect.set(window, "frameRequests", 0)
        window.requestAnimationFrame = (callback) => {
          Reflect.set(window, "frameRequests", (Reflect.get(window, "frameRequests") as number) + 1)
          return requestFrame(callback)
        }
      })
      const probeKeys = () =>
        page.evaluate(() => Object.keys(window).filter((key) => key.startsWith("iter8-frames-")))
      const frameRequests = () =>
        page.evaluate(() => Reflect.get(window, "frameRequests") as number)
      const probe = await startFrameProbe(page)
      expect(await probeKeys()).toHaveLength(1)
      await waitFor("a recorded frame", async () => ((await frameRequests()) >= 3 ? true : null), {
        timeoutMs: 5000,
        everyMs: 50,
      })

      const [first, second] = await Promise.all([probe.stop(), probe.stop()])
      expect(second).toBe(first)
      expect(await probe.stop()).toBe(first)
      expect(await probeKeys()).toEqual([])

      const requestsAtStop = await frameRequests()
      await waitForPageMs(page, 300)
      expect(await frameRequests()).toBe(requestsAtStop)
    }),
  30_000,
)

test(
  "a page that blocks 100 ms in every tenth frame shows late frames",
  () =>
    withPage(JANKY_PAGE, async (page) => {
      const framesNow = () => page.evaluate(() => Reflect.get(window, "jankFrames") as number)
      const firstFrame = await framesNow()
      const probe = await startFrameProbe(page)
      await waitFor(
        "60 janky-page frames",
        async () => ((await framesNow()) >= firstFrame + 60 ? true : null),
        { timeoutMs: 20_000, everyMs: 100 },
      )
      const result = await probe.stop()
      expect(result.late).toBeGreaterThanOrEqual(5)
      expect(result.worstMs).toBeGreaterThanOrEqual(100)
    }),
  60_000,
)

test(
  "twenty write-then-read cycles count as at least twenty layouts and a quiet page counts none",
  () =>
    withPage(QUIET_PAGE, async (page) => {
      const forced = await startLayoutProbe(page)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              const box = document.getElementById("box")
              if (!box) throw new Error("The probe page has no box")
              for (let cycle = 1; cycle <= 20; cycle++) {
                box.style.width = `${100 + cycle}px`
                if (box.offsetWidth === 0) throw new Error("unreachable")
              }
              resolve()
            }, 0),
          ),
      )
      const forcedResult = await forced.stop()
      expect(forcedResult.layouts).toBeGreaterThanOrEqual(20)
      expect(forcedResult.styleRecalcs).toBeGreaterThanOrEqual(20)

      const quiet = await startLayoutProbe(page)
      await waitForPageMs(page, 1000)
      expect((await quiet.stop()).layouts).toBe(0)
    }),
  30_000,
)
