import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type ElementAnchor, Note, OverlayPrefs, Pairing, Round } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay, withSourceBundle } from "./support"

const STATIC = fixtureDir("static")
const CARD = '[data-source-target="card"]'
const LIVE = Pairing.parse(pairingJson)
const SANS = "iter8 Reddit Sans"
const MONO = "iter8 JetBrains Mono"
const TRACKING_CEILING_EM = 0.02
const PATH =
  /^[\w@.~-]*(\/[\w@.-]+)+(:\d+){0,2}$|^[\w@.-]+\.(tsx?|jsx?|mjs|svelte|vue|astro|html|css)(:\d+){0,2}$|^[\w@.~-]+\/$/
const BARE_NUMBER = /^:?\d+(:\d+)?$/
const COUNTED = /^×?\d+$|^\d+ ?[×x] ?\d+$/
const SOURCE_ELEMENT = ".cmp-src .file, .prov .fl"

const TOUR_DONE = OverlayPrefs.parse({
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
})
const TOUR_PENDING = OverlayPrefs.parse({ ...TOUR_DONE, coachDone: false })

const anchor: ElementAnchor = {
  selector: [`p${CARD}`],
  text: "Card in static",
  box: { x: 0, y: 0, width: 100, height: 30 },
  renderGeneration: 0,
}
const DRAFT = Note.parse({
  ...noteJson,
  id: "N21",
  pageId: "mockpage",
  target: { kind: "element", anchor },
  capture: undefined,
})
const ROUND = Round.parse({
  ...roundJson,
  pageId: "mockpage",
  notes: roundJson.notes.map((note) => ({ ...note, pageId: "mockpage" })),
})
const SEEDED = {
  pairing: LIVE,
  prefs: TOUR_DONE,
  pageState: { drafts: [DRAFT], rounds: [ROUND], agentNotes: [] },
}

type Opened = Awaited<ReturnType<typeof openOverlay>>
type TextNode = {
  text: string
  whole: string
  family: string
  transform: string
  trackingEm: number
  numerals: string
  inKbd: boolean
  inSource: boolean
}

let browser: Browser
let overlayBuild: Scratch
let fakeSource: Scratch
let opened: Opened | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  fakeSource = await withSourceBundle(overlayBuild, "fake")
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await fakeSource?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open(mock: NonNullable<Parameters<typeof openOverlay>[0]["mock"]>) {
  opened = await openOverlay({ overlayDir: fakeSource.path, folder: STATIC, mock, browser })
  const o = opened
  await until("the dock to be ready", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  return o
}

function visibleText(page: Page, sourceElement: string): Promise<TextNode[]> {
  return page.evaluate((source) => {
    const root = document.querySelector("iter8-overlay")?.shadowRoot
    if (!root) throw new Error("no overlay shadow root")
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const found: TextNode[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim()
      const el = node.parentElement
      if (text === "" || !el || el.closest("style, script, title")) continue
      const style = getComputedStyle(el)
      if (style.visibility !== "visible" || el.getClientRects().length === 0) continue
      const tracking = style.letterSpacing === "normal" ? 0 : Number.parseFloat(style.letterSpacing)
      found.push({
        text,
        whole: (el.textContent ?? "").trim(),
        family: (style.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, ""),
        transform: style.textTransform,
        trackingEm: tracking / Number.parseFloat(style.fontSize),
        numerals: style.fontVariantNumeric,
        inKbd: el.closest("kbd") !== null,
        inSource: el.closest(source) !== null,
      })
    }
    return found
  }, sourceElement)
}

function expectedFamily(node: TextNode): string {
  if (node.inKbd || PATH.test(node.text)) return MONO
  if (node.inSource && BARE_NUMBER.test(node.text)) return MONO
  return SANS
}

async function audit(o: Opened, surface: string, wants: { mono: boolean }) {
  const nodes = await visibleText(o.page, SOURCE_ELEMENT)
  expect(nodes.length, `${surface} showed no text`).toBeGreaterThan(0)
  const failures: string[] = []
  for (const node of nodes) {
    const want = expectedFamily(node)
    if (node.family !== want)
      failures.push(`${surface}: "${node.text}" is in ${node.family}, expected ${want}`)
    if (node.transform !== "none")
      failures.push(`${surface}: "${node.text}" has text-transform ${node.transform}`)
    if (node.trackingEm > TRACKING_CEILING_EM)
      failures.push(`${surface}: "${node.text}" is tracked ${node.trackingEm.toFixed(3)}em`)
    if (
      COUNTED.test(node.whole) &&
      !node.inSource &&
      !node.inKbd &&
      !node.numerals.includes("tabular-nums")
    )
      failures.push(`${surface}: "${node.text}" is a count without tabular numerals`)
  }
  expect(failures).toEqual([])
  expect(
    nodes.some((node) => node.family === SANS),
    `${surface} showed no sans text`,
  ).toBe(true)
  if (wants.mono)
    expect(
      nodes.some((node) => node.family === MONO),
      `${surface} showed no path, line number or key`,
    ).toBe(true)
}

type Face = { family: string; numerals: string }

function faceOf(locator: Locator): Promise<Face> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el)
    return {
      family: (style.fontFamily.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, ""),
      numerals: style.fontVariantNumeric,
    }
  })
}

function expectDigitFace(face: Face, what: string) {
  expect(face.family, `${what} family`).toBe(SANS)
  expect(face.numerals, `${what} numerals`).toContain("tabular-nums")
}

describe("type roles on every surface", () => {
  test("the expanded dock, its round label and its menu", async () => {
    const o = await open(SEEDED)
    await until("the round label", async () =>
      /^Round \d+$/.test(await o.overlay.locator(".dock .rl").innerText()),
    )
    await audit(o, "dock", { mono: false })

    await o.overlay.getByRole("button", { name: "More options" }).click()
    await until("the menu", () => o.overlay.getByRole("menuitem").first().isVisible())
    await audit(o, "dock menu", { mono: true })
  }, 30_000)

  test("the hover chip and the composer after picking an element with a known source", async () => {
    const o = await open(SEEDED)
    await o.page.locator(CARD).evaluate((el) => el.setAttribute("data-fake-src", ""))
    await o.page.keyboard.press("c")
    const box = await o.page.locator(CARD).boundingBox()
    if (!box) throw new Error("the card has no box")
    await o.page.mouse.move(box.x + 20, box.y + box.height / 2)
    await until("the hover chip", () => o.overlay.locator(".chip.on").isVisible())
    await audit(o, "hover chip", { mono: true })

    await o.page.mouse.click(box.x + 20, box.y + box.height / 2)
    const composer = o.overlay.getByRole("dialog", { name: "New note" })
    await until("the composer", () => composer.isVisible())
    await until("the source lead", async () =>
      (await composer.innerText()).includes("src/Card.jsx"),
    )
    await audit(o, "composer", { mono: true })
  }, 30_000)

  test("the round sheet with history", async () => {
    const o = await open(SEEDED)
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await until("the round sheet", () => sheet.isVisible())
    await audit(o, "round sheet, this round", { mono: false })

    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the history", () => sheet.getByRole("article").first().isVisible())
    await audit(o, "round sheet, history", { mono: true })
  }, 30_000)

  test("the command palette", async () => {
    const o = await open(SEEDED)
    const palette = o.overlay.getByRole("dialog", { name: "Command palette" })
    await o.page.keyboard.press("ControlOrMeta+K")
    await until("the palette", () => palette.isVisible())
    await audit(o, "command palette", { mono: true })
  }, 30_000)

  test("the keyboard-shortcut grid", async () => {
    const o = await open(SEEDED)
    const keys = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })
    await o.page.keyboard.press("?")
    await until("the shortcut grid", () => keys.isVisible())
    await audit(o, "keyboard shortcuts", { mono: true })
  }, 30_000)

  test("a hovered pin and its card", async () => {
    const o = await open(SEEDED)
    const pin = o.overlay.getByRole("button", { name: /^Note \d+, Fix$/ }).first()
    await until("the pin", () => pin.isVisible())
    await audit(o, "pin", { mono: false })

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    await audit(o, "pin hover card", { mono: false })
  }, 30_000)

  test("the first-run tour", async () => {
    const o = await open({ ...SEEDED, prefs: TOUR_PENDING })
    const coach = o.overlay.getByRole("dialog", { name: "Getting started" })
    await until("the tour", () => coach.isVisible())
    await audit(o, "tour", { mono: false })
  }, 30_000)

  test("the screenshot selection and the markup editor", async () => {
    const o = await open(SEEDED)
    await o.page.keyboard.press("s")
    await o.page.mouse.move(100, 100)
    await o.page.mouse.down()
    await o.page.mouse.move(340, 260, { steps: 6 })
    const coords = o.overlay.locator(".shotlayer .coords")
    await until("the coordinates badge", () =>
      coords.evaluate((el) => getComputedStyle(el).visibility === "visible"),
    )
    await audit(o, "screenshot selection", { mono: false })
    expectDigitFace(
      await faceOf(coords),
      "the coordinates badge (a canvas, so its digits are not DOM text)",
    )
    await o.page.mouse.up()

    const markup = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
    await until("the markup editor", async () => (await markup.innerText()).includes("240 × 160"))
    await markup.locator("img").waitFor({ timeout: 10_000 })
    await audit(o, "markup editor", { mono: true })
    const dims = markup.locator(".mk-h .dims")
    expect(await dims.innerText()).toBe("240 × 160")
    expectDigitFace(await faceOf(dims), "the markup dimensions")
  }, 30_000)
})
