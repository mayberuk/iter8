import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  HelloResult,
  type MessageId,
  MessagePage,
  OVERLAY_ROUTES,
  PostMessageResult,
  ServerMessage,
  type TranscriptRow,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type StubMod, startStubMod } from "../../stubs/agent-mod"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

let browser: Browser
let bundle: Scratch
let service: RunningService
let session: AgentSession
let mod: StubMod
const disposers: (() => Promise<unknown>)[] = []

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  service = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(service)
  browser = await launchChromium()
  mod = await startStubMod(session)
}, 60_000)

afterAll(async () => {
  for (const dispose of disposers.reverse()) await dispose().catch(() => {})
  await mod?.stop()
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await bundle?.dispose()
})

const readProbe = (page: Page, key: "hello" | "connected" | "messages") =>
  page.evaluate(
    ([global, key]) => {
      const probe = Reflect.get(window, global) as Iter8Probe | undefined
      return probe ? JSON.parse(JSON.stringify(probe[key])) : null
    },
    [PROBE_GLOBAL, key] as const,
  ) as Promise<unknown>

// The service keeps one page per upstream origin, so a page whose conversation starts empty needs
// its own fixture. Opening it as the session pairs it, which makes it the session's focus.
async function openFreshPage() {
  const fixture = await startFixture("static")
  disposers.push(fixture.stop)
  const opened = await newPage(browser)
  disposers.push(opened.close)
  const { page, errors } = opened
  const { open } = await openThroughProxy(service, page, fixture.url(), { session })
  await waitFor("the probe's hello", async () => (await readProbe(page, "hello")) ?? null)
  await waitFor("the live socket", async () => ((await readProbe(page, "connected")) ? true : null))

  const call = (method: string, path: string, body?: unknown) =>
    page.evaluate(
      ([global, method, path, body]) =>
        (Reflect.get(window, global) as Iter8Probe).call(method, path, body),
      [PROBE_GLOBAL, method, path, body] as const,
    )

  return {
    pageId: open.page.id,
    errors,
    call,
    messages: async () =>
      ((await readProbe(page, "messages")) as unknown[]).map((message) =>
        ServerMessage.parse(message),
      ),
    generation: async () => {
      const hello = HelloResult.parse(await readProbe(page, "hello"))
      if (hello.outcome !== "accepted") throw new Error(`hello was refused: ${hello.reason}`)
      if (hello.state.pairing === null) throw new Error("the opened page has no pairing")
      return hello.state.pairing.generation
    },
    list: async (before?: MessageId) => {
      const query = before === undefined ? "" : `?${new URLSearchParams({ before })}`
      const reply = await call(
        OVERLAY_ROUTES.listMessages.method,
        `${OVERLAY_ROUTES.listMessages.path}${query}`,
      )
      expect(reply.status).toBe(200)
      return MessagePage.parse(reply.body)
    },
  }
}

const row = (role: TranscriptRow["role"], text: string): TranscriptRow => ({
  key: crypto.randomUUID(),
  role,
  text,
  at: new Date().toISOString(),
})

test("an assistant row the mod forwards reaches the open page as a message from the session's agent", async () => {
  const page = await openFreshPage()
  const forwarded = row("assistant", `Tightened the heading ${crypto.randomUUID()}`)

  const result = await mod.forward([forwarded])
  expect(result.pageId).toBe(page.pageId)
  const [id, ...extra] = result.stored
  if (id === undefined) throw new Error("the forwarded row was not stored")
  expect(extra).toEqual([])

  const pushed = await waitFor("the message event", async () => {
    const messages = await page.messages()
    return messages.find((message) => message.type === "message") ?? null
  })
  expect(pushed).toEqual({
    type: "message",
    message: {
      id,
      pageId: page.pageId,
      roundId: null,
      author: { kind: "agent", owner: mod.owner, name: session.label, agent: "stub" },
      text: forwarded.text,
      at: forwarded.at,
    },
  })
  expect(page.errors).toEqual([])
}, 60_000)

test("35 forwarded rows page back newest first in pages of 30, then 5 with nothing older", async () => {
  const page = await openFreshPage()
  const rows = Array.from({ length: 35 }, (_, index) => row("assistant", `row ${index + 1}`))

  const result = await mod.forward(rows)
  expect(result.stored).toHaveLength(35)

  const newest = await page.list()
  expect(newest.messages.map((message) => message.text)).toEqual(
    rows.slice(5).map((sent) => sent.text),
  )
  expect(newest.hasOlder).toBe(true)

  const oldestShown = newest.messages[0]
  if (oldestShown === undefined) throw new Error("the newest page is empty")
  const older = await page.list(oldestShown.id)
  expect(older.messages.map((message) => message.text)).toEqual(
    rows.slice(0, 5).map((sent) => sent.text),
  )
  expect(older.hasOlder).toBe(false)
}, 60_000)

test("re-forwarding rows with the same keys stores nothing", async () => {
  const page = await openFreshPage()
  const rows = [row("assistant", "first answer"), row("user", "a follow-up typed in the terminal")]

  const first = await mod.forward(rows)
  expect(first.stored).toHaveLength(2)
  const again = await mod.forward(rows)
  expect(again).toEqual({ pageId: page.pageId, stored: [] })

  const listed = await page.list()
  expect(listed.messages.map((message) => message.text)).toEqual(rows.map((sent) => sent.text))
}, 60_000)

test("a user row echoing a delivered page message is not stored a second time", async () => {
  const page = await openFreshPage()
  const typedOnPage = `Make the header sticky ${crypto.randomUUID()}`
  const posted = await page.call(
    OVERLAY_ROUTES.postMessage.method,
    OVERLAY_ROUTES.postMessage.path,
    {
      idempotencyKey: crypto.randomUUID(),
      generation: await page.generation(),
      text: typedOnPage,
    },
  )
  expect(posted.status).toBe(200)
  const result = PostMessageResult.parse(posted.body)
  if (result.outcome !== "accepted") throw new Error(`the post was refused: ${result.reason}`)

  const delivery = await waitFor(
    "the page message to reach the mod",
    async () =>
      mod.deliveries.find(
        (candidate) =>
          candidate.kind === "page-message" && candidate.messageId === result.message.id,
      ) ?? null,
    { timeoutMs: 15_000 },
  )
  const typedInTerminal = row("user", "and keep it under 64px")

  const forwarded = await mod.forward([row("user", delivery.text), typedInTerminal])
  expect(forwarded.stored).toHaveLength(1)

  const listed = await page.list()
  expect(listed.messages.map((message) => message.text)).toEqual([
    typedOnPage,
    typedInTerminal.text,
  ])
}, 60_000)
