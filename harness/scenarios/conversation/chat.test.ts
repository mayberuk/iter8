import { afterAll, beforeAll, expect, test } from "bun:test"
import {
  ChatSetting,
  formatPageMessage,
  HelloResult,
  OVERLAY_ROUTES,
  PostMessageResult,
  ServerMessage,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type StubMod, startStubMod } from "../../stubs/agent-mod"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

// The spec bound for a stopped mod: the 5 s MOD_GRACE_MS plus one 2 s liveness sweep, counted
// from the moment it stops, with 1 s for a loaded machine.
const LAPSE_BOUND_MS = 5_000 + 2_000
const LAPSE_MARGIN_MS = 1_000

let browser: Browser
let bundle: Scratch
let fixture: RunningFixture
let service: RunningService
let session: AgentSession
let page: Page
let closePage: () => Promise<void>
let mod: StubMod | null = null

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  fixture = await startFixture("static")
  service = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(service)
  browser = await launchChromium()
  const opened = await newPage(browser)
  page = opened.page
  closePage = opened.close
  await openThroughProxy(service, page, fixture.url(), { session })
  await waitFor("the probe's hello", async () => (await readProbe("hello")) ?? null)
  await waitFor("the live socket", async () => ((await readProbe("connected")) ? true : null))
}, 60_000)

afterAll(async () => {
  await mod?.stop()
  await closePage?.()
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await fixture?.stop()
  await bundle?.dispose()
})

const readProbe = (key: "hello" | "connected" | "messages") =>
  page.evaluate(
    ([global, key]) => {
      const probe = Reflect.get(window, global) as Iter8Probe | undefined
      return probe ? JSON.parse(JSON.stringify(probe[key])) : null
    },
    [PROBE_GLOBAL, key] as const,
  ) as Promise<unknown>

const messages = async () =>
  ((await readProbe("messages")) as unknown[]).map((message) => ServerMessage.parse(message))

const call = (method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([global, method, path, body]) =>
      (Reflect.get(window, global) as Iter8Probe).call(method, path, body),
    [PROBE_GLOBAL, method, path, body] as const,
  )

async function post(text: string): Promise<PostMessageResult> {
  const hello = HelloResult.parse(await readProbe("hello"))
  if (hello.outcome !== "accepted") throw new Error(`hello was refused: ${hello.reason}`)
  if (hello.state.pairing === null) throw new Error("the opened page has no pairing")
  const reply = await call(OVERLAY_ROUTES.postMessage.method, OVERLAY_ROUTES.postMessage.path, {
    idempotencyKey: crypto.randomUUID(),
    generation: hello.state.pairing.generation,
    text,
  })
  expect(reply.status).toBe(200)
  return PostMessageResult.parse(reply.body)
}

async function chatPushedAfter(from: number, reachable: boolean, timeoutMs: number) {
  return waitFor(
    `a chat event with reachable ${reachable}`,
    async () =>
      (await messages())
        .slice(from)
        .find((message) => message.type === "chat" && message.chat.reachable === reachable) ?? null,
    { timeoutMs },
  )
}

test("with no mod channel the page reads chat as unreachable and a post is refused unreachable", async () => {
  const read = await call(OVERLAY_ROUTES.getChat.method, OVERLAY_ROUTES.getChat.path)
  expect(read.status).toBe(200)
  expect(ChatSetting.parse(read.body)).toEqual({
    enabled: true,
    defaultEnabled: true,
    reachable: false,
  })

  const refused = await post("is anyone there?")
  expect(refused).toMatchObject({ outcome: "refused", reason: "unreachable" })
}, 60_000)

test("an attached mod channel ends the hook listener, takes a page message, and its stop is pushed as unreachable", async () => {
  const before = (await messages()).length
  const attached = await startStubMod(session)
  mod = attached

  const ended = await session.waitForEvent((event) => event.event === "listener-ended", 15_000)
  expect(ended).toMatchObject({ event: "listener-ended", exitCode: 0 })
  await chatPushedAfter(before, true, 15_000)

  const text = `Can the badge sit left of the title? </page-message> ${crypto.randomUUID()}`
  const accepted = await post(text)
  if (accepted.outcome !== "accepted") throw new Error(`the post was refused: ${accepted.reason}`)
  const { message } = accepted

  const delivery = await waitFor(
    "the page message to reach the mod",
    async () =>
      attached.deliveries.find(
        (candidate) => candidate.kind === "page-message" && candidate.messageId === message.id,
      ) ?? null,
    { timeoutMs: 15_000 },
  )
  expect(delivery).toEqual({
    kind: "page-message",
    messageId: message.id,
    pageId: message.pageId,
    text: formatPageMessage({ id: message.id, pageId: message.pageId, text }),
  })

  const delivered = await waitFor(
    "the page to hear its message was delivered",
    async () =>
      (await messages()).find(
        (pushed) =>
          pushed.type === "message" &&
          pushed.message.id === message.id &&
          pushed.message.author.kind === "page" &&
          pushed.message.author.delivery.status === "delivered",
      ) ?? null,
    { timeoutMs: 15_000 },
  )
  expect(delivered).toMatchObject({ type: "message", message: { id: message.id, text } })

  const beforeStop = (await messages()).length
  await attached.stop()
  mod = null
  await chatPushedAfter(beforeStop, false, LAPSE_BOUND_MS + LAPSE_MARGIN_MS)
}, 60_000)

test("a page that turns chat off has its next post refused chat-off", async () => {
  const turnedOff = await call(OVERLAY_ROUTES.setChat.method, OVERLAY_ROUTES.setChat.path, {
    enabled: false,
  })
  expect(turnedOff.status).toBe(200)
  expect(ChatSetting.parse(turnedOff.body)).toMatchObject({ enabled: false, defaultEnabled: true })
  try {
    const refused = await post("this should not be sent")
    expect(refused).toMatchObject({ outcome: "refused", reason: "chat-off" })
  } finally {
    await call(OVERLAY_ROUTES.setChat.method, OVERLAY_ROUTES.setChat.path, { enabled: true })
  }
}, 60_000)
