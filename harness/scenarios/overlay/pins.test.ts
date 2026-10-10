import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { type ElementAnchor, Note, OVERLAY_ROUTES, Pairing } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import unanchoredJson from "../../../packages/protocol/fixtures/Note.unanchored.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const LIVE = Pairing.parse(pairingJson)
const PUT_DRAFT = new RegExp(`${OVERLAY_ROUTES.putDraft.path.replace(":noteId", "[^/]+")}$`)

type Target = Pick<ElementAnchor, "selector" | "role" | "text"> & Partial<ElementAnchor>

function anchor(target: Target): ElementAnchor {
  return {
    box: { x: 0, y: 0, width: 100, height: 30 },
    renderGeneration: 0,
    ...target,
  }
}

function draft(id: string, target: Target, extra: Record<string, unknown> = {}) {
  return Note.parse({
    ...noteJson,
    id,
    pageId: "mockpage",
    target: { kind: "element", anchor: anchor(target) },
    ...extra,
  })
}

function agentNote(id: string, target: Target, extra: Record<string, unknown> = {}) {
  return Note.parse({
    ...unanchoredJson,
    id,
    pageId: "mockpage",
    anchorStatus: "anchored",
    target: { kind: "element", anchor: anchor(target) },
    ...extra,
  })
}

const OVERVIEW = { selector: ["h2#overview-heading"], role: "heading", text: "Overview" }
const DETAILS = { selector: ["h2#details-heading"], role: "heading", text: "Details" }
const CARD = { selector: ['p[data-source-target="card"]'], text: "Card in static" }
const GONE_AGENT = { selector: ["aside.missing-panel"], text: "Docs" }

const seed = (drafts: Note[] = [], agentNotes: Note[] = []) => ({
  pairing: LIVE,
  pageState: { drafts, rounds: [], agentNotes },
})

let browser: Browser
let overlayBuild: Scratch
let opened: Awaited<ReturnType<typeof openOverlay>> | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

async function open(mock: Parameters<typeof openOverlay>[0]["mock"] = {}) {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, mock, browser })
  return opened
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

type Opened = Awaited<ReturnType<typeof open>>

/** A pushed message reaches only an open socket, so push until its effect shows. */
async function pushUntil(
  o: Opened,
  message: Parameters<Opened["mock"]["push"]>[0],
  done: () => Promise<boolean>,
) {
  await waitFor(
    "the pushed message to take effect",
    async () => {
      o.mock.push(message)
      return (await done()) ? true : null
    },
    { timeoutMs: 8000, everyMs: 100 },
  )
}

const pinNamed = (overlay: Locator, name: string) => overlay.getByRole("button", { name })
const movedList = (overlay: Locator) => overlay.getByRole("list", { name: "Moved notes" })
const unanchoredList = (overlay: Locator) => overlay.getByRole("list", { name: "Unanchored notes" })

async function centre(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error("no bounding box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function rectOf(page: Page, selector: string) {
  return page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) throw new Error(`nothing matches ${css}`)
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }, selector)
}

const nextFrame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

const putBodies = (o: Opened) =>
  o.mock
    .requests()
    .filter((request) => request.method === "PUT" && PUT_DRAFT.test(request.path))
    .map((request) => request.body as { anchorStatus: string })

describe("note pins", () => {
  test("a seeded draft is pinned at its element and its hover card shows the note", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - (target.left + 2))).toBeLessThanOrEqual(2)
    expect(Math.abs(at.y - (target.top + 2))).toBeLessThanOrEqual(2)

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    const text = await card.innerText()
    expect(text).toContain("Fix")
    expect(text).toContain("The price wraps onto two lines at this width; keep it on one.")
    expect(text).toContain("Click to edit")
  }, 30_000)

  test("after a scroll the pin is back on its element's corner within one frame", async () => {
    const o = await open(seed([draft("N21", DETAILS)]))
    await o.page.setViewportSize({ width: 1280, height: 300 })
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    const before = await centre(pin)

    await o.page.evaluate(() => window.scrollTo(0, 120))
    await nextFrame(o.page)
    expect(await o.page.evaluate(() => window.scrollY)).toBe(120)

    const target = await rectOf(o.page, "h2#details-heading")
    const after = await centre(pin)
    expect(Math.abs(after.x - (target.left + 2))).toBeLessThanOrEqual(2)
    expect(Math.abs(after.y - (target.top + 2))).toBeLessThanOrEqual(2)
    expect(before.y - after.y).toBeGreaterThan(100)
  }, 30_000)

  test("after the page reloads the pins are restored from the service drafts", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    await o.page.evaluate(() => document.body.setAttribute("data-before-reload", ""))
    const helloCount = () =>
      o.mock.requests().filter((request) => request.path === OVERLAY_ROUTES.hello.path).length
    const hellosBefore = helloCount()

    await pushUntil(
      o,
      { type: "upstream-failure", port: 5173, url: "http://localhost:5173/src/main.tsx" },
      () => o.overlay.getByText(/port 5173 failed/).isVisible(),
    )
    const loaded = o.page.waitForEvent("load", { timeout: 8000 })
    o.mock.push({ type: "reload" })
    await loaded
    await until("the pin to come back", () => pin.isVisible())
    expect(await o.page.evaluate(() => document.body.hasAttribute("data-before-reload"))).toBe(
      false,
    )
    expect(helloCount()).toBeGreaterThan(hellosBefore)
    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - (target.left + 2))).toBeLessThanOrEqual(2)
  }, 30_000)

  test("a removed element moves the note to the tray and saves it as moved", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin", () => pin.isVisible())
    expect(putBodies(o)).toEqual([])

    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())

    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const row = list.getByRole("listitem")
    expect(await row.count()).toBe(1)
    const text = await row.innerText()
    expect(text).toContain("Moved")
    expect(text).toContain("element gone")
    expect(text).toContain("The price wraps onto two lines")
    expect(await pin.count()).toBe(0)
    expect(await o.overlay.getByText("1 note lost its element").isVisible()).toBe(true)

    await until("the PUT", () => putBodies(o).length > 0)
    expect(putBodies(o).map((body) => body.anchorStatus)).toEqual(["moved"])
    expect(o.mock.draft().map((note) => note.anchorStatus)).toEqual(["moved"])
  }, 30_000)

  test("a note whose element matches several equally near candidates says more than one match", async () => {
    const probe = await open()
    const centres = await probe.page.evaluate(() =>
      Array.from(document.querySelectorAll("main button"), (button) => {
        const r = button.getBoundingClientRect()
        return {
          x: r.left + r.width / 2 + window.scrollX,
          y: r.top + r.height / 2 + window.scrollY,
        }
      }),
    )
    await probe.close()
    opened = null
    const [first, second] = centres
    if (!first || !second || centres.length !== 3) throw new Error("expected three Save buttons")
    const middle = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
    const equidistant = { x: middle.x - 100, y: middle.y - 100, width: 200, height: 200 }

    const o = await open(
      seed([
        draft("N21", {
          selector: ["button#removed-save"],
          role: "button",
          text: "Save",
          box: equidistant,
        }),
      ]),
    )
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const text = await list.getByRole("listitem").innerText()
    expect(text).toContain("more than one match")
    expect(text).toContain("Moved")
    expect(await pinNamed(o.overlay, "Note 1, Fix").count()).toBe(0)
  }, 40_000)

  test("Re-pick puts the page in pick mode", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    const pickTool = o.overlay.getByRole("button", { name: "Pick element" })
    expect(await pickTool.getAttribute("aria-pressed")).toBe("false")

    await list.getByRole("button", { name: "Re-pick" }).click()
    await until("pick mode", async () => (await pickTool.getAttribute("aria-pressed")) === "true")
  }, 30_000)

  test("Re-pick saves the next picked element as the note's target and empties the tray", async () => {
    const o = await open(seed([draft("N21", CARD)]))
    await o.page.evaluate(() => document.querySelector('p[data-source-target="card"]')?.remove())
    const list = movedList(o.overlay)
    await until("the moved list", () => list.isVisible())
    await until("the moved PUT", () => putBodies(o).length > 0)

    await list.getByRole("button", { name: "Re-pick" }).click()
    const target = await rectOf(o.page, "h2#details-heading")
    await o.page.mouse.move(target.left + 4, target.top + 4)
    await o.page.mouse.click(target.left + 4, target.top + 4)

    await until("the tray to empty", async () => (await list.count()) === 0, 8000)
    await until("the anchored PUT", () => putBodies(o).at(-1)?.anchorStatus === "anchored")
    const saved = o.mock.draft()[0]
    expect(saved?.target).toMatchObject({
      kind: "element",
      anchor: { selector: ["h2#details-heading"] },
    })
    expect(saved?.anchorStatus).toBe("anchored")
    expect(Note.parse(noteJson).capture).toBeDefined()
    expect(saved?.capture).toBeUndefined()
    expect(saved?.body).toBe("The price wraps onto two lines at this width; keep it on one.")

    const pin = pinNamed(o.overlay, "Note 1, Fix")
    await until("the pin on the new element", () => pin.isVisible())
    const moved = await rectOf(o.page, "h2#details-heading")
    const at = await centre(pin)
    expect(Math.abs(at.y - (moved.top + 2))).toBeLessThanOrEqual(2)
  }, 30_000)
})

describe("agent pins", () => {
  test("a pushed agent note appears as an avatar pin on its element and can be removed", async () => {
    const o = await open(seed())
    const note = agentNote("N31", OVERVIEW)
    const pin = pinNamed(o.overlay, "Claude note")
    await pushUntil(o, { type: "agent-note", note }, () => pin.isVisible())

    const target = await rectOf(o.page, "h2#overview-heading")
    const at = await centre(pin)
    expect(Math.abs(at.x - target.right)).toBeLessThanOrEqual(20)
    expect(Math.abs(at.y - target.top)).toBeLessThanOrEqual(20)
    expect(await pin.getByRole("img", { name: "Claude" }).count()).toBe(1)

    await pin.hover()
    const card = o.overlay.getByRole("tooltip")
    await until("the hover card", () => card.isVisible())
    const text = await card.innerText()
    expect(text).toContain("Claude")
    expect(text).toContain("This footer link points at the old docs.")

    await pushUntil(
      o,
      { type: "agent-note-removed", noteId: note.id },
      async () => (await pin.count()) === 0,
    )
  }, 30_000)

  test("an agent note whose element is not on the page is listed as unanchored", async () => {
    const o = await open(seed([], [agentNote("N32", GONE_AGENT)]))
    const list = unanchoredList(o.overlay)
    await until("the unanchored list", () => list.isVisible())
    const row = list.getByRole("listitem")
    expect(await row.count()).toBe(1)
    const text = await row.innerText()
    expect(text).toContain("Unanchored")
    expect(text).toContain("This footer link points at the old docs.")
    expect(await pinNamed(o.overlay, "Claude note").count()).toBe(0)
    expect(await movedList(o.overlay).count()).toBe(0)
  }, 30_000)
})

describe("pin visibility", () => {
  test("P hides the pins and shows them again", async () => {
    const o = await open(seed([draft("N21", OVERVIEW)], [agentNote("N31", DETAILS)]))
    const note = pinNamed(o.overlay, "Note 1, Fix")
    const agent = pinNamed(o.overlay, "Claude note")
    await until("both pins", async () => (await note.isVisible()) && (await agent.isVisible()))

    await o.page.keyboard.press("p")
    await until(
      "the pins to hide",
      async () => !(await note.isVisible()) && !(await agent.isVisible()),
    )
    await until("the pref to save", () => !o.mock.prefs().pinsVisible)

    await o.page.keyboard.press("p")
    await until(
      "the pins to show",
      async () => (await note.isVisible()) && (await agent.isVisible()),
    )
  }, 30_000)
})
