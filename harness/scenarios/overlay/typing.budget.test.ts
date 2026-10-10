import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser } from "playwright"
import { launchChromium } from "../../rig/browser"
import { buildFixture, HEAVY_PAGE } from "../../rig/fixtures"
import { startLongTaskProbe } from "../../rig/long-task"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const TYPING_BUDGET_MS = 250
const TYPED =
  "This ticking cell should pause while I read it, and the row label needs more contrast."

let browser: Browser
let overlayBuild: Scratch
let heavy: Scratch

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  heavy = await buildFixture("vite-react")
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
  await heavy?.dispose()
})

async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  await waitFor(label, async () => ((await check()) ? true : null), { timeoutMs })
}

test("typing a note on the heavy page while enrichment runs keeps every main-thread task within budget", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: heavy.path,
    path: HEAVY_PAGE,
    browser,
  })
  try {
    const cell = o.page.locator("td").filter({ hasText: "Row 5941, cell 2," })
    await until("the ticking rows to render", () => cell.isVisible().catch(() => false))
    await cell.scrollIntoViewIfNeeded()

    await o.page.keyboard.press("c")
    const pick = o.overlay.getByRole("button", { name: "Pick element" })
    await until("pick mode", async () => (await pick.getAttribute("aria-pressed")) === "true")
    await cell.click()
    const note = o.overlay.getByRole("textbox", { name: "Note" })
    await until("the composer to open", () => note.isVisible())

    const probe = await startLongTaskProbe(o.page)
    await o.page.keyboard.type(TYPED, { delay: 25 })
    await until(
      "the screenshot to attach once typing pauses",
      () => o.overlay.getByRole("img", { name: "Screenshot attached" }).isVisible(),
      15_000,
    )
    expect(await note.inputValue()).toBe(TYPED)
    await o.overlay.getByRole("button", { name: "Save note" }).click()
    await until("the enriched draft to be stored", () => {
      const capture = o.mock.draft()[0]?.capture
      return (
        capture !== undefined &&
        (capture.screenshot !== undefined || capture.omittedParts.includes("screenshot"))
      )
    })
    const { longestMs } = await probe.stop()

    expect(o.mock.draft()[0]?.body).toBe(TYPED)
    expect(longestMs).toBeLessThanOrEqual(TYPING_BUDGET_MS)
  } finally {
    await o.close()
  }
}, 120_000)

test("the composer is never shown without its note field focused, so no keystroke reaches the page", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: heavy.path,
    path: HEAVY_PAGE,
    browser,
  })
  try {
    const cell = o.page.locator("td").filter({ hasText: "Row 5941, cell 2," })
    await until("the ticking rows to render", () => cell.isVisible().catch(() => false))
    await cell.scrollIntoViewIfNeeded()
    await o.page.keyboard.press("c")
    const pick = o.overlay.getByRole("button", { name: "Pick element" })
    await until("pick mode", async () => (await pick.getAttribute("aria-pressed")) === "true")

    await o.page.evaluate(() => {
      const watch = { shown: 0, shownUnfocused: 0, done: false }
      Object.assign(window, { __composerFocus: watch })
      const field = (root: Document | ShadowRoot): HTMLTextAreaElement | null => {
        for (const el of root.querySelectorAll("*")) {
          const inner =
            el.shadowRoot && (el.shadowRoot.querySelector("textarea") ?? field(el.shadowRoot))
          if (inner) return inner
        }
        return null
      }
      const sample = () => {
        const note = field(document)
        if (
          note &&
          getComputedStyle(note).visibility === "visible" &&
          note.getClientRects().length > 0
        ) {
          watch.shown++
          if ((note.getRootNode() as ShadowRoot).activeElement !== note) watch.shownUnfocused++
        }
        if (watch.shown < 50) setTimeout(sample, 0)
        else watch.done = true
      }
      sample()
    })
    await cell.click()
    const watched = () =>
      o.page.evaluate(
        () =>
          (
            window as unknown as {
              __composerFocus: { shown: number; shownUnfocused: number; done: boolean }
            }
          ).__composerFocus,
      )
    await until("fifty samples of the shown composer", async () => (await watched()).done)
    expect((await watched()).shownUnfocused).toBe(0)
  } finally {
    await o.close()
  }
}, 60_000)
