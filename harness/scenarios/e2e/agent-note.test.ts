import { expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import { AgentNoteResult } from "@iter8/protocol"
import type { Locator } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "./steps"

const UI_TIMEOUT_MS = 10_000
const CARD = '[data-source-target="card"]'
const CARD_TEXT = "Card in static"
const PIN_REACH_PX = 24

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

const appears = (label: string, locator: Locator) =>
  waitFor(label, async () => ((await locator.count()) > 0 ? true : null), {
    timeoutMs: UI_TIMEOUT_MS,
  })

test("an agent's note is pinned on its element with the agent's avatar and body, and one with no element is listed as unanchored", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  let service: RunningService | undefined
  try {
    service = await startBuiltService()
    const running = service

    const copy = await scratchDir(`${SCRATCH_ROOT}e2e-agent-note-`)
    disposers.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })

    const browser = await launchChromium()
    disposers.push(() => browser.close())
    const opened = await newPage(browser)
    disposers.push(opened.close)
    const { page } = opened

    const session = await startAgentSession(running)
    disposers.push(() => session.exit())

    const { open } = await openThroughProxy(running, page, copy.path, { session })

    const pinnedBody = `Is this card the right wording? ${crypto.randomUUID()}`
    const pinned = (
      await session.run([
        "note",
        open.page.id,
        "--intent",
        "question",
        "--body",
        pinnedBody,
        "--at",
        CARD,
        "--text",
        CARD_TEXT,
        "--json",
      ])
    ).json(AgentNoteResult)
    expect(pinned.note.body).toBe(pinnedBody)

    const pin = page.getByRole("button", { name: `${session.label} note`, exact: true })
    await appears("the agent's pin to appear", pin)
    const card = page.locator(CARD)
    await waitFor(
      "the agent's pin to sit on the card",
      async () => {
        const [pinBox, cardBox] = [await pin.boundingBox(), await card.boundingBox()]
        if (pinBox === null || cardBox === null) return null
        const dx = pinBox.x + pinBox.width / 2 - (cardBox.x + cardBox.width)
        const dy = pinBox.y + pinBox.height / 2 - cardBox.y
        return Math.hypot(dx, dy) <= PIN_REACH_PX ? true : null
      },
      { timeoutMs: UI_TIMEOUT_MS },
    )
    expect(await pin.getByRole("img", { name: "stub" }).count()).toBe(1)

    await pin.hover()
    const tooltip = page.getByRole("tooltip")
    await appears("the pin's card to open", tooltip.getByText(pinnedBody))
    expect(await tooltip.getByText(session.label, { exact: true }).count()).toBe(1)
    expect(await tooltip.getByRole("img", { name: "stub" }).count()).toBe(1)

    const strayBody = `Where did this go? ${crypto.randomUUID()}`
    const stray = await session.run([
      "note",
      open.page.id,
      "--intent",
      "question",
      "--body",
      strayBody,
      "--at",
      "#does-not-exist",
      "--json",
    ])
    expect(stray.json(AgentNoteResult).note.body).toBe(strayBody)

    const unanchored = page.getByRole("list", { name: "Unanchored notes" })
    await appears("the note with no element to be listed", unanchored.getByText(strayBody))
    expect(await unanchored.getByText(pinnedBody).count()).toBe(0)
    expect(await unanchored.getByText("Unanchored", { exact: true }).count()).toBe(1)
  } finally {
    await teardown([() => service?.stop(), ...disposers.reverse()])
  }
}, 60_000)
