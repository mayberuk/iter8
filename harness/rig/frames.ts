import type { Page } from "playwright"

type FrameResult = {
  intervals: number[]
  vsyncMs: number
  late: number
  worstMs: number
  elapsedMs: number
}

export function summarizeFrames(intervals: number[], elapsedMs: number): FrameResult {
  const sorted = intervals.toSorted((a, b) => a - b)
  const vsyncMs = sorted[Math.floor((sorted.length - 1) * 0.1)] ?? 0
  // Intervals are quantised to vsync, so one above 1.5× the period spans a missed frame.
  const late = intervals.filter((interval) => interval > 1.5 * vsyncMs).length
  return { intervals, vsyncMs, late, worstMs: sorted.at(-1) ?? 0, elapsedMs }
}

export async function startFrameProbe(page: Page): Promise<{ stop: () => Promise<FrameResult> }> {
  const key = `iter8-frames-${crypto.randomUUID()}`
  await page.evaluate((key) => {
    const started = performance.now()
    const intervals: number[] = []
    let previous: number | null = null
    let handle = 0
    const tick = (time: number) => {
      if (previous !== null) intervals.push(time - previous)
      previous = time
      handle = requestAnimationFrame(tick)
    }
    handle = requestAnimationFrame(tick)
    Reflect.set(window, key, () => {
      cancelAnimationFrame(handle)
      Reflect.deleteProperty(window, key)
      return { intervals, elapsedMs: performance.now() - started }
    })
  }, key)
  let result: Promise<FrameResult> | undefined
  return {
    stop() {
      result ??= page
        .evaluate((key) => {
          const stop = Reflect.get(window, key) as () => { intervals: number[]; elapsedMs: number }
          return stop()
        }, key)
        .then(({ intervals, elapsedMs }) => summarizeFrames(intervals, elapsedMs))
      return result
    },
  }
}
