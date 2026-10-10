import { expect, test } from "bun:test"
import { SourceConfidence } from "@iter8/protocol"
import type { Browser } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { HEAVY_PAGE, type RunningFixture, startFixture } from "../../rig/fixtures"
import { startLongTaskProbe } from "../../rig/long-task"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "./steps"

const TYPING_BUDGET_MS = 250
const KEYSTROKE_DELAY_MS = 20
const ENRICHMENT_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 10_000

const SENTENCE = "The quick brown fox jumps over the lazy dog. "
const TYPED = SENTENCE.repeat(5).slice(0, 200)

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
    const screenshot = composer.getByRole("img", { name: "Screenshot attached" })
    const confidence = composer.getByRole("status", { name: "Source confidence" })
    expect(await screenshot.count()).toBe(0)
    expect(await confidence.count()).toBe(0)

    const probe = await startLongTaskProbe(page)
    await page.getByRole("button", { name: "Pick element" }).click()
    await target.click()
    await waitFor(
      "the composer's note field to take focus",
      () =>
        note.evaluate((el) => {
          const root = el.getRootNode()
          return root instanceof ShadowRoot && root.activeElement === el ? true : null
        }),
      { timeoutMs: UI_TIMEOUT_MS, everyMs: 50 },
    )

    await page.keyboard.type(TYPED, { delay: KEYSTROKE_DELAY_MS })

    await waitFor(
      "the draft to show its screenshot",
      async () => ((await screenshot.count()) > 0 ? true : null),
      { timeoutMs: ENRICHMENT_TIMEOUT_MS, everyMs: 250 },
    )
    const label = await waitFor(
      "the inspector chip to show a confidence label",
      async () => {
        if ((await confidence.count()) === 0) return null
        const text = (await confidence.textContent())?.trim() ?? ""
        return text === "" ? null : text
      },
      { timeoutMs: ENRICHMENT_TIMEOUT_MS, everyMs: 250 },
    )
    expect(SourceConfidence.safeParse(label).success).toBe(true)

    const { longestMs } = await probe.stop()

    expect(longestMs).toBeLessThanOrEqual(TYPING_BUDGET_MS)
    expect(await note.inputValue()).toBe(TYPED)
  } finally {
    await teardown([
      () => closePage?.(),
      () => browser?.close(),
      () => service?.stop(),
      () => session?.exit(),
      () => fixture?.stop(),
    ])
  }
}, 90_000)
