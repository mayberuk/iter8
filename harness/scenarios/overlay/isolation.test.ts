import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  ASSET_PREFIX,
  OVERLAY_PREFIX,
  OVERLAY_SCRIPT_PATH,
  OverlayBoot,
  Pairing,
  PROTOCOL_VERSION,
  SOURCE_BUNDLE_PATH,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import type { MockService } from "../../stubs/mock-service"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
/** The dock's `--paper` in the light token set. */
const LIGHT_PAPER = "rgb(252, 251, 246)"

let browser: Browser
let overlayBuild: Scratch
const cleanups: (() => Promise<void>)[] = []

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open() {
  const opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE },
    browser,
  })
  cleanups.push(opened.close)
  await until("the dock to be ready", () =>
    opened.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  return opened
}

/** The same page from the same service, with the overlay's script refused. */
async function openWithoutOverlay(
  mock: MockService,
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<Page> {
  const bare = await newPage(browser)
  cleanups.push(bare.close)
  await bare.page.route(`**${OVERLAY_SCRIPT_PATH}`, (route) => route.abort())
  await beforeLoad?.(bare.page)
  await bare.page.goto(mock.pageUrl())
  return bare.page
}

/** Runs in the page before any script: lists the listeners currently attached to window and document. */
function trackPageListeners() {
  type Entry = { target: EventTarget; type: string; listener: unknown; capture: boolean }
  const active: Entry[] = []
  const captureOf = (
    options: boolean | AddEventListenerOptions | EventListenerOptions | undefined,
  ) => (typeof options === "boolean" ? options : options?.capture === true)
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if ((this === window || this === document) && listener) {
      const capture = captureOf(options)
      const known = active.some(
        (entry) =>
          entry.target === this &&
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === capture,
      )
      if (!known) active.push({ target: this, type, listener, capture })
    }
    return add.call(this, type, listener, options)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const capture = captureOf(options)
    const index = active.findIndex(
      (entry) =>
        entry.target === this &&
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture,
    )
    if (index >= 0) active.splice(index, 1)
    return remove.call(this, type, listener, options)
  }
  Object.defineProperty(window, "__pageListeners", {
    value: () =>
      active
        .map(
          (entry) =>
            `${entry.target === window ? "window" : "document"}:${entry.type}:${entry.capture ? "capture" : "bubble"}`,
        )
        .sort(),
  })
}

const pageListeners = (page: Page) =>
  page.evaluate(() => (window as unknown as { __pageListeners: () => string[] }).__pageListeners())

function pageShape(page: Page) {
  return page.evaluate(() => ({
    globals: Object.getOwnPropertyNames(window).sort(),
    head: [...document.head.children].map((el) => el.outerHTML),
    root: [...document.documentElement.children].map((el) => el.tagName),
    htmlClass: document.documentElement.className,
    htmlStyle: document.documentElement.getAttribute("style"),
  }))
}

describe("the host page is left as it was", () => {
  test("mounting adds no global, no head element, and only the host element", async () => {
    const { page, mock } = await open()
    const withOverlay = await pageShape(page)
    const without = await pageShape(await openWithoutOverlay(mock))

    expect(withOverlay.globals).toEqual(without.globals)
    expect(withOverlay.head).toEqual(without.head)
    expect(without.root).toEqual(["HEAD", "BODY"])
    expect(withOverlay.root).toEqual(["HEAD", "BODY", "ITER8-OVERLAY"])
    expect(withOverlay.htmlClass).toBe(without.htmlClass)
    expect(withOverlay.htmlStyle).toBe(without.htmlStyle)
  }, 30_000)

  test("the dock lives in one open shadow root on the host element and adds no style element", async () => {
    const { page } = await open()
    const shape = await page.evaluate(() => {
      const hosts = document.querySelectorAll("iter8-overlay")
      const root = hosts[0]?.shadowRoot
      return {
        hosts: hosts.length,
        parent: hosts[0]?.parentElement?.tagName,
        mode: root?.mode,
        dockInRoot: root?.querySelector('[role="toolbar"]') !== null,
        dockInPage: document.querySelector('[role="toolbar"]') !== null,
        styleElements: root?.querySelectorAll("style").length,
        sheets: root?.adoptedStyleSheets.length,
      }
    })
    expect(shape).toEqual({
      hosts: 1,
      parent: "HTML",
      mode: "open",
      dockInRoot: true,
      dockInPage: false,
      styleElements: 0,
      sheets: 2,
    })
  }, 30_000)

  test("a second mount creates no second host", async () => {
    const { page, mock } = await open()
    const boot = OverlayBoot.parse({
      protocolVersion: PROTOCOL_VERSION,
      pageId: mock.pageId,
      machineId: mock.machineId,
      machineName: "mock-machine",
      token: mock.token,
      apiBase: OVERLAY_PREFIX,
      sourceBundleUrl: SOURCE_BUNDLE_PATH,
    })
    const hosts = await page.evaluate(
      async ({ path, boot }) => {
        const { mount } = await import(path)
        const teardown = mount(boot)
        const hosts = document.querySelectorAll("iter8-overlay").length
        teardown()
        return hosts
      },
      { path: OVERLAY_SCRIPT_PATH, boot },
    )
    expect(hosts).toBe(1)
    expect(await page.getByRole("button", { name: "Pick element" }).isVisible()).toBe(true)
  }, 30_000)

  test("removing the host hands every click and key back to the page", async () => {
    const { page, overlay } = await open()
    await page.evaluate(() => {
      const keys: { key: string; prevented: boolean }[] = []
      let clicks = 0
      window.addEventListener("keydown", (event) => {
        keys.push({ key: event.key, prevented: event.defaultPrevented })
        document.body.dataset.keys = JSON.stringify(keys)
      })
      document.querySelector("button")?.addEventListener("click", () => {
        clicks += 1
        document.body.dataset.clicks = String(clicks)
      })
    })
    const seen = () =>
      page.evaluate(() => ({
        keys: JSON.parse(document.body.dataset.keys ?? "[]") as unknown[],
        clicks: Number(document.body.dataset.clicks ?? 0),
      }))

    await page.keyboard.press("c")
    await until(
      "pick mode",
      async () =>
        (await overlay
          .getByRole("button", { name: "Pick element" })
          .getAttribute("aria-pressed")) === "true",
    )
    expect((await seen()).keys).toEqual([])

    await page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
    await page.keyboard.press("c")
    expect((await seen()).keys).toEqual([{ key: "c", prevented: false }])
    await page.getByRole("button", { name: "Save" }).first().click()
    expect((await seen()).clicks).toBe(1)
    expect(await page.locator("iter8-overlay").count()).toBe(0)
  }, 30_000)
})

describe("teardown", () => {
  test("removing the host leaves the window and document listeners the page started with", async () => {
    const { page, mock } = await open()
    await page.addInitScript(trackPageListeners)
    await page.reload()
    await until("the dock after reload", () =>
      page.getByRole("button", { name: "Pick element" }).isVisible(),
    )
    const baseline = await pageListeners(
      await openWithoutOverlay(mock, async (bare) => {
        await bare.addInitScript(trackPageListeners)
      }),
    )

    const mounted = await pageListeners(page)
    expect(mounted.length).toBeGreaterThan(baseline.length)
    expect(mounted).toContain("window:keydown:capture")

    await page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
    await waitFor(
      "the listeners to be removed",
      async () =>
        JSON.stringify(await pageListeners(page)) === JSON.stringify(baseline) ? true : null,
      { timeoutMs: 5000 },
    )
  }, 30_000)
})

describe("styles and fonts", () => {
  test("the dock is styled under a CSP that refuses inline styles", async () => {
    const { page, mock, overlay, errors } = await open()
    await page.route(mock.pageUrl("/"), async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": "style-src 'self'" },
      })
    })
    errors.length = 0
    const policy = page.waitForResponse(
      (response) =>
        response.url() === mock.pageUrl("/") && "content-security-policy" in response.headers(),
    )
    await page.reload()
    await policy
    const pick = overlay.getByRole("button", { name: "Pick element" })
    await until("the dock after reload", () => pick.isVisible())
    const background = await overlay
      .getByRole("toolbar", { name: "iter8 annotation tools" })
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(background).toBe(LIGHT_PAPER)
    expect(errors.filter((error) => error.includes("Content Security Policy"))).toEqual([])
  }, 30_000)

  test("fonts load from the overlay's asset path", async () => {
    const { page, mock } = await open()
    await until("the overlay font", () =>
      page.evaluate(() => {
        const face = [...document.fonts].find(
          (candidate) => candidate.family.replaceAll('"', "") === "iter8 Figtree",
        )
        return face?.status === "loaded" && document.fonts.check('13px "iter8 Figtree"')
      }),
    )
    const fonts = mock.requests().filter((request) => request.path.endsWith(".woff2"))
    expect(fonts.length).toBe(2)
    for (const request of fonts) expect(request.path.startsWith(ASSET_PREFIX)).toBe(true)
  }, 30_000)
})
