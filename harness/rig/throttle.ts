import type { Browser, Page } from "playwright"
import { newPage } from "./browser"

// Median builds per second on 2026-10-10 on an AMD Ryzen 9 9950X3D in headless Chromium from
// Playwright 1.64.0; runs spanned 57,800–60,600.
const REFERENCE_INDEX = 58_000
// 4× slower than the reference machine stands in for battery power-saving.
const SLOWDOWN = 4
const TARGET_INDEX = REFERENCE_INDEX / SLOWDOWN
const BENCHMARK_RUNS = 5
const BENCHMARK_RUN_MS = 500

export function throttleRateFor(hostIndex: number): number {
  const rate = (SLOWDOWN * hostIndex) / REFERENCE_INDEX
  if (rate < 1) {
    throw new Error(
      `Host benchmark index ${hostIndex} is below the throttled target index ${TARGET_INDEX}; this host is too slow to reproduce the throttled budget`,
    )
  }
  return rate
}

export async function measureBenchmarkIndex(page: Page): Promise<number> {
  const samples = await page.evaluate(
    async ({ runs, runMs }) => {
      const run = () =>
        new Promise<number>((resolve) =>
          setTimeout(() => {
            const started = performance.now()
            let builds = 0
            let elapsed = 0
            while (elapsed < runMs) {
              let text = ""
              for (let index = 0; index < 10_000; index++) text += "a"
              // Reading the string keeps the build loop from being optimised away.
              if (text.length === 1) throw new Error("unreachable")
              builds++
              elapsed = performance.now() - started
            }
            resolve(builds / (elapsed / 1000))
          }, 0),
        )
      const results: number[] = []
      for (let index = 0; index < runs; index++) results.push(await run())
      return results
    },
    { runs: BENCHMARK_RUNS, runMs: BENCHMARK_RUN_MS },
  )
  const median = samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)]
  if (median === undefined) throw new Error("The benchmark produced no samples")
  return median
}

export async function throttleCpu(
  page: Page,
  rate: number,
): Promise<{ restore: () => Promise<void> }> {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Emulation.setCPUThrottlingRate", { rate })
  } catch (error) {
    await session.detach()
    throw error
  }
  let restored: Promise<void> | undefined
  return {
    restore() {
      restored ??= (async () => {
        try {
          await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
        } finally {
          await session.detach()
        }
      })()
      return restored
    },
  }
}

export async function calibrateThrottle(
  browser: Browser,
  measure: (page: Page) => Promise<number> = measureBenchmarkIndex,
): Promise<{ rate: number; hostIndex: number; targetIndex: number }> {
  const { page, close } = await newPage(browser)
  try {
    const hostIndex = await measure(page)
    const firstRate = throttleRateFor(hostIndex)
    const throttle = await throttleCpu(page, firstRate)
    let achievedIndex: number
    try {
      achievedIndex = await measure(page)
    } finally {
      await throttle.restore()
    }
    const rate = Math.max(1, (firstRate * achievedIndex) / TARGET_INDEX)
    return { rate, hostIndex, targetIndex: TARGET_INDEX }
  } finally {
    await close()
  }
}
