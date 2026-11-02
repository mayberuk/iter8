import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { Browser } from "playwright"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const STATIC = fixtureDir("static")
const CARD = '[data-source-target="card"]'
const TEST_MS = 30_000
const SENTENCE = "Can this spacing be crisper? Copy reads poorly."

type Opened = Awaited<ReturnType<typeof openOverlay>>

let browser: Browser
let overlayBuild: Scratch
let opened: Opened | null = null

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

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 5000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

/** The static fixture plus a page script with GitHub-style single-letter hotkeys on document. */
async function openWithHotkeys(): Promise<Opened> {
  opened = await openOverlay({ overlayDir: overlayBuild.path, folder: STATIC, browser })
  const o = opened
  await until("the dock to be ready", () =>
    o.overlay.getByRole("button", { name: "Pick element" }).isVisible(),
  )
  await o.page.evaluate(() => {
    const seen: string[] = []
    Reflect.set(window, "pageKeys", seen)
    document.addEventListener("keydown", (event) => {
      seen.push(event.key)
      const target = event.target
      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return
      if (event.key.length === 1) event.preventDefault()
    })
  })
  return o
}

const pageKeys = (o: Opened) =>
  o.page.evaluate(() => [...((Reflect.get(window, "pageKeys") as string[] | undefined) ?? [])])

async function openComposer(o: Opened) {
  await o.page.keyboard.press("c")
  const tool = o.overlay.getByRole("button", { name: "Pick element" })
  await until("pick mode", async () => (await tool.getAttribute("aria-pressed")) === "true")
  await o.page.locator(CARD).click()
  const note = o.overlay.getByRole("textbox", { name: "Note" })
  await until("the composer to open", () => note.isVisible())
  await note.focus()
  await o.page.evaluate(() => (Reflect.get(window, "pageKeys") as string[]).splice(0))
  return note
}

describe("a host page's single-letter hotkeys", () => {
  test(
    "never swallow letters typed into the composer, and never see those keys",
    async () => {
      const o = await openWithHotkeys()
      const note = await openComposer(o)
      await o.page.keyboard.type(SENTENCE)
      expect(await note.inputValue()).toBe(SENTENCE)
      expect(await pageKeys(o)).toEqual([])
    },
    TEST_MS,
  )

  test(
    "still see keys typed into the page's own input",
    async () => {
      const o = await openWithHotkeys()
      const title = o.page.locator("#title")
      await title.click()
      await o.page.keyboard.type("crisp")
      expect(await title.inputValue()).toBe("crisp")
      expect(await pageKeys(o)).toEqual(["c", "r", "i", "s", "p"])
    },
    TEST_MS,
  )

  test(
    "leave the overlay's own keys working from the composer: the palette toggle and Escape",
    async () => {
      const o = await openWithHotkeys()
      const note = await openComposer(o)
      await o.page.keyboard.type("draft")
      const palette = o.overlay.getByRole("dialog", { name: "Command palette" })
      await o.page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k")
      await until("the palette to open", () => palette.isVisible())
      await o.page.keyboard.press("Escape")
      await until("the palette to close", async () => !(await palette.isVisible()))
      await note.focus()
      await o.page.keyboard.press("Escape")
      await until("the composer to close", async () => !(await note.isVisible()))
      expect(await pageKeys(o)).toEqual([])
    },
    TEST_MS,
  )
})
