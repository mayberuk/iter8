import { afterAll, beforeAll, expect, test } from "bun:test"
import { ConversationMessage, MESSAGE_PAGE_DEFAULT, Pairing } from "@iter8/protocol"
import type { Browser } from "playwright"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { startFrameProbe } from "../../rig/frames"
import { startLongTaskProbe } from "../../rig/long-task"
import type { Scratch } from "../../rig/scratch"
import { calibrateThrottle, throttleCpu } from "../../rig/throttle"
import { waitFor } from "../../rig/wait"
import { buildOverlay, openOverlay } from "./support"

const TASK_BUDGET_MS = 50
const LIVE = Pairing.parse(pairingJson)

const body = (n: number) => `## Step ${n}: the pricing card

The **badge** now wraps below the price under 360px, and \`PricingCard.tsx\` keeps one line at 320px.
See [the notes](https://example.test/notes/${n}) for the measurements.

- the price stays on one line
- the CTA is 36px, the same as the toggle
  - checked at 320px and 360px

| Breakpoint | Price | CTA | Result |
|:--|--:|--:|:--|
| 320px | $12 | 36px | one line |
| 360px | $12 | 36px | one line |

\`\`\`ts
export function price(cents: number): string {
  // formatted once, never per render
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}
\`\`\`

\`\`\`diff
- width: 100%
+ width: min(100%, 320px)
\`\`\`
`

const message = (n: number) =>
  ConversationMessage.parse({
    ...agentJson,
    id: `M${n}`,
    pageId: "mockpage",
    roundId: null,
    text: body(n),
    at: new Date(Date.UTC(2026, 9, 9, 10, n)).toISOString(),
  })

let browser: Browser
let overlayBuild: Scratch
let throttledRate = 1

beforeAll(async () => {
  browser = await launchChromium()
  overlayBuild = await buildOverlay()
  throttledRate = (await calibrateThrottle(browser)).rate
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await overlayBuild?.dispose()
})

test("opening a history of rich messages at the calibrated 4x throttle runs no main-thread task over budget", async () => {
  const o = await openOverlay({
    overlayDir: overlayBuild.path,
    folder: fixtureDir("static"),
    mock: {
      pairing: LIVE,
      messages: Array.from({ length: MESSAGE_PAGE_DEFAULT }, (_, i) => message(i + 1)),
    },
    browser,
  })
  const throttle = await throttleCpu(o.page, throttledRate)
  try {
    const sheet = o.overlay.getByRole("complementary", { name: "Round sheet" })
    await o.overlay.getByRole("button", { name: "Open round sheet" }).click()
    await waitFor("the round sheet", async () => ((await sheet.isVisible()) ? true : null))

    const frames = await startFrameProbe(o.page)
    const tasks = await startLongTaskProbe(o.page)
    await sheet.getByRole("tab", { name: "Conversation" }).click()
    const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
    const rows = panel.getByRole("log").getByRole("article")
    await waitFor("every message", async () =>
      (await rows.count()) === MESSAGE_PAGE_DEFAULT ? true : null,
    )
    const blocks = panel.locator(".md-code")
    await waitFor(
      "every code block highlighted",
      async () => {
        const highlighted = await blocks.evaluateAll(
          (els) => els.filter((el) => el.querySelector(".tk-kw, .line.add")).length,
        )
        return highlighted === MESSAGE_PAGE_DEFAULT * 2 ? true : null
      },
      { timeoutMs: 20_000 },
    )
    const { longestMs, count } = await tasks.stop()
    const { late, worstMs } = await frames.stop()

    expect(o.errors).toEqual([])
    expect(
      longestMs,
      `longest task ${longestMs.toFixed(1)} ms, ${count} over 50 ms, ${late} late frames, worst frame ${worstMs.toFixed(1)} ms at ${throttledRate.toFixed(2)}x`,
    ).toBeLessThanOrEqual(TASK_BUDGET_MS)
  } finally {
    await throttle.restore()
    await o.close()
  }
}, 120_000)
