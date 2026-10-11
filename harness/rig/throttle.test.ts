import { expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { calibrateThrottle, measureBenchmarkIndex, throttleCpu, throttleRateFor } from "./throttle"

function fakeBrowser({ failThrottle = false }: { failThrottle?: boolean } = {}) {
  const sent: { method: string; rate: number }[] = []
  let rate = 1
  let detached = 0
  let closed = 0
  const session = {
    async send(method: string, params: { rate: number }) {
      if (failThrottle && params.rate !== 1) throw new Error("throttle failed")
      sent.push({ method, rate: params.rate })
      rate = params.rate
    },
    async detach() {
      detached++
    },
  }
  const page = {
    on() {},
    context: () => context,
  }
  const context = {
    newPage: async () => page,
    newCDPSession: async () => session,
    close: async () => {
      closed++
    },
  }
  return {
    browser: { newContext: async () => context } as unknown as Browser,
    page: page as unknown as Page,
    sent,
    rateInEffect: () => rate,
    detached: () => detached,
    closed: () => closed,
  }
}

function scriptedMeasure(fake: ReturnType<typeof fakeBrowser>, indexes: number[]) {
  const rates: number[] = []
  const pages: Page[] = []
  const measure = async (page: Page) => {
    pages.push(page)
    rates.push(fake.rateInEffect())
    const index = indexes.shift()
    if (index === undefined) throw new Error("measured more often than scripted")
    return index
  }
  return { measure, rates, pages }
}

async function withFakeClock<T>(stepMs: number, run: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(globalThis, "performance")
  if (!real) throw new Error("No global performance to replace")
  let now = 0
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now() {
        const value = now
        now += stepMs
        return value
      },
    },
  })
  try {
    return await run()
  } finally {
    Object.defineProperty(globalThis, "performance", real)
  }
}

test("a host at the reference index is throttled 4×", () => {
  expect(throttleRateFor(58_000)).toBe(4)
})

test("a host twice as fast as the reference is throttled twice as hard", () => {
  expect(throttleRateFor(116_000)).toBe(8)
})

test("a host exactly at the throttled target runs unthrottled", () => {
  expect(throttleRateFor(14_500)).toBe(1)
})

test("a host slower than the throttled target fails naming both indexes", () => {
  expect(() => throttleRateFor(10_000)).toThrow(/10000.*14500/)
})

test("a host at the reference index is calibrated to 4× and a throttled run on target keeps it", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [58_000, 14_500])
  expect(await calibrateThrottle(fake.browser, measure)).toEqual({
    rate: 4,
    hostIndex: 58_000,
    targetIndex: 14_500,
  })
})

test("a host twice as fast as the reference keeps its derived rate when the throttled run is on target", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [116_000, 14_500])
  expect(await calibrateThrottle(fake.browser, measure)).toEqual({
    rate: 8,
    hostIndex: 116_000,
    targetIndex: 14_500,
  })
})

test("a throttled run below target lowers the rate by achieved over target", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [58_000, 12_000])
  const { rate, hostIndex } = await calibrateThrottle(fake.browser, measure)
  expect(rate).toBeCloseTo((4 * 12_000) / 14_500, 10)
  expect(hostIndex).toBe(58_000)
})

test("a throttled run above target raises the rate by achieved over target", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [58_000, 20_000])
  const { rate } = await calibrateThrottle(fake.browser, measure)
  expect(rate).toBeCloseTo((4 * 20_000) / 14_500, 10)
})

test("a correction that would fall below 1 is clamped to 1", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [14_500, 7_250])
  expect((await calibrateThrottle(fake.browser, measure)).rate).toBe(1)
})

test("calibration measures the host unthrottled, then throttled at the derived rate", async () => {
  const fake = fakeBrowser()
  const { measure, rates, pages } = scriptedMeasure(fake, [116_000, 14_500])
  await calibrateThrottle(fake.browser, measure)
  expect(rates).toEqual([1, 8])
  expect(pages[0]).toBe(fake.page)
  expect(pages[1]).toBe(fake.page)
})

test("calibration closes its page and restores the throttle after success", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [58_000, 14_500])
  await calibrateThrottle(fake.browser, measure)
  expect(fake.closed()).toBe(1)
  expect(fake.detached()).toBe(1)
  expect(fake.rateInEffect()).toBe(1)
})

test("a host just below the throttled target fails calibration and closes its page", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [14_499])
  await expect(calibrateThrottle(fake.browser, measure)).rejects.toThrow(/14499.*14500/)
  expect(fake.closed()).toBe(1)
  expect(fake.sent).toEqual([])
})

test("a host index of zero fails calibration", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [0])
  await expect(calibrateThrottle(fake.browser, measure)).rejects.toThrow(/\b0\b.*14500/)
  expect(fake.closed()).toBe(1)
})

test("a failing throttled measurement rejects, restores the throttle and closes the page", async () => {
  const fake = fakeBrowser()
  let calls = 0
  const measure = async () => {
    if (calls++ === 0) return 58_000
    throw new Error("page crashed")
  }
  await expect(calibrateThrottle(fake.browser, measure)).rejects.toThrow("page crashed")
  expect(fake.rateInEffect()).toBe(1)
  expect(fake.detached()).toBe(1)
  expect(fake.closed()).toBe(1)
})

test("a throttled measurement of zero still yields a rate of at least 1", async () => {
  const fake = fakeBrowser()
  const { measure } = scriptedMeasure(fake, [58_000, 0])
  expect((await calibrateThrottle(fake.browser, measure)).rate).toBe(1)
})

test("the benchmark index is the median of unordered samples with outliers", async () => {
  const page = { evaluate: async () => [90_000, 5, 15_000, 3, 14_000] } as unknown as Page
  expect(await measureBenchmarkIndex(page)).toBe(14_000)
})

test("the benchmark index counts string builds per second", async () => {
  const page = {
    evaluate: (run: (arg: { runs: number; runMs: number }) => Promise<number[]>, arg: never) =>
      run(arg),
  } as unknown as Page
  const index = await withFakeClock(10, () => measureBenchmarkIndex(page))
  expect(index).toBe(100)
})

test("restore sends rate 1 and detaches once however often and concurrently it is called", async () => {
  const fake = fakeBrowser()
  const throttle = await throttleCpu(fake.page, 4)
  expect(fake.sent).toEqual([{ method: "Emulation.setCPUThrottlingRate", rate: 4 }])
  await Promise.all([throttle.restore(), throttle.restore()])
  await throttle.restore()
  expect(fake.sent).toEqual([
    { method: "Emulation.setCPUThrottlingRate", rate: 4 },
    { method: "Emulation.setCPUThrottlingRate", rate: 1 },
  ])
  expect(fake.detached()).toBe(1)
})

test("a failure setting the rate detaches the session", async () => {
  const fake = fakeBrowser({ failThrottle: true })
  await expect(throttleCpu(fake.page, 4)).rejects.toThrow("throttle failed")
  expect(fake.detached()).toBe(1)
})
