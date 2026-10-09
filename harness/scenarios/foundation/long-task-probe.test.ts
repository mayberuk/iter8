import { expect, test } from "bun:test"
import type { Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { startLongTaskProbe } from "../../rig/long-task"
import { nextPort } from "../../rig/ports"
import { waitFor } from "../../rig/wait"

// Chromium does not report the task that runs a CDP evaluate call as a long task, so the loop is
// scheduled as a page task the way an input event would be.
function blockPageFor(page: Page, ms: number): Promise<void> {
  return page.evaluate(
    (ms) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          const until = performance.now() + ms
          while (performance.now() < until) {}
          resolve()
        }, 0),
      ),
    ms,
  )
}

async function withProbePage(run: (page: Page) => Promise<void>): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: await nextPort(),
    fetch: () =>
      new Response("<!doctype html><title>Long-task probe</title>", {
        headers: { "content-type": "text/html" },
      }),
  })
  try {
    const browser = await launchChromium()
    try {
      const { page, close } = await newPage(browser)
      try {
        await page.goto(server.url.href)
        await run(page)
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

test(
  "the probe detects a synchronous task above the typing budget and excludes earlier tasks",
  () =>
    withProbePage(async (page) => {
      await blockPageFor(page, 700)
      const probe = await startLongTaskProbe(page)
      await blockPageFor(page, 300)
      const result = await probe.stop()
      expect(result.longestMs).toBeGreaterThanOrEqual(290)
      expect(result.longestMs).toBeLessThan(600)
      expect(result.count).toBeGreaterThanOrEqual(1)
      expect(result.tasks).toHaveLength(result.count)
      expect(result.tasks.every((duration) => duration < 600)).toBe(true)
      expect(result.longestMs).toBe(Math.max(...result.tasks))
      expect(await probe.stop()).toEqual(result)
      const quiet = await startLongTaskProbe(page)
      const started = await page.evaluate(() => performance.now())
      await waitFor(
        "one second of quiet page observation",
        async () =>
          page.evaluate((started) => (performance.now() - started >= 1000 ? true : null), started),
        { timeoutMs: 3000, everyMs: 50 },
      )
      expect(await quiet.stop()).toEqual({ longestMs: 0, count: 0, tasks: [] })
    }),
  15000,
)

test(
  "the probe reports the longest of several tasks whichever order they ran in",
  () =>
    withProbePage(async (page) => {
      for (const durations of [
        [150, 400],
        [400, 150],
      ] as const) {
        const probe = await startLongTaskProbe(page)
        for (const duration of durations) await blockPageFor(page, duration)
        const result = await probe.stop()
        expect(result.count).toBeGreaterThanOrEqual(2)
        expect(result.tasks.some((task) => task >= 140 && task < 300)).toBe(true)
        expect(result.longestMs).toBeGreaterThanOrEqual(390)
        expect(result.longestMs).toBeLessThan(700)
        expect(result.longestMs).toBe(Math.max(...result.tasks))
      }
    }),
  15000,
)

test(
  "work shorter than the 50 ms long-task threshold reports nothing",
  () =>
    withProbePage(async (page) => {
      const probe = await startLongTaskProbe(page)
      for (let run = 0; run < 3; run++) await blockPageFor(page, 25)
      expect(await probe.stop()).toEqual({ longestMs: 0, count: 0, tasks: [] })
    }),
  15000,
)
