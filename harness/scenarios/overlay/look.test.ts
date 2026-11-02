import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { type ElementAnchor, Note, OverlayPrefs, Pairing, Round } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
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
const UI_DIR = join(import.meta.dir, "../../../apps/overlay/src/ui")
const SPRING = "cubic-bezier(0.32, 1.42, 0.52, 1)"
/** `var(--spring)` uses across the overlay's stylesheets, comments excluded, before the look audit. */
const PRE_AUDIT_SPRING_USES = 21
const EXEMPT = ".pin, .apin, kbd"

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

/**
 * Every visible shadow-root element holding visible text, its own or a descendant's, that is drawn
 * as a capsule: a fill, a border or a ring, and every corner rounded to at least half its height.
 */
function capsules(page: Page): Promise<string[]> {
  return page.evaluate((exempt) => {
    const root = document.querySelector("iter8-overlay")?.shadowRoot
    if (!root) throw new Error("no overlay shadow root")
    const transparent = (color: string) =>
      color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color)
    const faded = (el: Element) => {
      for (let at: Element | null = el; at; at = at.parentElement)
        if (getComputedStyle(at).opacity === "0") return true
      return false
    }
    const shown = (el: Element) =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility === "visible" && !faded(el)
    const found: string[] = []
    for (const el of root.querySelectorAll<HTMLElement>("*")) {
      if (el.closest(exempt)) continue
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      const texts: string[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        const text = node.textContent?.trim() ?? ""
        if (text !== "" && parent && !parent.closest(exempt) && shown(parent)) texts.push(text)
      }
      const own = texts.join(" ")
      if (own === "") continue
      const style = getComputedStyle(el)
      const height = el.offsetHeight
      if (!shown(el) || height === 0) continue
      const filled = !transparent(style.backgroundColor) || style.backgroundImage !== "none"
      const bordered = (["Top", "Right", "Bottom", "Left"] as const).some(
        (side) =>
          Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
          !["none", "hidden"].includes(
            style.getPropertyValue(`border-${side.toLowerCase()}-style`),
          ) &&
          !transparent(style.getPropertyValue(`border-${side.toLowerCase()}-color`)),
      )
      const ringed = style.boxShadow !== "none"
      if (!filled && !bordered && !ringed) continue
      const corners = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ].map((value) => {
        const parts = value.split(" ")
        const vertical = parts[1] ?? parts[0] ?? "0"
        const n = Number.parseFloat(vertical)
        return vertical.endsWith("%") ? (n / 100) * height : n
      })
      if (Math.min(...corners) >= height / 2)
        found.push(`${el.tagName.toLowerCase()}.${el.className} "${own}"`)
    }
    return found
  }, EXEMPT)
}

async function expectNoCapsules(o: Opened, surface: string) {
  expect(await capsules(o.page), `${surface} drew text as a capsule`).toEqual([])
}

type Plate = { fill: string; image: string; border: string; shadow: string; color: string }

function plateOf(page: Page, selector: string, className?: string): Promise<Plate> {
  return page.evaluate(
    ([sel, cls]) => {
      const el = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(sel ?? "")
      if (!(el instanceof HTMLElement)) throw new Error(`no ${sel}`)
      if (cls !== undefined) el.className = cls
      const style = getComputedStyle(el)
      return {
        fill: style.backgroundColor,
        image: style.backgroundImage,
        border: style.borderTopStyle === "none" ? "none" : style.borderTopWidth,
        shadow: style.boxShadow,
        color: style.color,
      }
    },
    [selector, className] as const,
  )
}

function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const holder = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".root")
    if (!holder) throw new Error("no overlay root")
    const probe = document.createElement("i")
    probe.style.color = `var(${name})`
    holder.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, token)
}

const PLAIN = { fill: "rgba(0, 0, 0, 0)", image: "none", border: "none", shadow: "none" }

function expectPlain(plate: Plate, what: string) {
  expect({ ...plate, color: undefined }, `${what} still has a fill, a border or a ring`).toEqual({
    ...PLAIN,
    color: undefined,
  })
}

describe("no overlay text is drawn as a capsule", () => {
  test("the scan flags a filled, ringed or percent capsule with text, and nothing else", async () => {
    const o = await open(SEEDED)
    await o.page.evaluate(() => {
      const root = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".root")
      if (!root) throw new Error("no overlay root")
      const box =
        "position:fixed;left:20px;display:inline-block;height:20px;line-height:20px;padding:0 8px"
      const probes: [string, string, string, string][] = [
        ["span", "probe-half", "3 notes", "top:20px;border-radius:10px;background:#333;color:#fff"],
        ["span", "probe-percent", "done", "top:50px;width:60px;border-radius:50%;background:#333"],
        [
          "span",
          "probe-ring",
          "busy",
          "top:80px;border-radius:999px;box-shadow:inset 0 0 0 1px #888",
        ],
        ["span", "probe-border", "queued", "top:110px;border-radius:999px;border:1px solid #888"],
        ["span", "probe-under", "2", "top:140px;border-radius:9px;background:#333"],
        ["span", "probe-bare", "plain", "top:170px;border-radius:999px"],
        [
          "span",
          "probe-hidden",
          "gone",
          "top:200px;visibility:hidden;border-radius:999px;background:#333",
        ],
        ["span", "probe-dot", "", "top:230px;width:8px;border-radius:50%;background:#333"],
        ["kbd", "probe-kbd", "K", "top:260px;border-radius:999px;background:#333"],
        ["button", "pin probe-pin", "1", "top:290px;border-radius:999px;background:#333"],
        [
          "span",
          "probe-outring",
          "idle",
          "top:320px;border-radius:999px;box-shadow:0 0 0 1px #888",
        ],
        ["span", "probe-nested", "", "top:350px;border-radius:999px;background:#333"],
        ["span", "probe-faded", "3", "top:380px;opacity:0;border-radius:999px;background:#333"],
        [
          "span",
          "probe-scaled",
          "4",
          "top:410px;transform:scale(0.4);border-radius:6px;background:#333",
        ],
      ]
      for (const [tag, cls, text, css] of probes) {
        const el = document.createElement(tag)
        el.className = cls
        el.textContent = text
        el.setAttribute("style", `${box};${css}`)
        root.append(el)
      }
      const word = document.createElement("span")
      word.textContent = "busy"
      root.querySelector(".probe-nested")?.append(word)
    })
    const flagged = (await capsules(o.page)).map((found) => found.match(/probe-\w+/)?.[0])
    expect(flagged.sort()).toEqual([
      "probe-border",
      "probe-half",
      "probe-nested",
      "probe-outring",
      "probe-percent",
      "probe-ring",
    ])
  }, 30_000)

  test("the expanded dock and its menu", async () => {
    const o = await open(SEEDED)
    await until("the round label", async () =>
      /^Round \d+$/.test(await o.overlay.locator(".dock .rl").innerText()),
    )
    await expectNoCapsules(o, "dock")
    await o.overlay.getByRole("button", { name: "More options" }).click()
    await until("the menu", () => o.overlay.getByRole("menuitem").first().isVisible())
    await expectNoCapsules(o, "dock menu")
  }, 30_000)

  test("the collapsed dock and its draft badge", async () => {
    opened = await openOverlay({
      overlayDir: fakeSource.path,
      folder: STATIC,
      mock: { ...SEEDED, prefs: { ...TOUR_DONE, collapsed: true } },
      browser,
    })
    const o = opened
    const expand = o.overlay.getByRole("button", { name: "Expand iter8 dock" })
    await until("the collapsed dock", () => expand.isVisible())
    await until("the draft badge", async () => (await expand.innerText()).trim() === "1")
    await expectNoCapsules(o, "collapsed dock")
  }, 30_000)

  test("the hover chip and the composer", async () => {
    const o = await open(SEEDED)
    await o.page.locator(CARD).evaluate((el) => el.setAttribute("data-fake-src", ""))
    await o.page.keyboard.press("c")
    const box = await o.page.locator(CARD).boundingBox()
    if (!box) throw new Error("the card has no box")
    await o.page.mouse.move(box.x + 20, box.y + box.height / 2)
    await until("the hover chip", () => o.overlay.locator(".chip.on").isVisible())
    await expectNoCapsules(o, "hover chip")

    await o.page.mouse.click(box.x + 20, box.y + box.height / 2)
    const composer = o.overlay.getByRole("dialog", { name: "New note" })
    await until("the composer", () => composer.isVisible())
    await until("the source lead", async () =>
      (await composer.innerText()).includes("src/Card.jsx"),
    )
    await expectNoCapsules(o, "composer")
  }, 30_000)

  test("the round sheet with history", async () => {
    const o = await open(SEEDED)
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await until("the round sheet", () => sheet.isVisible())
    await expectNoCapsules(o, "round sheet, this round")
    await sheet.getByRole("tab", { name: /^History/ }).click()
    await until("the history", () => sheet.getByRole("article").first().isVisible())
    await expectNoCapsules(o, "round sheet, history")
  }, 30_000)

  test("the command palette and the keyboard-shortcut grid", async () => {
    const o = await open(SEEDED)
    await o.page.keyboard.press("ControlOrMeta+K")
    const palette = o.overlay.getByRole("dialog", { name: "Command palette" })
    await until("the palette", () => palette.isVisible())
    await expectNoCapsules(o, "command palette")
    await o.page.keyboard.press("Escape")
    await until("the palette to close", async () => !(await palette.isVisible()))
    await o.page.keyboard.press("?")
    const keys = o.overlay.getByRole("dialog", { name: "Keyboard shortcuts" })
    await until("the shortcut grid", () => keys.isVisible())
    await expectNoCapsules(o, "keyboard shortcuts")
  }, 30_000)

  test("a hovered pin and its card", async () => {
    const o = await open(SEEDED)
    const pin = o.overlay.getByRole("button", { name: /^Note \d+, Fix$/ }).first()
    await until("the pin", () => pin.isVisible())
    await expectNoCapsules(o, "pin")
    await pin.hover()
    await until("the hover card", () => o.overlay.getByRole("tooltip").isVisible())
    await expectNoCapsules(o, "pin hover card")
  }, 30_000)

  test("the first-run tour", async () => {
    const o = await open({ ...SEEDED, prefs: TOUR_PENDING })
    await until("the tour", () =>
      o.overlay.getByRole("dialog", { name: "Getting started" }).isVisible(),
    )
    await expectNoCapsules(o, "tour")
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
    await expectNoCapsules(o, "screenshot selection")
    await o.page.mouse.up()
    const markup = o.overlay.getByRole("dialog", { name: "Mark up screenshot" })
    await until("the markup editor", async () => (await markup.innerText()).includes("240 × 160"))
    await markup.locator("img").waitFor({ timeout: 10_000 })
    await expectNoCapsules(o, "markup editor")
  }, 30_000)
})

describe("short labels, counts and statuses are plain text", () => {
  test("note statuses keep their glyph and semantic colour with no plate", async () => {
    const o = await open(SEEDED)
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await sheet.getByRole("tab", { name: /^History/ }).click()
    const done = sheet.getByRole("status", { name: "done", exact: true })
    await until("a done status", () => done.isVisible())
    expect(await done.innerText()).toBe("done")
    expect(await done.locator("svg").count()).toBe(1)

    const expected = {
      queued: "--amber-t",
      working: "--amber-t",
      delivered: "--cobalt-t",
      done: "--keep-t",
      answered: "--keep-t",
      failed: "--fix-t",
    } as const
    for (const [state, token] of Object.entries(expected)) {
      const plate = await plateOf(o.page, ".st-chip", `st-chip ${state}`)
      expectPlain(plate, `the ${state} status`)
      expect(plate.color, `the ${state} status colour`).toBe(await tokenColor(o.page, token))
    }
    expectPlain(await plateOf(o.page, ".st-chip", "st-chip moved"), "the moved status")
  }, 30_000)

  test("the sheet's tab counts, selected or not", async () => {
    const o = await open(SEEDED)
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await until("the round sheet", () => sheet.isVisible())
    const selected = '.sheet .tab[aria-selected="true"] .ct'
    const other = '.sheet .tab[aria-selected="false"] .ct'
    expectPlain(await plateOf(o.page, selected), "the selected tab count")
    expectPlain(await plateOf(o.page, other), "the unselected tab count")
    expect(await sheet.getByRole("tab", { name: /^This round/ }).innerText()).toMatch(/1$/)
  }, 30_000)

  test("the dock's draft count, with drafts and with none", async () => {
    const o = await open(SEEDED)
    expect(await o.overlay.locator(".counter .n").innerText()).toBe("1")
    expectPlain(await plateOf(o.page, ".counter .n"), "the draft count")
    expectPlain(await plateOf(o.page, ".counter .n", "n zero"), "the empty draft count")
  }, 30_000)

  test("the dock's session state word in every state that shows one", async () => {
    const o = await open({ ...SEEDED, pairing: { ...LIVE, state: { status: "busy" } } })
    await until("the busy word", async () => (await o.overlay.locator(".stword").count()) === 1)
    expect(await o.overlay.locator(".stword").innerText()).toBe("busy")
    expect(await o.overlay.locator(".stword svg").count()).toBe(1)
    const states = {
      "s-busy": "--busy-t",
      "s-delivered": "--cobalt-t",
      "s-gone": "--mute",
      "s-unattached": "--mute",
    } as const
    for (const [state, token] of Object.entries(states)) {
      await o.page.evaluate((cls) => {
        const dock = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".dock")
        if (!dock) throw new Error("no dock")
        dock.className = `dock chrome ${cls}`
      }, state)
      const plate = await plateOf(o.page, ".stword")
      expectPlain(plate, `the ${state} word`)
      expect(plate.color, `the ${state} word colour`).toBe(await tokenColor(o.page, token))
    }
  }, 30_000)

  test("the hover chip's size readout", async () => {
    const o = await open(SEEDED)
    await o.page.keyboard.press("c")
    const box = await o.page.locator(CARD).boundingBox()
    if (!box) throw new Error("the card has no box")
    await o.page.mouse.move(box.x + 20, box.y + box.height / 2)
    await until("the hover chip", () => o.overlay.locator(".chip.on").isVisible())
    expectPlain(await plateOf(o.page, ".chip .c1 .dim"), "the size readout")
  }, 30_000)

  test.each(["light", "dark"] as const)(
    "the composer's source confidence, exact and uncertain, %s",
    async (theme) => {
      const o = await open({ ...SEEDED, prefs: { ...TOUR_DONE, theme } })
      await o.page.locator(CARD).evaluate((el) => el.setAttribute("data-fake-src", ""))
      await o.page.keyboard.press("c")
      const box = await o.page.locator(CARD).boundingBox()
      if (!box) throw new Error("the card has no box")
      await o.page.mouse.click(box.x + 20, box.y + box.height / 2)
      const confidence = o.overlay.getByRole("status", { name: "Source confidence" })
      await until("the source confidence", () => confidence.isVisible())
      expect(await confidence.innerText()).toBe("exact")
      const exact = await plateOf(o.page, ".cmp-src .conf")
      expectPlain(exact, "the exact confidence")
      expect(exact.color, "the exact confidence colour").toBe(
        await tokenColor(o.page, "--cobalt-t"),
      )
      await o.page.evaluate(() => {
        const row = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".cmp-src")
        if (!row) throw new Error("no source row")
        row.className = "cmp-src uncertain"
      })
      const uncertain = await plateOf(o.page, ".cmp-src .conf")
      expectPlain(uncertain, "the uncertain confidence")
      expect(uncertain.color, "the uncertain confidence colour").toBe(
        await tokenColor(o.page, "--mute"),
      )
    },
    30_000,
  )
})

describe("the spring stays", () => {
  test("a dark root computes the recorded spring curve", async () => {
    const o = await open({ ...SEEDED, prefs: { ...TOUR_DONE, theme: "dark" } })
    const root = o.overlay.locator(".root").first()
    expect(await root.getAttribute("data-theme")).toBe("dark")
    const spring = await root.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--spring").trim(),
    )
    expect(spring).toBe(SPRING)
  }, 30_000)

  test("no stylesheet lost a spring use", async () => {
    let uses = 0
    for (const file of new Bun.Glob("*.css").scanSync({ cwd: UI_DIR, absolute: true })) {
      const css = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "")
      uses += css.match(/var\(--spring\)/g)?.length ?? 0
    }
    expect(uses).toBeGreaterThanOrEqual(PRE_AUDIT_SPRING_USES)
  })
})
