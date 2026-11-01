import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Note, OVERLAY_ROUTES, Pairing, Round } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import iter8NoteJson from "../../../packages/protocol/fixtures/Note.iter8.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import type { PartsEngine } from "./parts.entry"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const CARD = '[data-source-target="card"]'
const TEST_MS = 30_000
const PAGE = "mockpage"
const LIVE = Pairing.parse(pairingJson)
const PREFS = {
  theme: "light",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: true,
} as const

type Opened = Awaited<ReturnType<typeof openOverlay>>
type Rect = { x: number; y: number; w: number; h: number }

let browser: Browser
let overlayBuild: Scratch
let partsBundle: Scratch
let opened: Opened | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  partsBundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("./parts.entry.ts", import.meta.url)),
  )
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await partsBundle?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open(mock: Parameters<typeof openOverlay>[0]["mock"] = {}): Promise<Opened> {
  opened = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: STATIC,
    mock: { prefs: PREFS, pairing: LIVE, ...mock },
    browser,
  })
  const o = opened
  await until("the dock to be ready", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  return o
}

async function startPicking(o: Opened) {
  await o.page.keyboard.press("c")
  const tool = o.overlay.getByRole("button", { name: "Pick element" })
  await until("pick mode", async () => (await tool.getAttribute("aria-pressed")) === "true")
}

const part = (o: Opened, key: string) => o.overlay.locator(`[data-iter8-part="${key}"]:visible`)
const highlight = (o: Opened) => o.overlay.locator(".layer.pick .ring")
const dialog = (o: Opened) => o.overlay.getByRole("dialog", { name: "New note" })
const noteBox = (o: Opened) => o.overlay.getByRole("textbox", { name: "Note" })
const chip = (o: Opened) => o.overlay.locator(".layer.pick .chip")

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
}

function centre(rect: Rect) {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
}

async function hoverCentre(o: Opened, locator: Locator) {
  const { x, y } = centre(await rectOf(locator))
  await o.page.mouse.move(x, y)
}

async function highlightMatches(o: Opened, locator: Locator): Promise<boolean> {
  const drawn = await rectOf(highlight(o))
  const wanted = await rectOf(locator)
  return (["x", "y", "w", "h"] as const).every((key) => Math.abs(drawn[key] - wanted[key]) < 1)
}

async function pickRing(o: Opened) {
  await startPicking(o)
  await o.page.keyboard.down("Alt")
  await hoverCentre(o, part(o, "dock.ring"))
  await until("the highlight to settle on the ring", () =>
    highlightMatches(o, part(o, "dock.ring")),
  )
}

describe("picking an overlay part with the modifier held", () => {
  test(
    "hovering the dock ring highlights the ring's own box and names the part and its source",
    async () => {
      const o = await open()
      await pickRing(o)

      expect(await highlight(o).getAttribute("class")).toContain("on")
      await until("the chip to name the part", async () =>
        ((await chip(o).textContent()) ?? "").includes("Dock status ring"),
      )
      expect(await chip(o).textContent()).toContain("apps/overlay/src/ui/Dock.tsx")
    },
    TEST_MS,
  )

  test(
    "clicking opens the composer for an iter8 target, and saving stores the part, version, box and a screenshot",
    async () => {
      const o = await open()
      await pickRing(o)
      const ring = await rectOf(part(o, "dock.ring"))
      const { x, y } = centre(ring)
      await o.page.mouse.click(x, y)
      await until("the composer to open", () => noteBox(o).isVisible())

      const header = (await dialog(o).locator(".cmp-h").textContent()) ?? ""
      expect(header).toContain("iter8")
      expect(header).toContain("Dock status ring")
      expect(await dialog(o).locator(".cmp-src").textContent()).toContain("Dock.tsx")

      await noteBox(o).fill("The ring sits too close to the name")
      await until("the screenshot to upload", () =>
        o.mock
          .requests()
          .some((r) => r.method === "POST" && r.path === OVERLAY_ROUTES.uploadScreenshot.path),
      )
      await dialog(o).getByRole("button", { name: /^Save/ }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)

      const [note] = o.mock.draft()
      if (!note) throw new Error("no draft")
      expect(note.target).toMatchObject({
        kind: "iter8",
        part: {
          key: "dock.ring",
          name: "Dock status ring",
          source: "apps/overlay/src/ui/Dock.tsx",
        },
        iter8Version: "0.0.0-mock",
      })
      if (note.target.kind !== "iter8") throw new Error("not an iter8 target")
      expect(note.target.box.x).toBeCloseTo(ring.x, 0)
      expect(note.target.box.y).toBeCloseTo(ring.y, 0)
      expect(note.target.box.width).toBeCloseTo(ring.w, 0)
      expect(note.target.box.height).toBeCloseTo(ring.h, 0)
      const viewport = await o.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }))
      expect(note.target.viewport).toEqual(viewport)
      expect(note.anchorStatus).toBe("anchored")

      expect(note.capture?.screenshot?.width).toBeGreaterThan(0)
      expect(note.capture?.omittedParts).toEqual([])
      expect(note.capture?.computedStyles).toBeUndefined()
      expect(note.capture?.sourceLead).toBeUndefined()
      expect(note.capture?.landmark).toBeUndefined()
    },
    TEST_MS,
  )

  test(
    "the click does not reach the dock control under it, and no pin appears on the page",
    async () => {
      const o = await open()
      await pickRing(o)
      const { x, y } = centre(await rectOf(part(o, "dock.ring")))
      await o.page.mouse.click(x, y)
      await until("the composer to open", () => noteBox(o).isVisible())
      await noteBox(o).fill("No pin for this one")
      await dialog(o).getByRole("button", { name: /^Save/ }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))

      expect(
        await o.overlay.getByRole("button", { name: /^Session / }).getAttribute("aria-expanded"),
      ).toBe("false")
      await o.page.keyboard.up("Alt")
      await o.page.waitForTimeout(400)
      expect(await o.overlay.locator(".pinlayer button, .pinlayer > *").count()).toBe(0)
    },
    TEST_MS,
  )

  test(
    "without the modifier the same spot is not picked, and the click reaches the dock control",
    async () => {
      const o = await open()
      await startPicking(o)
      await hoverCentre(o, part(o, "dock.ring"))
      await o.page.waitForTimeout(400)
      expect(await highlight(o).getAttribute("class")).not.toContain("on")

      const { x, y } = centre(await rectOf(part(o, "dock.ring")))
      await o.page.mouse.click(x, y)
      await until("the session menu to open", async () => {
        const grip = o.overlay.getByRole("button", { name: /^Session / })
        return (await grip.getAttribute("aria-expanded")) === "true"
      })
      expect(await noteBox(o).count()).toBe(0)
    },
    TEST_MS,
  )

  test(
    "releasing the modifier returns to picking page elements",
    async () => {
      const o = await open()
      await pickRing(o)
      await o.page.keyboard.up("Alt")
      await until(
        "the part highlight to clear",
        async () => !(await highlight(o).getAttribute("class"))?.includes("on"),
      )

      await o.page.locator(CARD).hover()
      await until("the highlight to follow the card", () =>
        highlightMatches(o, o.page.locator(CARD)),
      )
      await until("the chip to describe the card", async () =>
        ((await chip(o).textContent()) ?? "").includes("Card in static"),
      )
    },
    TEST_MS,
  )

  test(
    "with the modifier held, a page element is not picked and a click on the page opens nothing",
    async () => {
      const o = await open()
      await startPicking(o)
      await o.page.keyboard.down("Alt")
      await o.page.locator(CARD).hover()
      await o.page.waitForTimeout(400)
      expect(await highlight(o).getAttribute("class")).not.toContain("on")
      await o.page.locator(CARD).click()
      await o.page.waitForTimeout(200)
      expect(await noteBox(o).count()).toBe(0)
    },
    TEST_MS,
  )

  test(
    "pressing Enter on a hovered part opens the same composer",
    async () => {
      const o = await open()
      await pickRing(o)
      await o.page.keyboard.press("Enter")
      await until("the composer to open", () => noteBox(o).isVisible())
      expect(await dialog(o).locator(".cmp-h").textContent()).toContain("Dock status ring")
    },
    TEST_MS,
  )

  test(
    "an untagged element inside a part resolves to that part, and the highlight is the part's box",
    async () => {
      const o = await open()
      await startPicking(o)
      await o.page.keyboard.down("Alt")
      const pick = o.overlay.getByRole("button", { name: "Pick element" })
      await hoverCentre(o, pick)
      await until("the highlight to settle on the tool buttons", () =>
        highlightMatches(o, part(o, "dock.tools")),
      )
      await until("the chip to name the part", async () =>
        ((await chip(o).textContent()) ?? "").includes("Dock tool buttons"),
      )
    },
    TEST_MS,
  )
})

describe("an overlay part replaced by a re-render after the pick", () => {
  const thumbnail = (o: Opened) => dialog(o).getByRole("img", { name: "Screenshot attached" })
  const attachSwitch = (o: Opened) => dialog(o).getByRole("switch")

  async function pickRingWithClick(o: Opened) {
    await part(o, "dock.ring").evaluate((el) => Reflect.set(el, "pickedOriginal", true))
    await pickRing(o)
    const { x, y } = centre(await rectOf(part(o, "dock.ring")))
    await o.page.mouse.click(x, y)
    await until("the composer to open", () => noteBox(o).isVisible())
  }

  const ringReplaced = (o: Opened) =>
    part(o, "dock.ring").evaluate((el) => !Reflect.has(el, "pickedOriginal"))

  test(
    "before its screenshot is taken still gets a screenshot of the part as it is now",
    async () => {
      const o = await open()
      await o.page.evaluate(() => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        if (!root) throw new Error("no overlay shadow root")
        const observer = new MutationObserver(() => {
          if (!root.querySelector('[data-iter8-part="composer"].on')) return
          observer.disconnect()
          const ring = root.querySelector('[data-iter8-part="dock.ring"]')
          ring?.replaceWith(ring.cloneNode(true))
        })
        observer.observe(root, { attributes: true, childList: true, subtree: true })
      })
      await pickRingWithClick(o)

      await thumbnail(o).waitFor({ timeout: 10_000 })
      expect(await ringReplaced(o)).toBe(true)
      expect(await attachSwitch(o).getAttribute("aria-checked")).toBe("true")
      await noteBox(o).fill("The ring after a re-render")
      await dialog(o).getByRole("button", { name: /^Save/ }).click()
      await until("the screenshot on the draft", () =>
        Boolean(o.mock.draft()[0]?.capture?.screenshot),
      )
      expect(o.mock.draft()[0]?.capture?.omittedParts).toEqual([])
    },
    TEST_MS,
  )

  test(
    "while its screenshot renders says why there is no screenshot",
    async () => {
      const o = await open()
      await o.page.evaluate(() => {
        const root = document.querySelector("iter8-overlay")?.shadowRoot
        if (!root) throw new Error("no overlay shadow root")
        const decode = HTMLImageElement.prototype.decode
        HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
          if (this.src.startsWith("data:image/svg+xml")) {
            HTMLImageElement.prototype.decode = decode
            const ring = root.querySelector('[data-iter8-part="dock.ring"]')
            ring?.replaceWith(ring.cloneNode(true))
          }
          return decode.call(this)
        }
      })
      await pickRingWithClick(o)

      await until("the switch to settle off", () => attachSwitch(o).isDisabled(), 10_000)
      expect(await ringReplaced(o)).toBe(true)
      expect(await attachSwitch(o).getAttribute("aria-checked")).toBe("false")
      expect(await thumbnail(o).count()).toBe(0)
      expect(await dialog(o).innerText()).toContain(
        "It changed before the screenshot finished — pick it again",
      )
    },
    TEST_MS,
  )
})

describe("a note about iter8 in the round", () => {
  const iter8Note = Note.parse({ ...iter8NoteJson, pageId: PAGE, capture: undefined })
  const draft = { ...iter8Note, id: "N41" }
  const sent = Round.parse({
    ...roundJson,
    pageId: PAGE,
    notes: [{ ...iter8Note, id: "N42", pageId: PAGE }],
  })

  test(
    "This round shows the iter8 label and the part name instead of an element description",
    async () => {
      const o = await open({ pageState: { drafts: [draft], rounds: [], agentNotes: [] } })
      await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
      const row = o.overlay.locator("[data-iter8-part='sheet.note']")
      await until("the note row", () => row.isVisible())
      expect(await row.locator(".iter8-tag").textContent()).toBe("iter8")
      expect(await row.locator(".tgt").textContent()).toBe("iter8Dock status ring")
      await o.page.waitForTimeout(400)
      expect(await o.overlay.locator(".pinlayer button, .pinlayer > *").count()).toBe(0)
      expect(await row.locator(".st-chip").count()).toBe(0)
      expect(o.mock.draft()[0]?.anchorStatus).toBe("anchored")
    },
    TEST_MS,
  )

  test(
    "History shows the same label for a sent round",
    async () => {
      const o = await open({ pageState: { drafts: [], rounds: [sent], agentNotes: [] } })
      await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
      await o.overlay.getByRole("tab", { name: /^History/ }).click()
      const row = o.overlay.locator("[data-iter8-part='sheet.history-note']")
      await until("the history note", () => row.isVisible())
      expect(await row.locator(".iter8-tag").textContent()).toBe("iter8")
      expect(await row.locator(".prov .cmp").textContent()).toContain("Dock status ring")
    },
    TEST_MS,
  )
})

describe("part resolution", () => {
  async function engine(page: Page) {
    await page.goto("about:blank")
    await page.addScriptTag({ path: `${partsBundle.path}/overlay.js`, type: "module" })
    await until("the bundle to load", () => page.evaluate(() => "__iter8Parts" in window))
  }

  async function resolve(page: Page, hit: string) {
    return page.evaluate((selector) => {
      const engine = (window as unknown as { __iter8Parts: PartsEngine }).__iter8Parts
      const host = document.querySelector("#host")
      const found = host?.shadowRoot?.querySelector(selector)
      const result = found ? engine.resolvePart(found) : undefined
      if (!result) return null
      return { key: result.key, same: result.el === found, tagged: result.el.id }
    }, hit)
  }

  test(
    "resolves to the nearest tagged ancestor, and an element under only the catch-all stays itself",
    async () => {
      const { page, close } = await newPage(browser)
      try {
        await engine(page)
        await page.evaluate(() => {
          const host = document.createElement("div")
          host.id = "host"
          document.body.append(host)
          host.attachShadow({ mode: "open" }).innerHTML = `
            <div data-iter8-part="overlay" id="root">
              <div data-iter8-part="dock" id="dock">
                <div data-iter8-part="dock.tools" id="tools"><button><svg><path id="deep"></path></svg></button></div>
                <span id="plain">plain</span>
              </div>
              <p id="loose">loose</p>
              <div data-iter8-part="not-a-part" id="forged"><i id="under-forged"></i></div>
            </div>
            <aside id="outside"></aside>`
        })
        expect(await resolve(page, "#deep")).toEqual({
          key: "dock.tools",
          same: false,
          tagged: "tools",
        })
        expect(await resolve(page, "#tools")).toEqual({
          key: "dock.tools",
          same: true,
          tagged: "tools",
        })
        expect(await resolve(page, "#plain")).toEqual({ key: "dock", same: false, tagged: "dock" })
        expect(await resolve(page, "#loose")).toEqual({
          key: "overlay",
          same: true,
          tagged: "loose",
        })
        expect(await resolve(page, "#under-forged")).toBeNull()
        expect(await resolve(page, "#outside")).toBeNull()
      } finally {
        await close()
      }
    },
    TEST_MS,
  )
})
