import { afterAll, beforeAll, expect, test } from "bun:test"
import { ConversationMessage, Pairing } from "@iter8/protocol"
import type { Browser } from "playwright"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { buildFixture, HEAVY_PAGE } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const TYPING_BUDGET_MS = 50
const SEEDED = 60
const PUSH_EVERY_MS = 150
const TYPED =
  "Keep this chat input steady while finished messages from the session keep arriving below"
    .padEnd(90, ".")
    .slice(0, 90)
const LIVE = Pairing.parse(pairingJson)

const message = (n: number) =>
  ConversationMessage.parse({
    ...agentJson,
    id: `M${n}`,
    pageId: "mockpage",
    roundId: null,
    text: `Finished step ${n}: updated the table rendering and checked the layout again.`,
    at: new Date(Date.UTC(2026, 9, 9, 10, 0, n)).toISOString(),
  })

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

test("typing a chat message on the heavy page while messages arrive keeps every main-thread task within budget", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: heavy.path,
    path: HEAVY_PAGE,
    mock: {
      pairing: LIVE,
      messages: Array.from({ length: SEEDED }, (_, i) => message(i + 1)),
    },
    browser,
  })
  let pusher: ReturnType<typeof setInterval> | null = null
  try {
    const cell = o.page.locator("td").filter({ hasText: "Row 5941, cell 2," })
    await until("the ticking rows to render", () => cell.isVisible().catch(() => false), 30_000)

    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await until("the round sheet", () => sheet.isVisible())
    await sheet.getByRole("tab", { name: "Conversation" }).click()
    const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
    const rows = panel.getByRole("log").getByRole("article")
    await until("the newest page of messages", async () => (await rows.count()) === 30)
    const field = panel.getByRole("textbox", { name: "Message larkspur" })
    await until("the chat input focused", () =>
      field.evaluate((el) => (el.getRootNode() as ShadowRoot).activeElement === el),
    )

    let last = SEEDED
    let pushed = 0
    const frames = await startFrameProbe(o.page)
    const tasks = await startLongTaskProbe(o.page)
    pusher = setInterval(() => {
      // Above every held id: the mock numbers the typed message from the same sequence.
      last = Math.max(last, ...o.mock.messages().map((m) => Number(m.id.slice(1)))) + 1
      o.mock.pushMessage(message(last))
      pushed++
    }, PUSH_EVERY_MS)
    const firstLive = rows.filter({ hasText: `Finished step ${SEEDED + 1}:` })
    await o.page.keyboard.type(TYPED.slice(0, 45), { delay: 25 })
    await until(
      "a message pushed during typing in the list",
      async () => (await firstLive.count()) === 1,
    )
    await o.page.keyboard.type(TYPED.slice(45), { delay: 25 })
    await o.page.keyboard.press("Enter")
    await until(
      "the sent message in the list",
      async () => (await rows.filter({ hasText: TYPED }).count()) === 1,
    )
    clearInterval(pusher)
    pusher = null
    const lastLive = rows.filter({ hasText: `Finished step ${last}:` })
    await until("the last pushed message in the list", async () => (await lastLive.count()) === 1)
    const { longestMs, count } = await tasks.stop()
    const { late, worstMs } = await frames.stop()

    expect(
      o.mock
        .messages()
        .filter((m) => m.author.kind === "page")
        .map((m) => m.text),
    ).toEqual([TYPED])
    expect(pushed).toBeGreaterThan(5)
    expect(o.errors).toEqual([])
    expect(
      longestMs,
      `longest task ${longestMs.toFixed(1)} ms, ${count} over 50 ms, ${pushed} messages pushed, ${late} late frames, worst frame ${worstMs.toFixed(1)} ms`,
    ).toBeLessThanOrEqual(TYPING_BUDGET_MS)
  } finally {
    if (pusher !== null) clearInterval(pusher)
    await o.close()
  }
}, 240_000)
