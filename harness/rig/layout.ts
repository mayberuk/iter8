import type { Page } from "playwright"

type LayoutResult = { layouts: number; styleRecalcs: number }

export async function startLayoutProbe(page: Page): Promise<{ stop: () => Promise<LayoutResult> }> {
  const session = await page.context().newCDPSession(page)
  const read = async () => {
    const { metrics } = await session.send("Performance.getMetrics")
    const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0
    return { layouts: value("LayoutCount"), styleRecalcs: value("RecalcStyleCount") }
  }
  let before: LayoutResult
  try {
    await session.send("Performance.enable")
    before = await read()
  } catch (error) {
    await session.detach()
    throw error
  }
  let result: Promise<LayoutResult> | undefined
  return {
    stop() {
      result ??= (async () => {
        try {
          const after = await read()
          await session.send("Performance.disable")
          return {
            layouts: after.layouts - before.layouts,
            styleRecalcs: after.styleRecalcs - before.styleRecalcs,
          }
        } finally {
          await session.detach()
        }
      })()
      return result
    },
  }
}
