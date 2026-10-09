import type { Page } from "playwright"

type LongTaskResult = { longestMs: number; count: number; tasks: number[] }

export async function startLongTaskProbe(
  page: Page,
): Promise<{ stop: () => Promise<LongTaskResult> }> {
  const key = `iter8-long-task-${crypto.randomUUID()}`
  await page.evaluate((key) => {
    if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      throw new Error("This browser does not support long-task observation")
    }
    const started = performance.now()
    const tasks: number[] = []
    const collect = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        if (entry.startTime >= started) tasks.push(entry.duration)
      }
    }
    const observer = new PerformanceObserver((list) => collect(list.getEntries()))
    observer.observe({ type: "longtask", buffered: false })
    Reflect.set(window, key, () => {
      collect(observer.takeRecords())
      observer.disconnect()
      Reflect.deleteProperty(window, key)
      return {
        longestMs: tasks.reduce((longest, duration) => Math.max(longest, duration), 0),
        count: tasks.length,
        tasks,
      }
    })
  }, key)
  let result: Promise<LongTaskResult> | undefined
  return {
    stop() {
      result ??= page.evaluate((key) => {
        const stop = Reflect.get(window, key) as () => LongTaskResult
        return stop()
      }, key)
      return result
    },
  }
}
