import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import {
  ASSET_PREFIX,
  LIVE_PATH,
  OVERLAY_PREFIX,
  OVERLAY_ROUTES,
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
import { buildOverlay, openOverlay, withSourceBundle } from "./support"

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

async function open(mock: Parameters<typeof openOverlay>[0]["mock"] = { pairing: LIVE }) {
  const opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock,
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
    body: document.body.innerHTML,
    elements: document.querySelectorAll("*").length,
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
    expect(withOverlay.body).toBe(without.body)
    expect(withOverlay.elements).toBe(without.elements + 1)
  }, 30_000)

  test("with menus, a tooltip and a toast showing, the page body is still untouched and no sheet is added twice", async () => {
    const { page, mock, overlay } = await open({
      pairing: LIVE,
      pageState: { drafts: [], rounds: [], agentNotes: [] },
    })
    const without = await pageShape(await openWithoutOverlay(mock))
    const sheets = () =>
      page.evaluate(
        () => document.querySelector("iter8-overlay")?.shadowRoot?.adoptedStyleSheets.length,
      )
    const before = await sheets()
    await overlay.getByRole("button", { name: "More options" }).click()
    await overlay
      .getByRole("radiogroup", { name: "Theme" })
      .locator("label")
      .filter({ hasText: "Dark" })
      .click()
    await overlay.getByRole("button", { name: /^Session larkspur/ }).click()
    await overlay.getByRole("button", { name: "Pick element" }).hover()
    await until("the tooltip", () => overlay.getByRole("tooltip").isVisible())
    await until("the toast", () =>
      overlay
        .getByRole("status")
        .filter({ hasText: /Theme Dark/ })
        .isVisible(),
    )
    const shape = await pageShape(page)
    expect(shape.body).toBe(without.body)
    expect(shape.head).toEqual(without.head)
    expect(shape.elements).toBe(without.elements + 1)
    expect(await sheets()).toBe(before)
  }, 30_000)

  test("the dock lives in one open shadow root on the host element and adds no style element", async () => {
    const { page } = await open()
    const shape = await page.evaluate(() => {
      const hosts = document.querySelectorAll("iter8-overlay")
      const root = hosts[0]?.shadowRoot
      const texts = [...(root?.adoptedStyleSheets ?? [])].map((sheet) =>
        [...sheet.cssRules].map((rule) => rule.cssText).join("\n"),
      )
      return {
        hosts: hosts.length,
        parent: hosts[0]?.parentElement?.tagName,
        mode: root?.mode,
        dockInRoot: root?.querySelector('[role="toolbar"]') !== null,
        dockInPage: document.querySelector('[role="toolbar"]') !== null,
        styleElements: root?.querySelectorAll("style").length,
        linkElements: root?.querySelectorAll("link").length,
        sheets: texts.length,
        distinctSheets: new Set(texts).size,
      }
    })
    expect(shape.sheets).toBeGreaterThan(0)
    expect(shape).toEqual({
      hosts: 1,
      parent: "HTML",
      mode: "open",
      dockInRoot: true,
      dockInPage: false,
      styleElements: 0,
      linkElements: 0,
      sheets: shape.sheets,
      distinctSheets: shape.sheets,
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
  async function trackedOpen(mock?: Parameters<typeof open>[0]) {
    const opened = await open(mock)
    await opened.page.addInitScript(trackPageListeners)
    await opened.page.reload()
    await until("the dock after reload", () =>
      opened.page.getByRole("button", { name: /Pick element/ }).isVisible(),
    )
    const baseline = await pageListeners(
      await openWithoutOverlay(opened.mock, async (bare) => {
        await bare.addInitScript(trackPageListeners)
      }),
    )
    return { ...opened, baseline }
  }

  async function removeHostAndExpectBaseline(page: Page, baseline: string[]) {
    await page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
    await waitFor(
      "the listeners to be removed",
      async () =>
        JSON.stringify(await pageListeners(page)) === JSON.stringify(baseline) ? true : null,
      { timeoutMs: 5000 },
    )
  }

  test("removing the host leaves the window and document listeners the page started with", async () => {
    const { page, baseline } = await trackedOpen()
    const mounted = await pageListeners(page)
    expect(mounted.length).toBeGreaterThan(baseline.length)
    expect(mounted).toContain("window:keydown:capture")
    await removeHostAndExpectBaseline(page, baseline)
  }, 30_000)

  test("removing the host with the More menu open also removes the menu's pointer listener", async () => {
    const { page, overlay, baseline } = await trackedOpen()
    const closed = await pageListeners(page)
    await overlay.getByRole("button", { name: "More options" }).click()
    await until("the menu's listener", async () =>
      (await pageListeners(page)).includes("window:pointerdown:capture"),
    )
    expect(closed).not.toContain("window:pointerdown:capture")
    await removeHostAndExpectBaseline(page, baseline)
  }, 30_000)

  test("removing the host with the session menu open removes the menu's pointer listener", async () => {
    const { page, overlay, baseline } = await trackedOpen({ pairing: null })
    await until("the attach menu", () =>
      overlay.getByRole("dialog", { name: "Attach this page to a session" }).isVisible(),
    )
    await until("the menu's listener", async () =>
      (await pageListeners(page)).includes("window:pointerdown:capture"),
    )
    await removeHostAndExpectBaseline(page, baseline)
  }, 30_000)

  test("removing the host before the first hello finishes leaves nothing running afterwards", async () => {
    const { page, mock, baseline } = await trackedOpen()
    let release = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(`**${OVERLAY_ROUTES.hello.path}`, async (route) => {
      await released
      await route.continue()
    })
    const requestsBefore = mock.requests().length
    await page.reload()
    await until("the connecting dock", () =>
      page.locator("iter8-overlay").getByRole("toolbar").isVisible(),
    )
    await page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
    const answered = page.waitForResponse((response) =>
      response.url().endsWith(OVERLAY_ROUTES.hello.path),
    )
    release()
    await answered
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 0), 0)),
    )
    expect(await page.locator("iter8-overlay").count()).toBe(0)
    expect(JSON.stringify(await pageListeners(page))).toBe(JSON.stringify(baseline))
    const opened = mock.requests().slice(requestsBefore)
    expect(opened.filter((request) => request.path === LIVE_PATH)).toEqual([])
  }, 30_000)
})

describe("a malformed boot", () => {
  test("is refused: nothing mounts and nothing is thrown into the page", async () => {
    const { page, mock, errors } = await open()
    const good = OverlayBoot.parse({
      protocolVersion: PROTOCOL_VERSION,
      pageId: mock.pageId,
      machineId: mock.machineId,
      machineName: "mock-machine",
      token: mock.token,
      apiBase: OVERLAY_PREFIX,
      sourceBundleUrl: SOURCE_BUNDLE_PATH,
    })
    await page.evaluate(() => document.querySelector("iter8-overlay")?.remove())
    await until("the host to go", async () => (await page.locator("iter8-overlay").count()) === 0)
    errors.length = 0
    const malformed: unknown[] = [
      null,
      "boot",
      {},
      { ...good, token: 42 },
      { ...good, protocolVersion: "one" },
      { ...good, pageId: undefined },
    ]
    const outcome = await page.evaluate(
      async ({ path, malformed }) => {
        const { mount } = await import(path)
        const results = malformed.map((boot) => {
          try {
            const teardown = mount(boot)
            return {
              threw: false,
              teardown: typeof teardown,
              hosts: document.querySelectorAll("iter8-overlay").length,
            }
          } catch {
            return {
              threw: true,
              teardown: "none",
              hosts: document.querySelectorAll("iter8-overlay").length,
            }
          }
        })
        return results
      },
      { path: OVERLAY_SCRIPT_PATH, malformed },
    )
    for (const result of outcome) {
      expect(result).toEqual({ threw: false, teardown: "function", hosts: 0 })
    }
    expect(errors).toEqual([])
    expect(
      mock.requests().filter((request) => request.path === OVERLAY_ROUTES.hello.path).length,
    ).toBe(1)

    await page.evaluate(
      async ({ path, good }) => {
        const { mount } = await import(path)
        mount(good)
      },
      { path: OVERLAY_SCRIPT_PATH, good },
    )
    await until("a good boot to mount", () =>
      page.locator("iter8-overlay").getByRole("button", { name: "Pick element" }).isVisible(),
    )
  }, 30_000)
})

describe("the source bundle helper", () => {
  test("none removes source.js, fake supplies one the page can load, and the original is untouched", async () => {
    const original = await readdir(overlayBuild.path)
    const none = await withSourceBundle(overlayBuild, "none")
    cleanups.push(() => none.dispose())
    const fake = await withSourceBundle(overlayBuild, "fake")
    cleanups.push(() => fake.dispose())
    expect(await readdir(none.path)).not.toContain("source.js")
    expect(await readdir(none.path)).toContain("overlay.js")
    expect(await readdir(fake.path)).toContain("source.js")
    expect(await readdir(overlayBuild.path)).toEqual(original)

    const served: Record<string, number> = {}
    for (const [label, dir] of [
      ["none", none.path],
      ["fake", fake.path],
    ] as const) {
      const { page } = await openOverlay({
        overlayDir: dir,
        folder: STATIC,
        mock: { pairing: LIVE },
        browser,
      }).then((opened) => {
        cleanups.push(opened.close)
        return opened
      })
      served[label] = await page.evaluate(
        async (path) => (await fetch(path)).status,
        SOURCE_BUNDLE_PATH,
      )
      if (label === "fake") {
        const exported = await page.evaluate(
          async (path) => Object.keys(await import(path)),
          SOURCE_BUNDLE_PATH,
        )
        expect(exported).toEqual(["lookupSource"])
      }
    }
    expect(served).toEqual({ none: 404, fake: 200 })
  }, 60_000)
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
