import { expect, test } from "bun:test"
import type { Page } from "playwright"
import { startLayoutProbe } from "./layout"

type Metrics = Record<string, number>

function fakePage(readings: Metrics[], { failOn }: { failOn?: string } = {}) {
  const sent: string[] = []
  let detached = 0
  let reading = 0
  const session = {
    async send(method: string) {
      sent.push(method)
      if (method === failOn) throw new Error(`${method} failed`)
      if (method !== "Performance.getMetrics") return {}
      const metrics = readings[reading++] ?? {}
      return { metrics: Object.entries(metrics).map(([name, value]) => ({ name, value })) }
    },
    async detach() {
      detached++
    },
  }
  const page = { context: () => ({ newCDPSession: async () => session }) }
  return { page: page as unknown as Page, sent, detached: () => detached }
}

test("layouts and style recalcs are each the delta from the reading at start", async () => {
  const { page } = fakePage([
    { LayoutCount: 7, RecalcStyleCount: 3, Nodes: 900 },
    { LayoutCount: 12, RecalcStyleCount: 10, Nodes: 950 },
  ])
  const probe = await startLayoutProbe(page)
  expect(await probe.stop()).toEqual({ layouts: 5, styleRecalcs: 7 })
})

test("stop reads the metrics, disables the domain and detaches the session", async () => {
  const fake = fakePage([
    { LayoutCount: 1, RecalcStyleCount: 1 },
    { LayoutCount: 2, RecalcStyleCount: 2 },
  ])
  const probe = await startLayoutProbe(fake.page)
  expect(fake.sent).toEqual(["Performance.enable", "Performance.getMetrics"])
  expect(fake.detached()).toBe(0)
  await probe.stop()
  expect(fake.sent).toEqual([
    "Performance.enable",
    "Performance.getMetrics",
    "Performance.getMetrics",
    "Performance.disable",
  ])
  expect(fake.detached()).toBe(1)
})

test("stop called twice and concurrently reads once and detaches once", async () => {
  const fake = fakePage([
    { LayoutCount: 4, RecalcStyleCount: 4 },
    { LayoutCount: 9, RecalcStyleCount: 6 },
  ])
  const probe = await startLayoutProbe(fake.page)
  const [first, second] = await Promise.all([probe.stop(), probe.stop()])
  const third = await probe.stop()
  expect(first).toEqual({ layouts: 5, styleRecalcs: 2 })
  expect(second).toBe(first)
  expect(third).toBe(first)
  expect(fake.sent.filter((method) => method === "Performance.getMetrics")).toHaveLength(2)
  expect(fake.sent.filter((method) => method === "Performance.disable")).toHaveLength(1)
  expect(fake.detached()).toBe(1)
})

test("a failure while starting detaches the session", async () => {
  const fake = fakePage([], { failOn: "Performance.enable" })
  await expect(startLayoutProbe(fake.page)).rejects.toThrow("Performance.enable failed")
  expect(fake.detached()).toBe(1)
})

test("a failure while stopping still detaches the session", async () => {
  const fake = fakePage([{ LayoutCount: 1, RecalcStyleCount: 1 }], {
    failOn: "Performance.disable",
  })
  const probe = await startLayoutProbe(fake.page)
  await expect(probe.stop()).rejects.toThrow("Performance.disable failed")
  expect(fake.detached()).toBe(1)
})
