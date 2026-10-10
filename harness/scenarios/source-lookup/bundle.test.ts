import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import type { Browser, Page } from "playwright"
import { buildOverlayBundles } from "../../../scripts/build"
import { launchChromium } from "../../rig/browser"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import { type RunningService, startService } from "../../rig/service"
import { lookupInPage, resolveInPage, startSourceRig } from "./lookup"

const CARD = '[data-source-target="card"]'
const RIG_TIMEOUT_MS = 120_000

type Steps = NonNullable<Parameters<typeof startSourceRig>[0]>
type Made = { outDir?: string; service?: RunningService; browser?: Browser }

function recorded(replace: Partial<Steps> = {}): { steps: Steps; made: Made } {
  const made: Made = {}
  const steps: Steps = {
    build: async (options) => {
      if (options?.outDir !== undefined) made.outDir = options.outDir
      return (replace.build ?? buildOverlayBundles)(options)
    },
    start: async (options) => {
      made.service = await (replace.start ?? startService)(options)
      return made.service
    },
    launch: async (options) => {
      made.browser = await (replace.launch ?? launchChromium)(options)
      return made.browser
    },
  }
  return { steps, made }
}

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function expectReleased({ outDir, service, browser }: Made) {
  if (outDir === undefined) throw new Error("the bundle scratch was never made")
  expect(existsSync(outDir)).toBe(false)
  if (service !== undefined) {
    expect(processAlive(service.pid)).toBe(false)
    expect(existsSync(service.home)).toBe(false)
  }
  if (browser !== undefined) expect(browser.isConnected()).toBe(false)
}

async function releaseAnyway({ outDir, service, browser }: Made) {
  await Promise.allSettled([
    service?.stop(),
    browser?.close(),
    outDir === undefined ? undefined : rm(outDir, { recursive: true, force: true }),
  ])
}

async function startFailing(steps: Steps): Promise<unknown> {
  const outcome = await startSourceRig(steps).then(
    (started) => ({ started }),
    (error: unknown) => ({ error }),
  )
  if ("started" in outcome) {
    await outcome.started.stop()
    throw new Error("startSourceRig was expected to fail")
  }
  return outcome.error
}

let fixture: RunningFixture
let rig: Awaited<ReturnType<typeof startSourceRig>>
const shared = recorded()

beforeAll(async () => {
  fixture = await startFixture("static")
  rig = await startSourceRig(shared.steps)
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  try {
    await rig?.stop()
  } finally {
    await fixture?.stop()
  }
})

const hostTraces = (page: Page) =>
  page.evaluate(() => ({
    names: Object.getOwnPropertyNames(window).sort(),
    prepareStackTrace: String(Error.prepareStackTrace),
    devtoolsHook: "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window,
  }))

test("a page with no supported framework gives a none lead that resolves as no-framework", async () => {
  const view = await rig.open(fixture)
  try {
    const lead = await lookupInPage(view, CARD)
    expect(lead).toEqual({ confidence: "none" })
    if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
    expect(await resolveInPage(view, lead)).toEqual({ confidence: "none", reason: "no-framework" })
  } finally {
    await view.close()
  }
})

test("importing the bundle and running a lookup leaves no trace on the host page", async () => {
  const view = await rig.open(fixture)
  try {
    const before = await hostTraces(view.page)
    expect(before.devtoolsHook).toBe(false)
    expect(await lookupInPage(view, CARD)).toEqual({ confidence: "none" })
    expect(await hostTraces(view.page)).toEqual(before)
  } finally {
    await view.close()
  }
})

test("a lookup whose signal aborts rejects with an AbortError", async () => {
  const view = await rig.open(fixture)
  try {
    expect(await lookupInPage(view, CARD, { abortAfterMs: 0 })).toEqual({ rejected: "AbortError" })
  } finally {
    await view.close()
  }
})

test("a view's close closes its page context", async () => {
  const browser = shared.made.browser
  if (browser === undefined) throw new Error("the shared rig never launched a browser")
  const before = browser.contexts().length
  const view = await rig.open(fixture)
  expect(browser.contexts()).toHaveLength(before + 1)
  await view.close()
  expect(browser.contexts()).toHaveLength(before)
  expect(view.page.isClosed()).toBe(true)
})

test("an open whose navigation fails leaves no page context behind", async () => {
  const browser = shared.made.browser
  if (browser === undefined) throw new Error("the shared rig never launched a browser")
  const before = browser.contexts().length
  await expect(rig.open(fixture, "http://127.0.0.1:1/")).rejects.toThrow()
  expect(browser.contexts()).toHaveLength(before)
})

test(
  "a build that fails leaves no bundle scratch",
  async () => {
    const failure = new Error("build failed")
    const { steps, made } = recorded({
      build: async () => {
        throw failure
      },
    })
    try {
      expect(await startFailing(steps)).toBe(failure)
      expect(made.service).toBeUndefined()
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "a service that fails to start leaves no bundle scratch",
  async () => {
    const failure = new Error("start failed")
    const { steps, made } = recorded({
      start: async () => {
        throw failure
      },
    })
    try {
      expect(await startFailing(steps)).toBe(failure)
      expect(made.service).toBeUndefined()
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "a browser that fails to launch stops the service and removes the bundle scratch",
  async () => {
    const failure = new Error("launch failed")
    const { steps, made } = recorded({
      launch: async () => {
        throw failure
      },
    })
    try {
      expect(await startFailing(steps)).toBe(failure)
      if (made.service === undefined) throw new Error("the service was never started")
      expect(processAlive(made.service.pid)).toBe(false)
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "stop closes the browser, stops the service and removes the bundle scratch",
  async () => {
    const { steps, made } = recorded()
    try {
      const started = await startSourceRig(steps)
      if (made.service === undefined || made.browser === undefined) {
        throw new Error("the rig never made its service and browser")
      }
      expect(processAlive(made.service.pid)).toBe(true)
      expect(made.browser.isConnected()).toBe(true)
      await started.stop()
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "stop still stops the service and removes the scratch when closing the browser throws",
  async () => {
    const failure = new Error("browser close failed")
    const { steps, made } = recorded({
      launch: async (options) => {
        const browser = await launchChromium(options)
        const close = browser.close.bind(browser)
        browser.close = async () => {
          await close()
          throw failure
        }
        return browser
      },
    })
    try {
      const started = await startSourceRig(steps)
      await expect(started.stop()).rejects.toBe(failure)
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "stop still removes the scratch when stopping the service throws",
  async () => {
    const failure = new Error("service stop failed")
    const { steps, made } = recorded({
      start: async (options) => {
        const service = await startService(options)
        const stop = service.stop
        return {
          ...service,
          stop: async () => {
            await stop()
            throw failure
          },
        }
      },
    })
    try {
      const started = await startSourceRig(steps)
      await expect(started.stop()).rejects.toBe(failure)
      expectReleased(made)
    } finally {
      await releaseAnyway(made)
    }
  },
  RIG_TIMEOUT_MS,
)
