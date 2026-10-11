import { expect, test } from "bun:test"
import { SourceConfidence } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { HEAVY_PAGE, type RunningFixture, startFixture } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "./steps"

const TYPING_BUDGET_MS = 50
const KEYSTROKE_DELAY_MS = 20
const ENRICHMENT_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 10_000

const SENTENCE = "The quick brown fox jumps over the lazy dog. "
const TYPED = SENTENCE.repeat(5).slice(0, 200)

/** The text of the first match inside the open composer, read straight from the overlay's shadow root. */
const inComposer = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const composer = document
      .querySelector("iter8-overlay")
      ?.shadowRoot?.querySelector('[role="dialog"][aria-label="New note"]')
    const found = composer?.querySelector(selector)
    return found ? (found.textContent ?? "") : null
  }, selector)

async function teardown(steps: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

test("typing a note on the heavy page stays under the long-task budget while enrichment runs", async () => {
  let fixture: RunningFixture | undefined
  let service: RunningService | undefined
  let session: AgentSession | undefined
  let browser: Browser | undefined
  let closePage: (() => Promise<void>) | undefined
  try {
    fixture = await startFixture("vite-react")
    service = await startBuiltService()
    session = await startAgentSession(service)
    browser = await launchChromium()
    const opened = await newPage(browser)
    closePage = opened.close
    const { page } = opened

    const { open } = await openThroughProxy(service, page, fixture.url(HEAVY_PAGE), { session })
    await page.goto(new URL(HEAVY_PAGE, open.url).href)

    const target = page.locator("table tbody tr:nth-child(3000) td:nth-child(3)")
    await target.scrollIntoViewIfNeeded()

    const composer = page.getByRole("dialog", { name: "New note" })
    const note = composer.getByRole("textbox", { name: "Note" })
    expect(await composer.getByRole("img", { name: "Screenshot attached" }).count()).toBe(0)
    expect(await composer.getByRole("status", { name: "Source confidence" }).count()).toBe(0)

    const pick = page.getByRole("button", { name: "Pick element" })
    await pick.click()
    await waitFor(
      "pick mode",
      async () => ((await pick.getAttribute("aria-pressed")) === "true" ? true : null),
      { timeoutMs: UI_TIMEOUT_MS },
    )
    const box = await target.boundingBox()
    if (!box) throw new Error("the target cell has no box")

    const frames = await startFrameProbe(page)
    const tasks = await startLongTaskProbe(page)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await waitFor(
      "the composer's note field to take focus",
      () =>
        page.evaluate(() => {
          const active = document.querySelector("iter8-overlay")?.shadowRoot?.activeElement
          return active?.matches('textarea[aria-label="Note"]') ? true : null
        }),
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 100 },
    )
    await page.keyboard.type(TYPED, { delay: KEYSTROKE_DELAY_MS })
    await waitFor(
      "the draft to show its screenshot",
      () => inComposer(page, 'img[alt="Screenshot attached"]'),
      { timeoutMs: ENRICHMENT_TIMEOUT_MS, everyMs: 250 },
    )
    const label = await waitFor(
      "the inspector chip to show a confidence label",
      async () => {
        const text = (
          await inComposer(page, '[role="status"][aria-label="Source confidence"]')
        )?.trim()
        return text ? text : null
      },
      { timeoutMs: ENRICHMENT_TIMEOUT_MS, everyMs: 250 },
    )
    const { longestMs, count } = await tasks.stop()
    const { late, intervals, elapsedMs } = await frames.stop()

    expect(SourceConfidence.safeParse(label).success).toBe(true)
    expect(
      longestMs,
      `longest task ${longestMs.toFixed(1)} ms, ${count} over 50 ms, ${late} late of ${intervals.length} frames in ${Math.round(elapsedMs)} ms; bound ${TYPING_BUDGET_MS} ms at rate 1`,
    ).toBeLessThanOrEqual(TYPING_BUDGET_MS)
    expect(await note.inputValue()).toBe(TYPED)
  } finally {
    await teardown([
      () => closePage?.(),
      () => browser?.close(),
      () => session?.exit(),
      () => fixture?.stop(),
      () => service?.stop(),
    ])
  }
}, 90_000)
