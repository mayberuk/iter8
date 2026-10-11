import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Note, Pairing } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const ANCHOR_TOLERANCE_PX = 1
const VIEWPORT = { width: 1280, height: 720 }
const TEST_MS = 30_000

const DOCK = '[role="toolbar"][aria-label="iter8 annotation tools"]'
const SHEET = 'aside[aria-label="Round sheet"]'
const COMPOSER = '[role="dialog"][aria-label="New note"]'
const PALETTE = ".palette"

type Opened = Awaited<ReturnType<typeof openOverlay>>
type Rect = { x: number; y: number; width: number; height: number }

let browser: Browser
let overlayBuild: Scratch

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

const draft = Note.parse({
  ...noteJson,
  id: "N40",
  pageId: "mockpage",
  capture: undefined,
  target: {
    kind: "element",
    anchor: {
      box: { x: 0, y: 0, width: 100, height: 30 },
      renderGeneration: 0,
      selector: ["h2#overview-heading"],
      role: "heading",
      text: "Overview",
    },
  },
})

async function open(): Promise<Opened> {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE, pageState: { drafts: [draft], rounds: [], agentNotes: [] } },
    browser,
  })
  await o.page.setViewportSize(VIEWPORT)
  await o.page.evaluate(() => {
    const room = document.createElement("div")
    room.style.height = "3000px"
    document.body.append(room)
  })
  return o
}

/** The viewport rect of the first match in the overlay's shadow root, once nothing on it animates. */
async function settledRect(page: Page, selector: string): Promise<Rect> {
  return waitFor(
    `${selector} to show and settle`,
    () =>
      page.evaluate((selector) => {
        const el = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(selector)
        if (!el || el.getClientRects().length === 0) return null
        if (el.getAnimations().some((animation) => animation.playState !== "finished")) return null
        const { x, y, width, height } = el.getBoundingClientRect()
        return { x, y, width, height }
      }, selector),
    { timeoutMs: 10_000, everyMs: 100 },
  )
}

async function scrollPastAViewport(page: Page): Promise<void> {
  const scrolled = await page.evaluate(async () => {
    window.scrollTo(0, Math.round(window.innerHeight * 1.5))
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    return window.scrollY - window.innerHeight
  })
  expect(scrolled).toBeGreaterThan(0)
}

function expectAnchored(name: string, before: Rect, after: Rect) {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(
      Math.abs(after[key] - before[key]),
      `${name} ${key} moved from ${before[key]} to ${after[key]}`,
    ).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX)
  }
}

describe("overlay layers inside a host at the page origin", () => {
  test(
    "the host carries no containment, transform, filter or will-change",
    async () => {
      const o = await open()
      try {
        await settledRect(o.page, DOCK)
        const style = await o.page.evaluate(() => {
          const host = document.querySelector("iter8-overlay")
          if (!host) throw new Error("no overlay host")
          const computed = getComputedStyle(host)
          return {
            contain: computed.contain,
            transform: computed.transform,
            filter: computed.filter,
            willChange: computed.willChange,
            position: computed.position,
            width: computed.width,
            height: computed.height,
          }
        })
        expect(style).toEqual({
          contain: "none",
          transform: "none",
          filter: "none",
          willChange: "auto",
          position: "absolute",
          width: "0px",
          height: "0px",
        })
        expect(o.errors).toEqual([])
      } finally {
        await o.close()
      }
    },
    TEST_MS,
  )

  test(
    "the dock and the round sheet stay put in the viewport across a scroll of more than a viewport",
    async () => {
      const o = await open()
      try {
        await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
        const before = {
          dock: await settledRect(o.page, DOCK),
          sheet: await settledRect(o.page, SHEET),
        }
        await scrollPastAViewport(o.page)
        expectAnchored("the dock", before.dock, await settledRect(o.page, DOCK))
        expectAnchored("the round sheet", before.sheet, await settledRect(o.page, SHEET))
        expect(o.errors).toEqual([])
      } finally {
        await o.close()
      }
    },
    TEST_MS,
  )

  test(
    "the round sheet at full height is painted and hit-tested from its top to its bottom edge",
    async () => {
      const o = await open()
      try {
        await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
        const sheet = await settledRect(o.page, SHEET)
        expect(sheet.height).toBeGreaterThan(VIEWPORT.height / 2)
        expect(sheet.y + sheet.height).toBeLessThanOrEqual(VIEWPORT.height)
        const hits = await o.page.evaluate(
          ({ selector, points }) => {
            const root = document.querySelector("iter8-overlay")?.shadowRoot
            const el = root?.querySelector(selector)
            if (!root || !el) throw new Error("no round sheet")
            return points.map(({ x, y }) => el.contains(root.elementFromPoint(x, y)))
          },
          {
            selector: SHEET,
            points: [
              { x: sheet.x + sheet.width / 2, y: sheet.y + 4 },
              { x: sheet.x + sheet.width / 2, y: sheet.y + sheet.height / 2 },
              { x: sheet.x + sheet.width / 2, y: sheet.y + sheet.height - 4 },
              { x: sheet.x + 4, y: sheet.y + sheet.height - 4 },
            ],
          },
        )
        expect(hits).toEqual([true, true, true, true])
        expect(o.errors).toEqual([])
      } finally {
        await o.close()
      }
    },
    TEST_MS,
  )

  test(
    "an open composer on a fixed element stays put in the viewport across a scroll of more than a viewport",
    async () => {
      const o = await open()
      try {
        await o.page.evaluate(() => {
          const pinned = document.createElement("div")
          pinned.id = "pinned-target"
          pinned.textContent = "Pinned target"
          pinned.style.cssText =
            "position:fixed;top:120px;left:120px;width:240px;height:60px;background:#eee"
          document.body.append(pinned)
        })
        await o.page.keyboard.press("c")
        const pick = o.overlay.getByRole("button", { name: "Pick element" })
        await waitFor("pick mode", async () =>
          (await pick.getAttribute("aria-pressed")) === "true" ? true : null,
        )
        await o.page.locator("#pinned-target").click()
        await waitFor("the note field to take focus", () =>
          o.page.evaluate(async () => {
            const active = document.querySelector("iter8-overlay")?.shadowRoot?.activeElement
            if (!active?.matches('textarea[aria-label="Note"]')) return null
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
            return true
          }),
        )
        const before = await settledRect(o.page, COMPOSER)
        await scrollPastAViewport(o.page)
        expectAnchored("the composer", before, await settledRect(o.page, COMPOSER))
        expect(o.errors).toEqual([])
      } finally {
        await o.close()
      }
    },
    TEST_MS,
  )

  test(
    "the command palette stays put in the viewport across a scroll of more than a viewport",
    async () => {
      const o = await open()
      try {
        await settledRect(o.page, DOCK)
        await o.page.keyboard.press("ControlOrMeta+K")
        const before = await settledRect(o.page, PALETTE)
        await scrollPastAViewport(o.page)
        expectAnchored("the palette", before, await settledRect(o.page, PALETTE))
        expect(o.errors).toEqual([])
      } finally {
        await o.close()
      }
    },
    TEST_MS,
  )
})
