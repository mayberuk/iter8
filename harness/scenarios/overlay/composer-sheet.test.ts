import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Note, Pairing } from "@iter8/protocol"
import type { Browser, Locator } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay, withSourceBundle } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const TEST_MS = 30_000
const GAP = 12
const TYPED = "Move this banner under the heading"

type Opened = Awaited<ReturnType<typeof openOverlay>>

let browser: Browser
let overlayBuild: Scratch
let noSource: Scratch
let opened: Opened | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  noSource = await withSourceBundle(overlayBuild, "none")
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await noSource?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

function regionDraft(box: { x: number; y: number; width: number; height: number }) {
  return Note.parse({
    ...noteJson,
    id: "N30",
    pageId: "mockpage",
    body: "Put a banner here",
    intent: "change",
    target: {
      kind: "region",
      box,
      viewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    },
    capture: undefined,
  })
}

const dialog = (o: Opened) => o.overlay.getByRole("dialog", { name: "Edit note" })
const noteBox = (o: Opened) => o.overlay.getByRole("textbox", { name: "Note" })
const sheetOf = (o: Opened) => o.overlay.getByRole("complementary", { name: "Round sheet" })

const settled = (locator: Locator) =>
  locator.evaluate((el) =>
    el.getAnimations().every((animation) => animation.playState === "finished"),
  )

async function editRegionNote(
  viewport: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
): Promise<Opened> {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { pairing: LIVE, pageState: { drafts: [regionDraft(box)], rounds: [], agentNotes: [] } },
    browser,
  })
  opened = o
  await o.page.setViewportSize(viewport)
  await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
  await until("the round sheet", () => sheetOf(o).isVisible())
  await o.overlay.getByRole("button", { name: "Edit note 1" }).click()
  await until("the composer", () => dialog(o).isVisible())
  await until("the sheet and the composer to settle", async () => {
    const [sheet, composer] = [await settled(sheetOf(o)), await settled(dialog(o))]
    return sheet && composer
  })
  return o
}

async function topmostAtCentre(o: Opened, target: Locator, selector: string): Promise<boolean> {
  const box = await target.boundingBox()
  if (!box) throw new Error("the target has no box")
  return o.page.evaluate(
    ({ x, y, match }) =>
      document.querySelector("iter8-overlay")?.shadowRoot?.elementFromPoint(x, y)?.matches(match) ??
      false,
    { x: box.x + box.width / 2, y: box.y + box.height / 2, match: selector },
  )
}

async function typeIntoComposer(o: Opened) {
  await until("the note box to take focus", () =>
    noteBox(o).evaluate((box) => box.getRootNode() instanceof ShadowRoot && box.matches(":focus")),
  )
  await noteBox(o).fill("")
  await o.page.keyboard.type(TYPED)
  await until(
    "the typed text to land in the note box",
    async () => (await noteBox(o).inputValue()) === TYPED,
  )
}

describe("the composer beside the round sheet", () => {
  test(
    "sits entirely left of the sheet when the viewport leaves room, and takes the typing",
    async () => {
      const o = await editRegionNote(
        { width: 1000, height: 700 },
        { x: 700, y: 150, width: 100, height: 60 },
      )
      const [composer, sheet] = [await dialog(o).boundingBox(), await sheetOf(o).boundingBox()]
      if (!composer || !sheet) throw new Error("the composer or the sheet has no box")
      expect(composer.x + composer.width).toBeLessThanOrEqual(sheet.x - GAP + 0.5)
      await typeIntoComposer(o)
    },
    TEST_MS,
  )

  test(
    "paints over the sheet and hit-tests as the topmost element when the viewport leaves no room",
    async () => {
      const o = await editRegionNote(
        { width: 720, height: 700 },
        { x: 700, y: 150, width: 100, height: 60 },
      )
      const [composer, sheet] = [await dialog(o).boundingBox(), await sheetOf(o).boundingBox()]
      if (!composer || !sheet) throw new Error("the composer or the sheet has no box")
      expect(composer.x + composer.width).toBeGreaterThan(sheet.x)
      expect(await topmostAtCentre(o, noteBox(o), 'textarea[aria-label="Note"]')).toBe(true)
      await typeIntoComposer(o)
    },
    TEST_MS,
  )
})

describe("surfaces above the composer", () => {
  test(
    "the command palette paints over the composer",
    async () => {
      const o = await editRegionNote(
        { width: 1000, height: 700 },
        { x: 700, y: 100, width: 100, height: 60 },
      )
      await o.page.keyboard.press("ControlOrMeta+K")
      const input = o.overlay.locator('input[aria-label="Command"]')
      await until("the palette input", () => input.isVisible())
      const [field, composer] = [await input.boundingBox(), await dialog(o).boundingBox()]
      if (!field || !composer) throw new Error("the palette input or the composer has no box")
      const centre = { x: field.x + field.width / 2, y: field.y + field.height / 2 }
      expect(centre.x).toBeGreaterThan(composer.x)
      expect(centre.x).toBeLessThan(composer.x + composer.width)
      expect(centre.y).toBeGreaterThan(composer.y)
      expect(centre.y).toBeLessThan(composer.y + composer.height)
      expect(await topmostAtCentre(o, input, 'input[aria-label="Command"]')).toBe(true)
    },
    TEST_MS,
  )

  test(
    "the shortcut sheet opened over the composer is topmost wherever they overlap",
    async () => {
      const o = await editRegionNote(
        { width: 1000, height: 700 },
        { x: 700, y: 100, width: 100, height: 60 },
      )
      await o.page.keyboard.press("ControlOrMeta+K")
      const input = o.overlay.locator('input[aria-label="Command"]')
      await until("the palette input", () => input.isVisible())
      await input.fill("keyboard shortcuts")
      await input.press("Enter")
      const keys = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })
      await until("the shortcut sheet", () => keys.isVisible())
      await until("the shortcut sheet to settle", () => settled(keys))
      expect(await dialog(o).isVisible()).toBe(true)

      const [sheet, composer] = [await keys.boundingBox(), await dialog(o).boundingBox()]
      if (!sheet || !composer) throw new Error("the shortcut sheet or the composer has no box")
      const left = Math.max(sheet.x, composer.x)
      const right = Math.min(sheet.x + sheet.width, composer.x + composer.width)
      const top = Math.max(sheet.y, composer.y)
      const bottom = Math.min(sheet.y + sheet.height, composer.y + composer.height)
      expect(right - left).toBeGreaterThan(40)
      expect(bottom - top).toBeGreaterThan(40)

      const points = [
        [left + 4, top + 4],
        [right - 4, top + 4],
        [(left + right) / 2, (top + bottom) / 2],
        [left + 4, bottom - 4],
        [right - 4, bottom - 4],
      ] as const
      const hits = await o.page.evaluate((at) => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        return at.map(
          ([x, y]) => root?.elementFromPoint(x, y)?.closest(".keysheet") instanceof Element,
        )
      }, points)
      expect(hits).toEqual(points.map(() => true))
    },
    TEST_MS,
  )

  test(
    "a tooltip on a composer control paints over the composer",
    async () => {
      opened = await openOverlay({
        overlayDir: noSource.path,
        folder: STATIC,
        browser,
      })
      const o = opened
      await o.page.keyboard.press("c")
      await o.page.locator('[data-source-target="card"]').click()
      const badge = o.overlay.getByRole("status", { name: "Source confidence" })
      await until("the unresolved source badge", () => badge.isVisible(), 10_000)
      await badge.hover()
      const tip = o.overlay.getByRole("tooltip")
      await until("the tooltip", () => tip.isVisible())
      await until("the tooltip to settle", () => settled(tip))
      await tip.evaluate((el) => {
        if (el instanceof HTMLElement) el.style.pointerEvents = "auto"
      })
      const [tipBox, composer] = [
        await tip.boundingBox(),
        await o.overlay.getByRole("dialog", { name: "New note" }).boundingBox(),
      ]
      if (!tipBox || !composer) throw new Error("the tooltip or the composer has no box")
      expect(tipBox.y).toBeGreaterThan(composer.y)
      expect(tipBox.x + tipBox.width / 2).toBeGreaterThan(composer.x)
      expect(tipBox.x + tipBox.width / 2).toBeLessThan(composer.x + composer.width)
      expect(await topmostAtCentre(o, tip, '[role="tooltip"], [role="tooltip"] *')).toBe(true)
    },
    TEST_MS,
  )
})
