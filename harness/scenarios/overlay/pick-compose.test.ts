import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { OVERLAY_ROUTES, SOURCE_BUNDLE_PATH } from "@iter8/protocol"
import type { Browser, Locator, Page } from "playwright"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay, withSourceBundle } from "./support"

const STATIC = fixtureDir("static")
const CARD = '[data-source-target="card"]'
const TEST_MS = 30_000

type Opened = Awaited<ReturnType<typeof openOverlay>>

let browser: Browser
let overlayBuild: Scratch
let noSource: Scratch
let fakeSource: Scratch
let opened: Opened | null = null

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  noSource = await withSourceBundle(overlayBuild, "none")
  fakeSource = await withSourceBundle(overlayBuild, "fake")
})

afterEach(async () => {
  await opened?.close()
  opened = null
})

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await noSource?.dispose()
  await fakeSource?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

async function open(build: Scratch = overlayBuild): Promise<Opened> {
  opened = await openOverlay({ overlayDir: build.path, folder: STATIC, browser })
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

const card = (page: Page) => page.locator(CARD)
const dialog = (o: Opened) => o.overlay.getByRole("dialog", { name: "New note" })
const noteBox = (o: Opened) => o.overlay.getByRole("textbox", { name: "Note" })
const confidence = (o: Opened) => o.overlay.getByRole("status", { name: "Source confidence" })
const chip = (o: Opened, text: string) => o.overlay.getByRole("status").filter({ hasText: text })
const requestsTo = (o: Opened, method: string, path: string) =>
  o.mock.requests().filter((request) => request.method === method && request.path === path)

async function composeOn(o: Opened, target: Locator) {
  await startPicking(o)
  await target.click()
  await until("the composer to open", () => noteBox(o).isVisible())
}

/** The token a confidence label is coloured with: `--cobalt-d` marks a certain lead, `--mute` any other. */
async function confidenceTone(locator: Locator): Promise<string> {
  return locator.evaluate((el) => {
    const own = getComputedStyle(el).color
    for (const token of ["--cobalt-d", "--mute"]) {
      const probe = document.createElement("i")
      probe.style.color = `var(${token})`
      el.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      if (color === own) return token
    }
    return own
  })
}

describe("pick mode", () => {
  test(
    "keeps every click event from the page while picking, and gives them back when it ends",
    async () => {
      const o = await open()
      await o.page.evaluate((selector) => {
        const seen: string[] = []
        Reflect.set(window, "seenByPage", seen)
        const el = document.querySelector(selector)
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
          el?.addEventListener(type, () => seen.push(type))
      }, CARD)
      const seen = () => o.page.evaluate(() => Reflect.get(window, "seenByPage") as string[])

      await startPicking(o)
      await card(o.page).click({ modifiers: ["Shift"] })
      await until("the shift-click to mark the card", () => chip(o, "1 selected").isVisible())
      await card(o.page).click()
      await until("the composer to open", () => noteBox(o).isVisible())
      expect(await seen()).toEqual([])

      await o.page.keyboard.press("Escape")
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))
      await card(o.page).click()
      expect(await seen()).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "click"])
    },
    TEST_MS,
  )

  test(
    "writes the hover outline at most once per frame however many pointer moves arrive",
    async () => {
      const o = await open()
      await startPicking(o)
      const writes = await o.page.evaluate(async () => {
        const ring = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".ring")
        if (!ring) throw new Error("no ring in the overlay")
        const perFrame = new Map<number, number>()
        const observer = new MutationObserver((records) => {
          const frame = Number(document.timeline.currentTime)
          perFrame.set(frame, (perFrame.get(frame) ?? 0) + records.length)
        })
        observer.observe(ring, { attributes: true, attributeFilter: ["style"] })
        const targets = Array.from(document.querySelectorAll("main p, main h2, main button, nav a"))
        for (let i = 0; i < 50; i += 1) {
          const el = targets[i % targets.length]
          const box = el?.getBoundingClientRect()
          el?.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              composed: true,
              clientX: (box?.left ?? 0) + 2,
              clientY: (box?.top ?? 0) + 2,
            }),
          )
        }
        for (let frame = 0; frame < 30; frame += 1)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        observer.disconnect()
        const counts = [...perFrame.values()]
        const last = targets[49 % targets.length]?.getBoundingClientRect()
        const drawn = ring.getBoundingClientRect()
        return {
          max: Math.max(0, ...counts),
          total: counts.reduce((sum, n) => sum + n, 0),
          last: last && { x: last.left, y: last.top, w: last.width, h: last.height },
          drawn: { x: drawn.left, y: drawn.top, w: drawn.width, h: drawn.height },
        }
      })
      expect(writes.total).toBeGreaterThan(0)
      expect(writes.max).toBeLessThanOrEqual(1)
      const { last, drawn } = writes
      if (!last) throw new Error("no last target")
      for (const key of ["x", "y", "w", "h"] as const) expect(drawn[key]).toBeCloseTo(last[key], 0)
    },
    TEST_MS,
  )

  test(
    "ArrowUp climbs to the parent and the climb path follows",
    async () => {
      const o = await open()
      await startPicking(o)
      await card(o.page).hover()
      const onCard = chip(o, "“Card in static”")
      await until("the chip to describe the card", () => onCard.isVisible())
      expect(await onCard.textContent()).toContain("main›section›p")

      await o.page.keyboard.press("ArrowUp")
      const onSection = chip(o, "“Overview”")
      await until("the chip to describe the section", () => onSection.isVisible())
      const text = (await onSection.textContent()) ?? ""
      expect(text).toContain("main›section")
      expect(text).not.toContain("section›p")
    },
    TEST_MS,
  )

  test(
    "shift-clicking two elements and clicking a third saves one note on all three",
    async () => {
      const o = await open()
      await startPicking(o)
      await card(o.page).click({ modifiers: ["Shift"] })
      await o.page.getByText("Details for the static page.").click({ modifiers: ["Shift"] })
      await until("two marks", () => chip(o, "2 selected").isVisible())
      await o.page.locator("main section").first().getByRole("button", { name: "Save" }).click()
      await until("the composer to open", () => noteBox(o).isVisible())
      expect(await dialog(o).textContent()).toContain("3 elements")

      await noteBox(o).fill("Line these up")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      const [draft] = o.mock.draft()
      expect(draft?.target.kind).toBe("elements")
      expect(draft?.target.kind === "elements" ? draft.target.anchors.length : 0).toBe(3)
    },
    TEST_MS,
  )

  test(
    "a drag makes a region note that starts as a change",
    async () => {
      const o = await open()
      await startPicking(o)
      const box = await card(o.page).boundingBox()
      if (!box) throw new Error("the card has no box")
      await o.page.mouse.move(box.x, box.y)
      await o.page.mouse.down()
      await o.page.mouse.move(box.x + 140, box.y + 90, { steps: 8 })
      await o.page.mouse.up()
      await until("the region composer", () => noteBox(o).isVisible())
      expect(await dialog(o).textContent()).toContain("Region")
      expect(
        await o.overlay.getByRole("radio", { name: "Change" }).getAttribute("aria-checked"),
      ).toBe("true")

      await noteBox(o).fill("Put a banner here")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(o.mock.draft()[0]?.target.kind).toBe("region")
    },
    TEST_MS,
  )
})

describe("the composer", () => {
  test(
    "3 picks the question intent and its placeholder, and an empty save shows the error",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      expect(await noteBox(o).getAttribute("placeholder")).toBe("What’s wrong with it?")

      await o.page.keyboard.press("3")
      const question = o.overlay.getByRole("radio", { name: "Question" })
      await until(
        "question to be chosen",
        async () => (await question.getAttribute("aria-checked")) === "true",
      )
      expect(await noteBox(o).getAttribute("placeholder")).toBe("What do you want to know?")

      const error = o.overlay.getByText("Add a line so the agent knows what to do.")
      expect(await error.isVisible()).toBe(false)
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the empty-body error", () => error.isVisible())
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.createDraft.path)).toHaveLength(0)
    },
    TEST_MS,
  )

  test(
    "saves through the drafts route with the typed body and the page data apart",
    async () => {
      const o = await open()
      const typed = "Make this heading bolder"
      await composeOn(o, card(o.page))
      await until("the note box to take focus", () =>
        noteBox(o).evaluate(
          (box) => box.getRootNode() instanceof ShadowRoot && box.matches(":focus"),
        ),
      )
      await o.page.keyboard.type(typed)
      await until(
        "the screenshot thumbnail",
        () => o.overlay.getByRole("img", { name: "Screenshot attached" }).isVisible(),
        10_000,
      )
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))

      const posts = requestsTo(o, "POST", OVERLAY_ROUTES.createDraft.path)
      expect(posts).toHaveLength(1)
      expect(Reflect.get(Object(posts[0]?.body), "body")).toBe(typed)

      await until("the capture to reach the draft", () => {
        const capture = o.mock.draft()[0]?.capture
        return capture?.landmark !== undefined && capture.computedStyles !== undefined
      })
      const [draft] = o.mock.draft()
      expect(o.mock.draft()).toHaveLength(1)
      expect(draft?.body).toBe(typed)
      expect(draft?.capture?.screenshot).toBeDefined()
      const anchor = draft?.target.kind === "element" ? draft.target.anchor : null
      if (!anchor) throw new Error("the draft is not on one element")
      const resolvesToCard = await o.page.evaluate(
        ({ selector, cardSelector }) => {
          const last = selector.at(-1)
          const found = last ? document.querySelectorAll(last) : []
          return found.length === 1 && found[0] === document.querySelector(cardSelector)
        },
        { selector: anchor.selector, cardSelector: CARD },
      )
      expect(resolvesToCard).toBe(true)
    },
    TEST_MS,
  )

  test(
    "shows an exact lead as certain after one symbolicate call",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
      await composeOn(o, card(o.page))
      await until(
        "the confidence label",
        async () => (await confidence(o).textContent()) === "exact",
      )
      const text = (await dialog(o).textContent()) ?? ""
      expect(text).toContain("<Card>")
      expect(text).toContain("src/Card.jsx:3")
      expect(await confidenceTone(confidence(o))).toBe("--cobalt-d")
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.symbolicate.path)).toHaveLength(1)
    },
    TEST_MS,
  )

  test(
    "labels the lead none and never symbolicates when no source bundle is served",
    async () => {
      const o = await open(noSource)
      await composeOn(o, card(o.page))
      await until(
        "the confidence label",
        async () =>
          (await confidence(o).isVisible()) && (await confidence(o).textContent()) === "none",
        10_000,
      )
      expect(await confidenceTone(confidence(o))).toBe("--mute")
      expect(requestsTo(o, "GET", SOURCE_BUNDLE_PATH).length).toBeGreaterThan(0)
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.symbolicate.path)).toHaveLength(0)
    },
    TEST_MS,
  )

  test(
    "cancelling while the lead is pending records nothing for that pick",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-slow", ""))
      await composeOn(o, card(o.page))
      await until(
        "the source bundle to load",
        () => requestsTo(o, "GET", SOURCE_BUNDLE_PATH).length > 0,
      )
      expect(await o.overlay.getByText("Finding source…").isVisible()).toBe(true)
      await o.page.keyboard.press("Escape")
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))

      await composeOn(o, card(o.page))
      await noteBox(o).fill("Second pick")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until(
        "the second pick's lookup to time out",
        () => o.mock.draft()[0]?.capture?.sourceLead?.confidence === "none",
        10_000,
      )
      expect(o.mock.draft()[0]?.capture?.sourceLead).toEqual({
        confidence: "none",
        reason: "not-loaded",
      })
      expect(o.mock.draft()).toHaveLength(1)
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.createDraft.path)).toHaveLength(1)
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.symbolicate.path)).toHaveLength(0)
    },
    TEST_MS,
  )

  test(
    "marks the capture stale when the target is removed right after saving",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      await noteBox(o).fill("This paragraph is about to go")
      await o.page.evaluate((selector) => {
        const save = document
          .querySelector("iter8-overlay")
          ?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Save note"]')
        save?.click()
        document.querySelector(selector)?.remove()
      }, CARD)
      await until(
        "the capture to reach the draft",
        () => o.mock.draft()[0]?.capture !== undefined,
        10_000,
      )
      expect(o.mock.draft()[0]?.capture?.completeness).toBe("stale")
      expect(o.mock.draft()[0]?.capture?.screenshot).toBeUndefined()
    },
    TEST_MS,
  )

  test(
    "a reload pushed over unsaved text waits for the save, then reloads",
    async () => {
      const o = await open()
      const failure = {
        type: "upstream-failure",
        port: 5173,
        url: "http://localhost:5173/",
      } as const
      const failureNotice = o.overlay.getByRole("status").filter({ hasText: "port 5173 failed" })
      await waitFor(
        "the live socket",
        async () => {
          o.mock.push(failure)
          return (await failureNotice.isVisible()) ? true : null
        },
        { timeoutMs: 10_000 },
      )
      await o.page.evaluate(() => Reflect.set(window, "beforeReload", true))
      const stillLoaded = () =>
        o.page.evaluate(() => Reflect.get(window, "beforeReload") === true).catch(() => false)

      await composeOn(o, card(o.page))
      await noteBox(o).fill("Keep me through the reload")
      o.mock.push({ type: "reload" })
      const pending = o.overlay
        .getByRole("status")
        .filter({ hasText: "This page changed — it reloads when you save or cancel this note" })
      await until("the reload-pending notice", () => pending.isVisible())
      expect(await stillLoaded()).toBe(true)
      expect(await noteBox(o).inputValue()).toBe("Keep me through the reload")

      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the page to reload", async () => !(await stillLoaded()), 10_000)
      expect(o.mock.draft().map((note) => note.body)).toEqual(["Keep me through the reload"])
    },
    TEST_MS,
  )
})

const EVENT_TYPES = [
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
] as const
const GESTURES = ["click", "double click", "middle click", "right click"] as const
const PROBES = ["#probe-link", "#probe-check", "#probe-text", CARD] as const

async function installProbes(page: Page) {
  await page.evaluate((types) => {
    const seen: string[] = []
    Reflect.set(window, "seenByPage", seen)
    const holder = document.createElement("div")
    holder.style.cssText = "position:fixed;left:700px;top:120px;width:300px;height:200px"
    holder.innerHTML = `<a id="probe-link" href="#probe-hash" style="position:absolute;left:10px;top:10px;width:120px;height:30px;display:block">link</a><input id="probe-check" type="checkbox" style="position:absolute;left:10px;top:60px;width:24px;height:24px"><p id="probe-text" style="position:absolute;left:10px;top:110px;margin:0;font-size:20px">selectable words here</p>`
    document.body.append(holder)
    for (const type of types) {
      document.addEventListener(type, () => seen.push(`document capture ${type}`), true)
      document.addEventListener(type, () => seen.push(`document ${type}`))
      window.addEventListener(type, () => seen.push(`window ${type}`))
      holder.addEventListener(type, () => seen.push(`element ${type}`))
    }
  }, EVENT_TYPES)
}

async function perform(page: Page, selector: string, gesture: (typeof GESTURES)[number]) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  const x = box.x + Math.min(box.width / 2, 30)
  const y = box.y + box.height / 2
  if (gesture === "double click") await page.mouse.dblclick(x, y)
  else
    await page.mouse.click(x, y, {
      button: gesture === "middle click" ? "middle" : gesture === "right click" ? "right" : "left",
    })
}

async function pageEffects(page: Page) {
  return page.evaluate(() => ({
    seen: Reflect.get(window, "seenByPage") as string[],
    hash: location.hash,
    checked: document.querySelector<HTMLInputElement>("#probe-check")?.checked,
    selection: String(getSelection()),
  }))
}

const PLAYWRIGHT_ONLY = /^(__playwright|contextmenu|mousemove|touch)/

async function windowListeners(page: Page): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const { result } = await cdp.send("Runtime.evaluate", { expression: "window" })
    const { listeners } = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: result.objectId ?? "",
    })
    return listeners
      .filter(({ type }) => !PLAYWRIGHT_ONLY.test(type))
      .map(
        ({ type, useCapture, passive }) =>
          `${type}${useCapture ? " capture" : ""}${passive ? " passive" : ""}`,
      )
      .sort()
  } finally {
    await cdp.detach()
  }
}

async function pickWithMouse(o: Opened, selector: string) {
  await enter(o, "pick")
  await perform(o.page, selector, "click")
  await until("the composer to open", () => noteBox(o).isVisible())
}

/** Playwright leaves its own input listeners on window after the first mouse action in a mode. */
async function warmUp(o: Opened) {
  await pickWithMouse(o, CARD)
  await o.page.keyboard.press("Escape")
  await until("the composer to close", async () => !(await noteBox(o).isVisible()))
}

async function enter(o: Opened, mode: "pick" | "region" | "shot") {
  if (mode === "pick") await o.page.keyboard.press("c")
  else if (mode === "region") await o.overlay.getByRole("button", { name: "Draw region" }).click()
  else await o.page.keyboard.press("s")
  const tool = o.overlay.getByRole("button", {
    name: { pick: "Pick element", region: "Draw region", shot: "Screenshot" }[mode],
  })
  await until(`${mode} mode`, async () => (await tool.getAttribute("aria-pressed")) === "true")
  if (mode === "shot") await o.overlay.getByText("Drag a region").waitFor({ timeout: 5000 })
}

async function leave(o: Opened) {
  await o.page.keyboard.press("Escape")
  await until("every tool to be off", async () => {
    for (const name of ["Pick element", "Draw region", "Screenshot"])
      if ((await o.overlay.getByRole("button", { name }).getAttribute("aria-pressed")) === "true")
        return false
    return !(await noteBox(o).isVisible())
  })
}

describe("events kept from the page", () => {
  test(
    "the same gestures reach the page's handlers and default actions while no mode is on",
    async () => {
      const o = await open()
      await installProbes(o.page)
      for (const gesture of GESTURES) await perform(o.page, "#probe-link", gesture)
      await perform(o.page, "#probe-check", "click")
      await o.page.mouse.dblclick(710, 240)
      const effects = await pageEffects(o.page)
      for (const type of EVENT_TYPES) {
        expect(effects.seen).toContain(`document capture ${type}`)
        expect(effects.seen).toContain(`element ${type}`)
      }
      expect(effects.hash).toBe("#probe-hash")
      expect(effects.checked).toBe(true)
      expect(effects.selection).not.toBe("")
    },
    TEST_MS,
  )

  for (const mode of ["pick", "region", "shot"] as const) {
    test(
      `${mode} mode keeps click, double click, middle and right click, their default actions and capture-phase document handlers from the page`,
      async () => {
        const o = await open()
        await installProbes(o.page)
        for (const probe of PROBES) {
          for (const gesture of GESTURES) {
            await enter(o, mode)
            await o.page.evaluate(() => {
              ;(Reflect.get(window, "seenByPage") as string[]).length = 0
            })
            await perform(o.page, probe, gesture)
            const during = await pageEffects(o.page)
            await leave(o)
            expect({ probe, gesture, ...during, selection: "" }).toEqual({
              probe,
              gesture,
              seen: [],
              hash: "",
              checked: false,
              selection: "",
            })
          }
        }
        expect(await pageEffects(o.page)).toEqual({
          seen: [],
          hash: "",
          checked: false,
          selection: "",
        })
      },
      TEST_MS * 2,
    )
  }
})

describe("the window listeners", () => {
  test(
    "are the specified set while a mode is on and are all gone again after it ends, however it ends",
    async () => {
      const o = await open()
      await warmUp(o)
      const baseline = await windowListeners(o.page)
      const during = {
        pick: [] as string[],
        region: [] as string[],
        shot: [] as string[],
      }
      for (const mode of ["pick", "region", "shot"] as const) {
        for (let cycle = 0; cycle < 3; cycle += 1) {
          await enter(o, mode)
          if (cycle === 0) during[mode] = await windowListeners(o.page)
          await leave(o)
          expect(await windowListeners(o.page)).toEqual(baseline)
        }
      }
      const added = (mode: keyof typeof during) => {
        const left = [...baseline]
        return during[mode].filter((listener) => {
          const at = left.indexOf(listener)
          if (at < 0) return true
          left.splice(at, 1)
          return false
        })
      }
      const expected = [
        "auxclick capture",
        "blur capture passive",
        "click capture",
        "dblclick capture",
        "keydown capture passive",
        "keyup capture passive",
        "mousedown capture",
        "mouseup capture",
        "pointerdown capture",
        "pointermove capture passive",
        "pointerup capture",
        "scroll capture passive",
      ]
      expect(added("pick")).toEqual(expected)
      expect(added("region")).toEqual(expected)
      expect(added("shot")).toEqual(
        expected
          .filter(
            (listener) =>
              ![
                "scroll capture passive",
                "blur capture passive",
                "keydown capture passive",
                "keyup capture passive",
              ].includes(listener),
          )
          .concat("pointercancel capture passive")
          .sort(),
      )

      await pickWithMouse(o, CARD)
      await o.page.keyboard.press("Escape")
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))
      expect(await windowListeners(o.page)).toEqual(baseline)
    },
    TEST_MS,
  )

  test(
    "are gone after dismissing an empty composer by clicking the page, and the page gets its clicks back",
    async () => {
      const o = await open()
      await installProbes(o.page)
      await warmUp(o)
      const baseline = await windowListeners(o.page)

      await pickWithMouse(o, CARD)
      await perform(o.page, "#probe-link", "click")
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))
      await until("the page listeners to be gone", async () => {
        const now = await windowListeners(o.page)
        return JSON.stringify(now) === JSON.stringify(baseline)
      })
      expect((await pageEffects(o.page)).seen).toEqual([])
      expect((await pageEffects(o.page)).hash).toBe("")

      await perform(o.page, "#probe-link", "click")
      const after = await pageEffects(o.page)
      expect(after.seen).toContain("element click")
      expect(after.hash).toBe("#probe-hash")

      await pickWithMouse(o, CARD)
      await o.page.keyboard.press("Escape")
      await until("the composer to close again", async () => !(await noteBox(o).isVisible()))
    },
    TEST_MS,
  )
})

const LOW_BUTTON = "main section:nth-of-type(2) button"
const DETAILS = "main section:nth-of-type(2) p"
const SECTION = "main section:first-of-type"
const hoverChip = (o: Opened) => o.overlay.locator(".chip.on")

/** The box once two reads a frame apart agree, so a panel mid-entrance or mid-reflow is not measured. */
async function settledBox(locator: Locator) {
  let previous = ""
  const key = await waitFor(
    "the box to settle",
    async () => {
      const box = await locator.boundingBox()
      const now = JSON.stringify(box)
      const settled = box !== null && now === previous
      previous = now
      return settled ? now : null
    },
    { timeoutMs: 5000, everyMs: 120 },
  )
  return JSON.parse(key) as { x: number; y: number; width: number; height: number }
}

async function center(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
}

async function hover(o: Opened, selector: string) {
  const { x, y } = await center(o.page, selector)
  await o.page.mouse.move(x, y, { steps: 3 })
}

async function dragBy(o: Opened, from: { x: number; y: number }, by: { dx: number; dy: number }) {
  await o.page.mouse.move(from.x, from.y)
  await o.page.mouse.down()
  await o.page.mouse.move(from.x + by.dx, from.y + by.dy, { steps: 4 })
  await o.page.mouse.up()
}

async function savedAnchorsResolveTo(o: Opened, selectors: string[]) {
  const [draft] = o.mock.draft()
  const anchors =
    draft?.target.kind === "elements"
      ? draft.target.anchors
      : draft?.target.kind === "element"
        ? [draft.target.anchor]
        : []
  return o.page.evaluate(
    ({ lists, expected }) =>
      lists.map((selector, i) => {
        const last = selector.at(-1)
        const found = last ? document.querySelectorAll(last) : []
        const want = document.querySelector(expected[i] ?? "")
        return found.length === 1 && found[0] === want
      }),
    { lists: anchors.map((anchor) => anchor.selector), expected: selectors },
  )
}

describe("picking", () => {
  test(
    "ArrowUp and ArrowDown climb and return, stop below the body, and Enter notes the climbed element",
    async () => {
      const o = await open()
      await startPicking(o)
      await hover(o, CARD)
      await until("the card to be described", () => chip(o, "“Card in static”").isVisible())

      await o.page.keyboard.press("ArrowUp")
      await until("the section", () => chip(o, "“Overview”").isVisible())
      await o.page.keyboard.press("ArrowDown")
      await until("back on the card", () => chip(o, "“Card in static”").isVisible())

      await o.page.keyboard.press("ArrowUp")
      await o.page.keyboard.press("ArrowUp")
      await until("main", () =>
        hoverChip(o)
          .locator(".c1 .comp")
          .filter({ hasText: /^main$/ })
          .isVisible(),
      )
      await o.page.keyboard.press("ArrowUp")
      await o.page.keyboard.press("ArrowUp")
      expect(await hoverChip(o).locator(".c1 .comp").textContent()).toBe("main")

      await o.page.keyboard.press("ArrowDown")
      await until("the section again", () => chip(o, "“Overview”").isVisible())
      await o.page.keyboard.press("Enter")
      await until("the composer to open", () => noteBox(o).isVisible())
      await noteBox(o).fill("Whole section")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(o.mock.draft()[0]?.target.kind).toBe("element")
      expect(await savedAnchorsResolveTo(o, [SECTION])).toEqual([true])
    },
    TEST_MS,
  )

  test(
    "shift-click toggles marks with numbers, never duplicates one, and the saved anchors are the three picked elements",
    async () => {
      const o = await open()
      await startPicking(o)
      const marks = o.overlay.locator(".mark")
      await card(o.page).click({ modifiers: ["Shift"] })
      await until("one mark", async () => (await marks.count()) === 1)
      await o.page.locator(DETAILS).click({ modifiers: ["Shift"] })
      await until("two marks", async () => (await marks.count()) === 2)
      expect(await marks.locator("b").allTextContents()).toEqual(["1", "2"])

      await card(o.page).click({ modifiers: ["Shift"] })
      await until("the card to be unmarked", async () => (await marks.count()) === 1)
      expect(await marks.locator("b").allTextContents()).toEqual(["1"])
      await card(o.page).click({ modifiers: ["Shift"] })
      await until("two marks again", async () => (await marks.count()) === 2)

      await o.page.locator(DETAILS).click()
      await until("the composer to open", () => noteBox(o).isVisible())
      expect(await dialog(o).textContent()).toContain("2 elements")
      await noteBox(o).fill("Pair")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(await savedAnchorsResolveTo(o, [DETAILS, CARD])).toEqual([true, true])
    },
    TEST_MS,
  )

  test(
    "three picked elements are saved as three anchors that each resolve to their own element",
    async () => {
      const o = await open()
      await startPicking(o)
      await card(o.page).click({ modifiers: ["Shift"] })
      await o.page.locator(DETAILS).click({ modifiers: ["Shift"] })
      await until("two marks", async () => (await o.overlay.locator(".mark").count()) === 2)
      const button = "main section:first-of-type button"
      await o.page.locator(button).click()
      await until("the composer to open", () => noteBox(o).isVisible())
      await noteBox(o).fill("Trio")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(await savedAnchorsResolveTo(o, [CARD, DETAILS, button])).toEqual([true, true, true])
    },
    TEST_MS,
  )

  test(
    "a drag past 6 px becomes a region only at 8 by 8 or more, in any direction, saved at the dragged box",
    async () => {
      const o = await open()
      await startPicking(o)
      const start = { x: 500, y: 300 }

      await dragBy(o, start, { dx: 6, dy: 0 })
      await until("a click on the element under a 6 px drag", () => noteBox(o).isVisible())
      expect(await dialog(o).textContent()).not.toContain("Region")
      await o.page.keyboard.press("Escape")
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))

      await startPicking(o)
      await dragBy(o, start, { dx: 7, dy: 7 })
      await o.page.mouse.move(900, 600)
      await until(
        "the pick tool to still be on",
        async () =>
          (await o.overlay
            .getByRole("button", { name: "Pick element" })
            .getAttribute("aria-pressed")) === "true",
      )
      expect(await noteBox(o).isVisible()).toBe(false)

      await dragBy(o, start, { dx: 8, dy: 8 })
      await until("the region composer", () => noteBox(o).isVisible())
      await noteBox(o).fill("Exactly eight")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the first draft", () => o.mock.draft().length === 1)
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))
      const first = o.mock.draft()[0]?.target
      expect(first?.kind === "region" ? first.box : null).toEqual({
        x: 500,
        y: 300,
        width: 8,
        height: 8,
      })

      await startPicking(o)
      await dragBy(o, { x: 700, y: 400 }, { dx: -40, dy: -30 })
      await until("the reversed region composer", () => noteBox(o).isVisible())
      await noteBox(o).fill("Backwards")
      await o.overlay.getByRole("button", { name: "Save note" }).click()
      await until("the second draft", () => o.mock.draft().length === 2)
      const second = o.mock.draft()[1]?.target
      expect(second?.kind === "region" ? second.box : null).toEqual({
        x: 660,
        y: 370,
        width: 40,
        height: 30,
      })
    },
    TEST_MS,
  )
})

describe("the inspector chip", () => {
  test(
    "describes the element with its tag, name, size and the specified hints",
    async () => {
      const o = await open()
      await startPicking(o)
      await hover(o, CARD)
      const onCard = chip(o, "“Card in static”")
      await until("the chip", () => onCard.isVisible())
      const box = await card(o.page).boundingBox()
      expect(await hoverChip(o).locator(".c1 .comp").textContent()).toBe("p")
      expect(await hoverChip(o).locator(".c1 .dim").textContent()).toBe(
        `${Math.round(box?.width ?? 0)} × ${Math.round(box?.height ?? 0)}`,
      )
      const hints = (await hoverChip(o).locator(".hints").first().textContent()) ?? ""
      for (const part of ["↑", "↓", "climb", "⇧", "click to add", "drag for region", "↵", "note"])
        expect(hints).toContain(part)
      expect(await hoverChip(o).locator(".hints").nth(1).textContent()).toBe(
        "hold ⌥ to pick iter8 itself",
      )
      expect(await hoverChip(o).locator(".src").count()).toBe(0)
    },
    TEST_MS,
  )

  test(
    "lists at most four ancestors, nearest last",
    async () => {
      const o = await open()
      await o.page.evaluate(() => {
        let parent: Element | null = document.querySelector("main section")
        for (let i = 1; i <= 6; i += 1) {
          const div = document.createElement("div")
          div.className = `l${i}`
          div.style.padding = "4px"
          parent?.append(div)
          parent = div
        }
        const span = document.createElement("span")
        span.id = "deepest"
        span.textContent = "deepest"
        parent?.append(span)
      })
      await startPicking(o)
      await hover(o, "#deepest")
      await until("the deepest chip", () => chip(o, "“deepest”").isVisible())
      expect(await hoverChip(o).locator(".path").textContent()).toBe("div.l4›div.l5›div.l6›span")
    },
    TEST_MS,
  )

  test(
    "names the element inside a shadow root and walks out through its host",
    async () => {
      const o = await open()
      await o.page.locator('[data-fixture="shadow-label"]').scrollIntoViewIfNeeded()
      await startPicking(o)
      await hover(o, '[data-fixture="shadow-label"]')
      await until("the shadow label chip", () => chip(o, "“Shadow label in static”").isVisible())
      expect(await hoverChip(o).locator(".c1 .comp").textContent()).toBe("span")
      expect(await hoverChip(o).locator(".path").textContent()).toBe(
        "main›fixture-shadow-label›span",
      )
      await o.page.keyboard.press("ArrowUp")
      await until(
        "the host",
        async () =>
          (await hoverChip(o).locator(".c1 .comp").textContent()) === "fixture-shadow-label",
      )
    },
    TEST_MS,
  )
})

const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control"
const PLACEHOLDERS = {
  Fix: "What’s wrong with it?",
  Change: "What should it become?",
  Question: "What do you want to know?",
  Keep: "What must stay exactly as it is?",
} as const
const radio = (o: Opened, name: string) => o.overlay.getByRole("radio", { name })
const saveButton = (o: Opened) => o.overlay.getByRole("button", { name: "Save note" })

async function checkedIntent(o: Opened): Promise<string | null> {
  for (const name of Object.keys(PLACEHOLDERS))
    if ((await radio(o, name).getAttribute("aria-checked")) === "true") return name
  return null
}

async function saveNote(o: Opened, text: string) {
  await noteBox(o).fill(text)
  await saveButton(o).click()
  await until("the composer to close", async () => !(await noteBox(o).isVisible()))
}

describe("the composer's intents", () => {
  test(
    "offers Fix, Change, Question and Keep in an Intent group, each with its own placeholder",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      expect(
        await o.overlay
          .getByRole("radiogroup", { name: "Intent", exact: true })
          .getByRole("radio")
          .count(),
      ).toBe(4)
      for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
        await radio(o, name).click()
        expect(await checkedIntent(o)).toBe(name)
        expect(await noteBox(o).getAttribute("placeholder")).toBe(placeholder)
      }
    },
    TEST_MS,
  )

  test(
    "keys 1, 2 and 4 choose an intent on an empty note, and Alt+digit chooses one while typing without typing the digit",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      await until("the note box to take focus", () =>
        noteBox(o).evaluate((box) => box.matches(":focus")),
      )
      for (const [key, name] of [
        ["2", "Change"],
        ["4", "Keep"],
        ["1", "Fix"],
      ] as const) {
        await o.page.keyboard.press(key)
        await until(`${name} to be chosen`, async () => (await checkedIntent(o)) === name)
        expect(await noteBox(o).inputValue()).toBe("")
      }

      await o.page.keyboard.type("abc")
      await o.page.keyboard.press("3")
      expect(await noteBox(o).inputValue()).toBe("abc3")
      expect(await checkedIntent(o)).toBe("Fix")
      for (const [key, name] of [
        ["Alt+2", "Change"],
        ["Alt+3", "Question"],
        ["Alt+4", "Keep"],
        ["Alt+1", "Fix"],
      ] as const) {
        await o.page.keyboard.press(key)
        await until(`${name} to be chosen`, async () => (await checkedIntent(o)) === name)
        expect(await noteBox(o).inputValue()).toBe("abc3")
      }
    },
    TEST_MS,
  )

  test(
    "animates the chosen intent's glyph and no other",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      const animating = (name: string) =>
        radio(o, name).evaluate((el) =>
          [...el.querySelectorAll("*")].some(
            (node) => getComputedStyle(node).animationName !== "none",
          ),
        )
      for (const name of Object.keys(PLACEHOLDERS)) {
        await radio(o, name).click()
        for (const other of Object.keys(PLACEHOLDERS))
          expect(await animating(other)).toBe(other === name)
      }
    },
    TEST_MS,
  )

  test(
    "an empty save shakes the panel and keeps the focus in the note",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      await saveButton(o).click()
      await until("the panel to shake", () =>
        dialog(o).evaluate((el) => el.classList.contains("shake")),
      )
      await until("the note to take focus back", () =>
        noteBox(o).evaluate((box) => box.matches(":focus")),
      )
    },
    TEST_MS,
  )
})

describe("saving, editing and deleting", () => {
  test(
    "Mod+Enter saves the note",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      await noteBox(o).fill("Saved from the keyboard")
      await o.page.keyboard.press(`${MOD_KEY}+Enter`)
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(o.mock.draft()[0]?.body).toBe("Saved from the keyboard")
    },
    TEST_MS,
  )

  test(
    "shows Saving…, disables the button and sends one create however often it is pressed",
    async () => {
      const o = await open()
      const creates: string[] = []
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await o.page.route(
        (url) => url.pathname === OVERLAY_ROUTES.createDraft.path,
        async (route) => {
          creates.push(route.request().method())
          await gate
          await route.continue()
        },
      )
      await composeOn(o, card(o.page))
      await noteBox(o).fill("Slow save")
      await saveButton(o).click()
      const saving = o.overlay.getByRole("button", { name: "Save note" })
      await until("Saving…", async () => ((await saving.textContent()) ?? "").includes("Saving…"))
      expect(await saving.isDisabled()).toBe(true)
      await o.page.keyboard.press(`${MOD_KEY}+Enter`)
      await o.page.keyboard.press(`${MOD_KEY}+Enter`)
      release()
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      expect(creates).toEqual(["POST"])
    },
    TEST_MS,
  )

  test(
    "a pin reopens the note for editing as Update note, which puts the change, and Delete removes it",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      await saveNote(o, "First wording")
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      const id = o.mock.draft()[0]?.id ?? ""

      const pin = o.overlay.getByRole("button", { name: "Note 1, Fix" })
      await pin.click()
      const editor = o.overlay.getByRole("dialog", { name: "Edit note" })
      await editor.waitFor({ timeout: 5000 })
      expect(await noteBox(o).inputValue()).toBe("First wording")
      expect(await o.overlay.getByRole("button", { name: "Save note" }).count()).toBe(0)

      await noteBox(o).fill("Second wording")
      await o.overlay.getByRole("button", { name: "Update note" }).click()
      await until("the put", () => o.mock.draft()[0]?.body === "Second wording")
      const puts = requestsTo(o, "PUT", OVERLAY_ROUTES.putDraft.path.replace(":noteId", id))
      expect(puts.map((put) => Reflect.get(Object(put.body), "body"))).toContain("Second wording")
      await until("the editor to close", async () => !(await editor.isVisible()))

      await pin.click()
      await editor.waitFor({ timeout: 5000 })
      await o.overlay.getByRole("button", { name: "Delete" }).click()
      await until("the draft to be gone", () => o.mock.draft().length === 0)
      expect(
        requestsTo(o, "DELETE", OVERLAY_ROUTES.deleteDraft.path.replace(":noteId", id)),
      ).toHaveLength(1)
      await until("the pin to go", async () => (await pin.count()) === 0)
      await until("the undo toast", () => o.overlay.getByText("Note 1 deleted").isVisible())
    },
    TEST_MS,
  )
})

const SYMBOLICATE = OVERLAY_ROUTES.symbolicate.path
const SCREENSHOTS = OVERLAY_ROUTES.uploadScreenshot.path
const putsFor = (o: Opened, id: string) =>
  requestsTo(o, "PUT", OVERLAY_ROUTES.putDraft.path.replace(":noteId", id))
const closed = (o: Opened) => async () => !(await noteBox(o).isVisible())

/** Holds the first symbolicate request until released; later ones pass straight through. */
async function holdFirstSymbolicate(o: Opened) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let held = false
  await o.page.route(
    (url) => url.pathname === SYMBOLICATE,
    async (route) => {
      if (!held) {
        held = true
        await gate
      }
      await route.continue()
    },
  )
  return { release, isHeld: () => held }
}

describe("the source lead", () => {
  for (const level of ["approximate", "file-only"] as const) {
    test(
      `labels a ${level} lead and styles it as uncertain, unlike an exact one`,
      async () => {
        const fileColor = (row: Locator) =>
          row.locator(".file").evaluate((el) => getComputedStyle(el).color)

        const first = await open(fakeSource)
        await card(first.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
        await composeOn(first, card(first.page))
        await until(
          "the exact label",
          async () => (await confidence(first).textContent()) === "exact",
        )
        const row = first.overlay.locator(".cmp-src")
        const certain = await fileColor(row)
        expect(await row.getAttribute("class")).not.toContain("uncertain")
        await first.close()
        opened = null

        const o = await open(fakeSource)
        await o.page.route(
          (url) => url.pathname === SYMBOLICATE,
          async (route) => {
            const response = await route.fetch()
            const lead = await response.json()
            const { line: _line, ...withoutLine } = lead
            await route.fulfill({
              response,
              json:
                level === "file-only"
                  ? { ...withoutLine, confidence: level }
                  : { ...lead, confidence: level },
            })
          },
        )
        await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
        await composeOn(o, card(o.page))
        await until(`the ${level} label`, async () => (await confidence(o).textContent()) === level)
        const uncertain = o.overlay.locator(".cmp-src")
        expect(await uncertain.getAttribute("class")).toContain("uncertain")
        expect(await confidenceTone(confidence(o))).toBe("--mute")
        expect(await fileColor(uncertain)).not.toBe(certain)
      },
      TEST_MS,
    )
  }

  test(
    "explains a none lead in a tooltip",
    async () => {
      const o = await open(noSource)
      await composeOn(o, card(o.page))
      await until("the none label", async () => (await confidence(o).textContent()) === "none")
      await confidence(o).hover()
      await o.overlay
        .getByRole("tooltip")
        .filter({ hasText: "The source lookup did not finish in time" })
        .waitFor({ timeout: 5000 })
    },
    TEST_MS,
  )

  test(
    "does no source work on hover or climb, and loads the bundle once however many picks follow",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
      await o.page.locator(DETAILS).evaluate((el) => el.setAttribute("data-fake-src", ""))
      await startPicking(o)
      await hover(o, CARD)
      await until("the chip", () => chip(o, "“Card in static”").isVisible())
      await o.page.keyboard.press("ArrowUp")
      await until("the climb", () => chip(o, "“Overview”").isVisible())
      await hover(o, DETAILS)
      await until("the second chip", () => chip(o, "“Details for the static page.”").isVisible())
      expect(requestsTo(o, "GET", SOURCE_BUNDLE_PATH)).toHaveLength(0)
      expect(requestsTo(o, "POST", SYMBOLICATE)).toHaveLength(0)

      await o.page.keyboard.press("Enter")
      await until("the lead", async () => (await confidence(o).textContent()) === "exact")
      expect(requestsTo(o, "GET", SOURCE_BUNDLE_PATH)).toHaveLength(1)
      await o.page.keyboard.press("Escape")
      await until("the composer to close", closed(o))

      await composeOn(o, card(o.page))
      await until("the second lead", async () => (await confidence(o).textContent()) === "exact")
      expect(requestsTo(o, "GET", SOURCE_BUNDLE_PATH)).toHaveLength(1)
      expect(requestsTo(o, "POST", SYMBOLICATE)).toHaveLength(2)
    },
    TEST_MS,
  )

  test(
    "a cancelled pick leaves nothing behind: no lead on the next composer, no upload, no extra note",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
      const hold = await holdFirstSymbolicate(o)
      await composeOn(o, card(o.page))
      await until("the first lookup to be in flight", () => hold.isHeld())
      await o.page.keyboard.press("Escape")
      await until("the composer to close", closed(o))

      await composeOn(o, o.page.locator(DETAILS))
      await noteBox(o).fill("Second pick")
      hold.release()
      await until("the second lead", async () => (await confidence(o).textContent()) === "none")
      await o.overlay.getByRole("img", { name: "Screenshot attached" }).waitFor({ timeout: 10_000 })
      await saveButton(o).click()
      await until(
        "the draft's capture",
        () => o.mock.draft()[0]?.capture?.screenshot !== undefined,
        10_000,
      )

      expect(o.mock.draft()).toHaveLength(1)
      expect(o.mock.draft()[0]?.body).toBe("Second pick")
      expect(o.mock.draft()[0]?.capture?.sourceLead?.confidence).toBe("none")
      expect(requestsTo(o, "POST", OVERLAY_ROUTES.createDraft.path)).toHaveLength(1)
      expect(requestsTo(o, "POST", SCREENSHOTS)).toHaveLength(1)
      expect(JSON.stringify(o.mock.draft())).not.toContain('"exact"')
    },
    TEST_MS,
  )

  test(
    "a note saved before its capture finishes gets the capture by a put that keeps its body, intent and target",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
      const hold = await holdFirstSymbolicate(o)
      await composeOn(o, card(o.page))
      await until("the lookup to be in flight", () => hold.isHeld())
      await o.overlay.getByRole("radio", { name: "Question" }).click()
      await saveNote(o, "Saved early")
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      const [post] = requestsTo(o, "POST", OVERLAY_ROUTES.createDraft.path)
      expect(Reflect.get(Object(post?.body), "capture")).toBeUndefined()

      hold.release()
      const id = o.mock.draft()[0]?.id ?? ""
      await until("the late put", () => putsFor(o, id).length > 0, 10_000)
      const [put] = putsFor(o, id)
      const sent = Object(put?.body)
      expect(sent.body).toBe("Saved early")
      expect(sent.intent).toBe("question")
      expect(sent.target).toEqual(Reflect.get(Object(post?.body), "target"))
      expect(sent.capture.sourceLead.confidence).toBe("exact")
      expect(o.mock.draft()[0]?.capture?.landmark).toBeDefined()
    },
    TEST_MS,
  )

  test(
    "a note deleted before its capture finishes is not put back",
    async () => {
      const o = await open(fakeSource)
      await card(o.page).evaluate((el) => el.setAttribute("data-fake-src", ""))
      const hold = await holdFirstSymbolicate(o)
      await composeOn(o, card(o.page))
      await until("the lookup to be in flight", () => hold.isHeld())
      await saveNote(o, "Doomed")
      await until("the draft to be stored", () => o.mock.draft().length === 1)
      const id = o.mock.draft()[0]?.id ?? ""
      await o.overlay.getByRole("button", { name: "Note 1, Fix" }).click()
      await o.overlay.getByRole("button", { name: "Delete" }).click()
      await until("the draft to be gone", () => o.mock.draft().length === 0)
      // The composer stays open until the overlay reads the delete reply, and the pick tool reads
      // as pressed while it does, so picking before it closes would race that reply.
      await until("the composer to close", async () => !(await noteBox(o).isVisible()))

      hold.release()
      await composeOn(o, o.page.locator(DETAILS))
      await saveNote(o, "Sentinel")
      await until(
        "the sentinel's capture",
        () => {
          const sentinel = o.mock.draft()[0]
          return sentinel !== undefined && putsFor(o, sentinel.id).length > 0
        },
        10_000,
      )
      expect(putsFor(o, id)).toHaveLength(0)
    },
    TEST_MS,
  )
})

describe("the composer's surroundings", () => {
  test(
    "describes the element in its header with tag, name and size",
    async () => {
      const o = await open()
      await composeOn(o, card(o.page))
      const box = await card(o.page).boundingBox()
      const head = dialog(o).locator(".cmp-h")
      expect(await head.locator(".comp").textContent()).toBe("p")
      expect(await head.locator(".nm").textContent()).toBe("Card in static")
      expect(await head.locator(".dim").textContent()).toBe(
        `${Math.round(box?.width ?? 0)} × ${Math.round(box?.height ?? 0)}`,
      )
      expect(await head.locator("svg").count()).toBeGreaterThan(0)
    },
    TEST_MS,
  )

  test(
    "sits beside its target, inside the viewport and clear of the dock, even for a target at the bottom",
    async () => {
      const o = await open()
      await card(o.page).evaluate((el) => el.setAttribute("style", "width:200px"))
      await composeOn(o, card(o.page))
      const target = await card(o.page).boundingBox()
      const beside = await dialog(o).boundingBox()
      if (!target || !beside) throw new Error("no boxes")
      expect(beside.x).toBeGreaterThanOrEqual(target.x + target.width + 15)
      await o.page.keyboard.press("Escape")
      await until("the composer to close", closed(o))

      await o.page.setViewportSize({ width: 1280, height: 600 })
      const footer = "footer p"
      await o.page.locator(footer).evaluate((el) => el.setAttribute("style", "width:200px"))
      await o.page.locator(footer).scrollIntoViewIfNeeded()
      await composeOn(o, o.page.locator(footer))
      const placed = await settledBox(dialog(o))
      const dock = await settledBox(o.overlay.getByRole("toolbar"))
      expect(placed.y).toBeGreaterThanOrEqual(0)
      expect(placed.y + placed.height).toBeLessThanOrEqual(600)
      const apart =
        placed.y + placed.height <= dock.y + 0.5 ||
        placed.y >= dock.y + dock.height - 0.5 ||
        placed.x + placed.width <= dock.x ||
        placed.x >= dock.x + dock.width
      expect(apart).toBe(true)
    },
    TEST_MS,
  )

  test(
    "clicking the page with text typed shakes the composer and keeps it, the text and every page event away",
    async () => {
      const o = await open()
      await installProbes(o.page)
      await composeOn(o, card(o.page))
      await noteBox(o).fill("Keep this text")
      await perform(o.page, "#probe-link", "click")
      await until("the panel to shake", () =>
        dialog(o).evaluate((el) => el.classList.contains("shake")),
      )
      expect(await noteBox(o).isVisible()).toBe(true)
      expect(await noteBox(o).inputValue()).toBe("Keep this text")
      const effects = await pageEffects(o.page)
      expect(effects.seen).toEqual([])
      expect(effects.hash).toBe("")
    },
    TEST_MS,
  )

  test(
    "cancelling a composer that holds text releases a reload the page was waiting to do",
    async () => {
      const o = await open()
      await waitFor(
        "the live socket",
        async () => {
          o.mock.push({ type: "upstream-failure", port: 5173, url: "http://localhost:5173/" })
          return (await o.overlay
            .getByRole("status")
            .filter({ hasText: "port 5173 failed" })
            .isVisible())
            ? true
            : null
        },
        { timeoutMs: 10_000 },
      )
      await o.page.evaluate(() => Reflect.set(window, "beforeReload", true))
      const stillLoaded = () =>
        o.page.evaluate(() => Reflect.get(window, "beforeReload") === true).catch(() => false)

      await composeOn(o, card(o.page))
      await noteBox(o).fill("Never saved")
      o.mock.push({ type: "reload" })
      await until("the reload-pending notice", () =>
        o.overlay
          .getByRole("status")
          .filter({ hasText: "This page changed — it reloads when you save or cancel this note" })
          .isVisible(),
      )
      expect(await stillLoaded()).toBe(true)

      await o.page.keyboard.press("Escape")
      await until("the page to reload", async () => !(await stillLoaded()), 10_000)
      expect(o.mock.draft()).toHaveLength(0)
    },
    TEST_MS,
  )
})

describe("the screenshot attachment", () => {
  test(
    "shows an 84 by 52 thumbnail of the local capture, and switching it off keeps the shot out of the saved note",
    async () => {
      const o = await open()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      await o.page.route(
        (url) => url.pathname === SCREENSHOTS,
        async (route) => {
          await gate
          await route.continue()
        },
      )
      await composeOn(o, card(o.page))
      const thumb = o.overlay.getByRole("img", { name: "Screenshot attached" })
      await thumb.waitFor({ timeout: 10_000 })
      const frame = await o.overlay.locator(".attach .tw").boundingBox()
      expect(Math.round(frame?.width ?? 0)).toBe(84)
      expect(Math.round(frame?.height ?? 0)).toBe(52)
      expect(await thumb.getAttribute("src")).toStartWith("blob:")
      expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0)

      const attach = o.overlay.getByRole("switch", { name: "Attach screenshot of this" })
      expect(await attach.getAttribute("aria-checked")).toBe("true")
      await attach.click()
      expect(await attach.getAttribute("aria-checked")).toBe("false")
      expect(await o.overlay.locator(".attach .tw").getAttribute("class")).toContain("off")

      release()
      await saveNote(o, "No picture please")
      await until(
        "the capture to reach the draft",
        () => o.mock.draft()[0]?.capture?.landmark !== undefined,
        10_000,
      )
      expect(o.mock.draft()[0]?.capture?.screenshot).toBeUndefined()
    },
    TEST_MS,
  )
})

type RingSample = { at: number; on: boolean; x: number; y: number; w: number; h: number }
type Rect = { x: number; y: number; w: number; h: number }

async function startRingSampler(page: Page) {
  await page.evaluate(() => {
    const ring = document.querySelector("iter8-overlay")?.shadowRoot?.querySelector(".ring")
    if (!ring) throw new Error("no ring in the overlay")
    const samples: RingSample[] = []
    let live = true
    const read = () => {
      const match =
        /translate\(([-\d.]+)px,\s*([-\d.]+)px\);\s*width:\s*([-\d.]+)px;\s*height:\s*([-\d.]+)px/.exec(
          ring.getAttribute("style") ?? "",
        )
      samples.push({
        at: performance.now(),
        on: ring.classList.contains("on"),
        x: Number(match?.[1] ?? Number.NaN),
        y: Number(match?.[2] ?? Number.NaN),
        w: Number(match?.[3] ?? Number.NaN),
        h: Number(match?.[4] ?? Number.NaN),
      })
      if (live) requestAnimationFrame(read)
    }
    read()
    Reflect.set(window, "ringSampler", {
      take: () => samples.splice(0),
      stop: () => {
        live = false
      },
    })
  })
  return {
    take: () =>
      page.evaluate(() =>
        (Reflect.get(window, "ringSampler") as { take: () => unknown }).take(),
      ) as Promise<RingSample[]>,
  }
}

async function rectOf(page: Page, selector: string): Promise<Rect> {
  const box = await page.locator(selector).boundingBox()
  if (!box) throw new Error(`${selector} has no box`)
  return { x: box.x, y: box.y, w: box.width, h: box.height }
}

const near = (a: number, b: number, within: number) => Math.abs(a - b) <= within
const atRect = (sample: RingSample, rect: Rect, within = 1) =>
  sample.on &&
  near(sample.x, rect.x, within) &&
  near(sample.y, rect.y, within) &&
  near(sample.w, rect.w, within) &&
  near(sample.h, rect.h, within)

describe("the outline ring", () => {
  test(
    "appears on its first target without travelling, then springs to the next one without overshooting more than the spring allows",
    async () => {
      const o = await open()
      await startPicking(o)
      const sampler = await startRingSampler(o.page)
      const a = await rectOf(o.page, CARD)
      const b = await rectOf(o.page, LOW_BUTTON)
      await hover(o, CARD)
      await until("the ring on the card", async () =>
        (await sampler.take()).some((sample) => atRect(sample, a)),
      )
      await sampler.take()
      await o.page.mouse.move(b.x + 5, b.y + 5)
      const samplesToFooter: RingSample[] = []
      await until("the ring on the footer", async () => {
        const seen = await sampler.take()
        samplesToFooter.push(...seen)
        return seen.some((sample) => atRect(sample, b, 0.5))
      })
      const travelling = samplesToFooter.filter(
        (sample) => sample.on && !atRect(sample, a, 2) && !atRect(sample, b, 2),
      )
      expect(travelling.length).toBeGreaterThanOrEqual(2)
      const distance = Math.abs(b.y - a.y)
      expect(Math.max(...samplesToFooter.map((sample) => sample.y)) - b.y).toBeLessThanOrEqual(
        0.05 * distance + 1,
      )
      const first = samplesToFooter.find((sample) => sample.on)
      const last = samplesToFooter.findLast((sample) => atRect(sample, b, 0.5))
      expect((last?.at ?? 0) - (first?.at ?? 0)).toBeLessThanOrEqual(700)
    },
    TEST_MS,
  )

  test(
    "snaps straight to the next target under reduced motion",
    async () => {
      const o = await open()
      await o.page.emulateMedia({ reducedMotion: "reduce" })
      await startPicking(o)
      const sampler = await startRingSampler(o.page)
      const a = await rectOf(o.page, CARD)
      const b = await rectOf(o.page, LOW_BUTTON)
      await hover(o, CARD)
      await until("the ring on the card", async () =>
        (await sampler.take()).some((sample) => atRect(sample, a)),
      )
      await sampler.take()
      await o.page.mouse.move(b.x + 5, b.y + 5)
      const seen: RingSample[] = []
      await until("the ring on the footer", async () => {
        seen.push(...(await sampler.take()))
        return seen.some((sample) => atRect(sample, b, 0.5))
      })
      await sampler.take().then((rest) => seen.push(...rest))
      expect(
        seen.filter((sample) => sample.on && !atRect(sample, a, 2) && !atRect(sample, b, 2)),
      ).toEqual([])
    },
    TEST_MS,
  )

  test(
    "follows a region drag exactly, with its width and height tags",
    async () => {
      const o = await open()
      await o.overlay.getByRole("button", { name: "Draw region" }).click()
      await until(
        "region mode",
        async () =>
          (await o.overlay
            .getByRole("button", { name: "Draw region" })
            .getAttribute("aria-pressed")) === "true",
      )
      const sampler = await startRingSampler(o.page)
      const small = { x: 300, y: 200, w: 20, h: 15 }
      const large = { x: 300, y: 200, w: 200, h: 150 }
      await o.page.mouse.move(300, 200)
      await o.page.mouse.down()
      await o.page.mouse.move(320, 215)
      await until("the ring on the first drag rectangle", async () =>
        (await sampler.take()).some((sample) => atRect(sample, small, 0.5)),
      )
      await o.page.mouse.move(500, 350)
      const seen: RingSample[] = []
      await until("the ring on the dragged region", async () => {
        seen.push(...(await sampler.take()))
        return seen.some((sample) => atRect(sample, large, 0.5))
      })
      expect(
        seen.filter(
          (sample) => sample.on && !atRect(sample, small, 0.5) && !atRect(sample, large, 0.5),
        ),
      ).toEqual([])
      expect(await o.overlay.locator(".ring .wtag").textContent()).toBe("200")
      expect(await o.overlay.locator(".ring .htag").textContent()).toBe("150")
      await o.page.mouse.up()
    },
    TEST_MS,
  )

  test(
    "cuts the veil open over the hovered element and every marked one, with the hovered size in the tags",
    async () => {
      const o = await open()
      await startPicking(o)
      await card(o.page).click({ modifiers: ["Shift"] })
      await o.page.locator(DETAILS).click({ modifiers: ["Shift"] })
      await hover(o, LOW_BUTTON)
      const footer = await rectOf(o.page, LOW_BUTTON)
      const holes = async () =>
        o.overlay.locator(".veil").evaluate((veil) => {
          const style = veil.getAttribute("style") ?? ""
          const corner = 6
          const marked = [
            ...style.matchAll(/M ([-\d.]+) ([-\d.]+) H ([-\d.]+) A [^V]*V ([-\d.]+)/g),
          ].map((match) => {
            const [mx, my, hx, vy] = match.slice(1).map(Number)
            return {
              x: (mx ?? 0) - corner,
              y: my ?? 0,
              w: (hx ?? 0) - (mx ?? 0) + 2 * corner,
              h: (vy ?? 0) - (my ?? 0) + corner,
            }
          })
          const [top, bottom, left, right] = [...veil.querySelectorAll("i")].map((band) =>
            band.getBoundingClientRect(),
          )
          if (!top || !bottom || !left || !right) return marked
          const hovered = {
            x: left.right,
            y: top.bottom,
            w: right.left - left.right,
            h: bottom.top - top.bottom,
          }
          return hovered.w > 0 && hovered.h > 0 ? [hovered, ...marked] : marked
        })
      await until("three holes", async () => (await holes()).length === 3)
      const expected = [
        await rectOf(o.page, LOW_BUTTON),
        await rectOf(o.page, CARD),
        await rectOf(o.page, DETAILS),
      ]
      await until("the ring to settle on the footer", async () => {
        const found = await holes()
        return expected.every((rect) =>
          found.some(
            (hole) =>
              near(hole.x, rect.x, 1) &&
              near(hole.y, rect.y, 1) &&
              near(hole.w, rect.w, 1) &&
              near(hole.h, rect.h, 1),
          ),
        )
      })
      expect(await o.overlay.locator(".ring .wtag").textContent()).toBe(
        String(Math.round(footer.w)),
      )
      expect(await o.overlay.locator(".ring .htag").textContent()).toBe(
        String(Math.round(footer.h)),
      )
    },
    TEST_MS,
  )
})
