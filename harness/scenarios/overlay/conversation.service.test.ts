import { expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import { basename } from "node:path"
import {
  formatPageMessage,
  MessagePage,
  OVERLAY_ROUTES,
  ServiceStatus,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Locator } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startStubMod } from "../../stubs/agent-mod"
import { startBuiltService } from "../e2e/steps"

const UI_TIMEOUT_MS = 10_000
const MOD_TIMEOUT_MS = 15_000
// The service's 5 s mod grace plus one 2 s liveness sweep, with 3 s for the push and a loaded machine.
const MOD_LAPSE_TIMEOUT_MS = 5_000 + 2_000 + 3_000

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

const appears = (label: string, locator: Locator, timeoutMs = UI_TIMEOUT_MS) =>
  waitFor(label, async () => ((await locator.count()) > 0 ? true : null), { timeoutMs })

test("the conversation panel shows an agent's finished message, sends a page message through the real service and mod, and explains a mod that went away", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  let service: RunningService | undefined
  try {
    service = await startBuiltService()
    const running = service

    const copy = await scratchDir(`${SCRATCH_ROOT}overlay-conversation-service-`)
    disposers.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })

    const browser = await launchChromium()
    disposers.push(() => browser.close())
    const opened = await newPage(browser)
    disposers.push(opened.close)
    const { page } = opened

    const session = await startAgentSession(running)
    disposers.push(() => session.exit())

    const { open, token } = await openThroughProxy(running, page, copy.path, { session })

    const paired = (await session.run(["status", "--json"])).json(ServiceStatus).owner
    if (paired === null) throw new Error("status resolved no pairing for the session")
    const name = basename(paired.cwd)

    const mod = await startStubMod(session)
    disposers.push(() => mod.stop())

    await appears("the round sheet button", page.getByRole("button", { name: "Open round sheet" }))
    await page.getByRole("button", { name: "Open round sheet" }).click()
    const sheet = page.getByRole("complementary", { name: "Round sheet" })
    await sheet.getByRole("tab", { name: "Conversation" }).click()
    const panel = sheet.getByRole("tabpanel", { name: "Conversation" })
    const input = panel.getByRole("textbox", { name: `Message ${name}` })
    await appears("the chat input once the mod is attached", input, MOD_TIMEOUT_MS)

    const agentText = `The badge now sits left of the title. ${crypto.randomUUID()}`
    const forwarded = await mod.forward([
      {
        key: crypto.randomUUID(),
        role: "assistant",
        text: agentText,
        at: new Date().toISOString(),
      },
    ])
    expect(forwarded.pageId).toBe(open.page.id)
    expect(forwarded.stored).toHaveLength(1)

    const messages = panel.getByRole("log", { name: "Messages" }).getByRole("article")
    const agentRow = messages.filter({ hasText: agentText })
    await appears("the agent's message in the open conversation", agentRow)
    expect(await agentRow.getByText(`stub · ${session.label}`, { exact: true }).count()).toBe(1)
    expect(await agentRow.getByText("You, from this page").count()).toBe(0)

    const chatText = `Can the badge sit left of the title? ${crypto.randomUUID()}`
    await input.fill(chatText)
    await input.press("Enter")
    const chatRow = messages.filter({ hasText: chatText })
    await appears("the sent message to show at once", chatRow, 2_000)
    expect(await chatRow.getByText("You, from this page").count()).toBe(1)

    const stored = await waitFor(
      "the service to hold the page message",
      async () => {
        const listed = MessagePage.parse(
          await page.evaluate(
            async ([path, header, value]) =>
              (await fetch(path, { headers: { [header]: value } })).json(),
            [OVERLAY_ROUTES.listMessages.path, TOKEN_HEADER, token] as const,
          ),
        )
        return (
          listed.messages.find(
            (message) => message.author.kind === "page" && message.text === chatText,
          ) ?? null
        )
      },
      { timeoutMs: UI_TIMEOUT_MS },
    )
    expect(stored.pageId).toBe(open.page.id)

    const delivery = await waitFor(
      "the page message to reach the mod",
      async () =>
        mod.deliveries.find(
          (candidate) => candidate.kind === "page-message" && candidate.messageId === stored.id,
        ) ?? null,
      { timeoutMs: MOD_TIMEOUT_MS },
    )
    expect(delivery).toEqual({
      kind: "page-message",
      messageId: stored.id,
      pageId: open.page.id,
      text: formatPageMessage({ id: stored.id, pageId: open.page.id, text: chatText }),
    })

    await appears(
      "the panel to show the message as taken",
      chatRow.getByText(`Taken by ${name}`),
      MOD_TIMEOUT_MS,
    )
    expect(await chatRow.getByText(`Waiting for ${name} to take it`).count()).toBe(0)

    await mod.stop()
    await appears(
      "the unreachable explanation",
      panel.getByText(`${name} can't take page messages right now`),
      MOD_LAPSE_TIMEOUT_MS,
    )
    expect(await input.count()).toBe(0)
  } finally {
    await teardown([...disposers.reverse(), () => service?.stop()])
  }
}, 90_000)
