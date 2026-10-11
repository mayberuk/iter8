import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test"
import {
  ChatSetting,
  ConversationMessage,
  LIVE_PATH,
  LiveSession,
  liveSubprotocols,
  MESSAGE_MAX_CHARS,
  MESSAGE_PAGE_DEFAULT,
  MessagePage,
  OVERLAY_ROUTES,
  Pairing,
  PostMessageResult,
  Round,
  SendNowResult,
  ServerMessage,
  TOKEN_HEADER,
} from "@iter8/protocol"
import fc from "fast-check"
import failedJson from "../../../packages/protocol/fixtures/ConversationMessage.failed.json"
import agentJson from "../../../packages/protocol/fixtures/ConversationMessage.json"
import pageJson from "../../../packages/protocol/fixtures/ConversationMessage.page.json"
import userJson from "../../../packages/protocol/fixtures/ConversationMessage.user.json"
import liveSessionJson from "../../../packages/protocol/fixtures/LiveSession.json"
import goneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import queuedJson from "../../../packages/protocol/fixtures/Round.queued.json"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import {
  type MockService,
  type MockServiceOptions,
  startMockService,
} from "../../stubs/mock-service"

const R = OVERLAY_ROUTES
const PAIRING = Pairing.parse(pairingJson)
const GONE = Pairing.parse(goneJson)
const LIVE_SESSION = LiveSession.parse(liveSessionJson)
const CHAT_ON = ChatSetting.parse({ enabled: true, defaultEnabled: true, reachable: true })

const message = (n: number) =>
  ConversationMessage.parse({ ...agentJson, id: `M${n}`, text: `Message ${n}` })
const messageIds = (list: { id: string }[]) => list.map((item) => item.id)

const seedKinds = ["agent", "user", "queued", "delivered", "failed"] as const
function seedAt(n: number) {
  const base = {
    id: `M${n}`,
    text: `Seed ${n}\nsecond line`,
    at: `2026-10-09T18:${String(n % 60).padStart(2, "0")}:00.000Z`,
  }
  const kind = seedKinds[n % seedKinds.length]
  const pageAuthor = (delivery: unknown) => ({
    kind: "page",
    idempotencyKey: `chat-seed-${n}`,
    delivery,
  })
  switch (kind) {
    case "agent":
      return ConversationMessage.parse({ ...agentJson, ...base, roundId: `R${n}` })
    case "user":
      return ConversationMessage.parse({ ...userJson, ...base })
    case "queued":
      return ConversationMessage.parse({
        ...pageJson,
        ...base,
        author: pageAuthor({ status: "queued" }),
      })
    case "delivered":
      return ConversationMessage.parse({
        ...pageJson,
        ...base,
        roundId: `R${n}`,
        author: pageAuthor({ status: "delivered", at: "2026-10-09T19:00:00.000Z" }),
      })
    default:
      return ConversationMessage.parse({
        ...failedJson,
        ...base,
        author: pageAuthor({ status: "failed", reason: "session-gone" }),
      })
  }
}
const seedNumbers = (maxLength: number) =>
  fc.uniqueArray(fc.integer({ min: 1, max: 400 }), { minLength: 0, maxLength })
const numberOf = (id: string) => Number(id.slice(1))
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `M${from + i}`)

function roundAt(id: string, state: Record<string, unknown>) {
  return Round.parse({ ...queuedJson, id, state })
}

const queuedState = {
  stage: "queued",
  queuedAt: "2026-10-09T18:34:00.000Z",
  idempotencyKey: "send-seeded",
}
const announcedState = {
  ...queuedState,
  stage: "announced",
  announcedAt: "2026-10-09T18:35:00.000Z",
  generation: 2,
}
const claimedState = {
  ...announcedState,
  stage: "claimed",
  claimedAt: "2026-10-09T18:36:00.000Z",
}
const orphanedState = {
  stage: "orphaned",
  queuedAt: "2026-10-09T18:20:00.000Z",
  idempotencyKey: "send-seeded",
  orphanedAt: "2026-10-09T18:26:00.000Z",
}

let overlay: Scratch
let mock: MockService

beforeAll(async () => {
  overlay = await scratchDir(`${SCRATCH_ROOT}overlay-`)
})

afterEach(async () => {
  await mock?.stop()
})

afterAll(async () => {
  await overlay?.dispose()
})

async function start(options: Partial<MockServiceOptions> = {}) {
  mock = await startMockService({
    folder: fixtureDir("static"),
    overlayDir: overlay.path,
    pairing: PAIRING,
    ...options,
  })
  return mock
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  overrides: Record<string, string | undefined> = {},
) {
  const headers = new Headers({
    [TOKEN_HEADER]: mock.token,
    origin: mock.origin,
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  })
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) headers.delete(name)
    else headers.set(name, value)
  }
  return await mock.app.request(mock.pageUrl(path), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function list(query = "") {
  const response = await call("GET", `${R.listMessages.path}${query}`)
  return {
    status: response.status,
    page: response.ok ? MessagePage.parse(await response.json()) : null,
  }
}

function post(key: string, text = "Hello.", generation: number = PAIRING.generation) {
  return call("POST", R.postMessage.path, { idempotencyKey: key, generation, text })
}

async function posted(key: string, text = "Hello.", generation: number = PAIRING.generation) {
  return PostMessageResult.parse(await (await post(key, text, generation)).json())
}

function sendNow(roundId: string) {
  return call("POST", R.sendNow.path.replace(":roundId", roundId))
}

async function nudged(roundId: string) {
  return SendNowResult.parse(await (await sendNow(roundId)).json())
}

async function idle() {
  for (let i = 0; i < 3; i++) await call("GET", R.getChat.path)
}

function track(response: Promise<Response>) {
  let settled = false
  const done = response.then((r) => {
    settled = true
    return r
  })
  return { done, settled: () => settled }
}

async function result(response: Response) {
  return PostMessageResult.parse(await response.json())
}

async function rawConnect(head: string[], body: string, onData: (chunk: string) => void) {
  const request = `${head.join("\r\n")}\r\n\r\n${body}`
  return await Bun.connect({
    hostname: "127.0.0.1",
    port: mock.port,
    socket: {
      open(socket) {
        socket.write(request)
      },
      data(_socket, chunk) {
        onData(chunk.toString())
      },
    },
  })
}

function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${mock.port}${LIVE_PATH}`, {
    headers: { host: new URL(mock.origin).host, origin: mock.origin },
    protocols: liveSubprotocols(mock.token),
  } as unknown as string[])
  const received: ServerMessage[] = []
  const closed = new Promise<number>((resolve) => {
    socket.onclose = (event) => resolve(event.code)
  })
  socket.onmessage = (event) => received.push(ServerMessage.parse(JSON.parse(String(event.data))))
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("live socket refused"))
  })
  return { socket, received, opened, closed }
}

describe("listMessages", () => {
  test("45 seeded messages page as 30 then 15, contiguous, in id order, with an accurate hasOlder", async () => {
    await start({ messages: Array.from({ length: 45 }, (_, i) => message(i + 1)).reverse() })
    expect(MESSAGE_PAGE_DEFAULT).toBe(30)

    const newest = await list()
    expect(messageIds(newest.page?.messages ?? [])).toEqual(range(16, 45))
    expect(newest.page?.hasOlder).toBe(true)

    const older = await list("?before=M16")
    expect(messageIds(older.page?.messages ?? [])).toEqual(range(1, 15))
    expect(older.page?.hasOlder).toBe(false)
  })

  test("ids order numerically, so M10 follows M9", async () => {
    await start({ messages: [message(10), message(9), message(100)] })
    expect(messageIds((await list()).page?.messages ?? [])).toEqual(["M9", "M10", "M100"])
    expect(messageIds((await list("?before=M100")).page?.messages ?? [])).toEqual(["M9", "M10"])
  })

  test("a conversation of exactly one page has no older messages, one more has", async () => {
    await start({ messages: range(1, 30).map((id) => message(Number(id.slice(1)))) })
    expect((await list()).page).toMatchObject({ hasOlder: false })
    expect(messageIds((await list()).page?.messages ?? [])).toEqual(range(1, 30))
    await mock.stop()

    await start({ messages: range(1, 31).map((id) => message(Number(id.slice(1)))) })
    const page = (await list()).page
    expect(messageIds(page?.messages ?? [])).toEqual(range(2, 31))
    expect(page?.hasOlder).toBe(true)
  })

  test("limit bounds the page and before at the oldest id returns nothing", async () => {
    await start({ messages: range(1, 5).map((id) => message(Number(id.slice(1)))) })
    const one = (await list("?limit=1")).page
    expect(messageIds(one?.messages ?? [])).toEqual(["M5"])
    expect(one?.hasOlder).toBe(true)
    const all = (await list("?limit=100")).page
    expect(messageIds(all?.messages ?? [])).toEqual(range(1, 5))
    expect(all?.hasOlder).toBe(false)
    expect((await list("?before=M1")).page).toEqual({ messages: [], hasOlder: false })
    const beyond = (await list("?before=M999&limit=2")).page
    expect(messageIds(beyond?.messages ?? [])).toEqual(["M4", "M5"])
    expect(beyond?.hasOlder).toBe(true)
  })

  test("an empty conversation lists nothing", async () => {
    await start()
    expect((await list()).page).toEqual({ messages: [], hasOlder: false })
  })

  test("any seeded set pages newest-first with the exact limit, an accurate hasOlder and unchanged contents", async () => {
    await fc.assert(
      fc.asyncProperty(
        seedNumbers(60),
        fc.integer({ min: 1, max: 100 }),
        async (numbers, limit) => {
          const seeds = numbers.map(seedAt)
          const expected = [...seeds].sort((a, b) => numberOf(a.id) - numberOf(b.id))
          await start({ messages: seeds })
          try {
            let collected: ConversationMessage[] = []
            let before = ""
            for (let step = 0; step <= expected.length; step++) {
              const page = (await list(`?limit=${limit}${before}`)).page
              if (!page) throw new Error("the page did not parse")
              const missing = expected.length - collected.length
              expect(page.messages).toHaveLength(Math.min(limit, missing))
              collected = [...page.messages, ...collected]
              expect(page.hasOlder).toBe(collected.length < expected.length)
              if (!page.hasOlder) break
              before = `&before=${collected[0]?.id}`
            }
            expect(collected).toEqual(expected)
          } finally {
            await mock.stop()
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)

  test("a limit outside 1 to 100 or a malformed query is 400", async () => {
    await start({ messages: [message(1)] })
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=-1",
      "?limit=abc",
      "?limit=",
      "?limit=1.5",
      "?before=R1",
      "?before=M0",
      "?before=",
    ]) {
      expect({ query, status: (await list(query)).status }).toEqual({ query, status: 400 })
    }
  })
})

describe("postMessage", () => {
  test("a post is stored queued with the next message id and the newest round, and replies accepted", async () => {
    await start({
      messages: [message(7)],
      pageState: {
        drafts: [],
        agentNotes: [],
        rounds: [roundAt("R11", orphanedState), roundAt("R12", claimedState)],
      },
    })
    const result = await posted("chat-one", "Make it smaller.")
    expect(result).toMatchObject({
      outcome: "accepted",
      message: {
        id: "M8",
        roundId: "R12",
        text: "Make it smaller.",
        author: { kind: "page", idempotencyKey: "chat-one", delivery: { status: "queued" } },
      },
    })
    expect(messageIds(mock.messages())).toEqual(["M7", "M8"])
    expect(messageIds((await list()).page?.messages ?? [])).toEqual(["M7", "M8"])
  })

  test("a post references the newest held round by number, whatever order the rounds were seeded in", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 8 }),
        async (numbers) => {
          const rounds = numbers.map((n) => roundAt(`R${n}`, queuedState))
          await start({ pageState: { drafts: [], agentNotes: [], rounds } })
          try {
            expect(await posted("chat-one")).toMatchObject({
              outcome: "accepted",
              message: { roundId: `R${Math.max(...numbers)}` },
            })
          } finally {
            await mock.stop()
          }
        },
      ),
      {
        numRuns: 20,
        examples: [[[11, 12]], [[12, 11]], [[10, 9]], [[9, 10, 2]], [[2, 100, 30]]],
      },
    )
  }, 60_000)

  test("the next message id is one past the greatest seeded id, whatever order they were seeded in", async () => {
    await fc.assert(
      fc.asyncProperty(seedNumbers(20), async (numbers) => {
        await start({ messages: numbers.map(seedAt) })
        try {
          const next = Math.max(0, ...numbers) + 1
          expect(await posted("chat-one")).toMatchObject({
            outcome: "accepted",
            message: { id: `M${next}` },
          })
          expect(await posted("chat-two")).toMatchObject({ message: { id: `M${next + 1}` } })
        } finally {
          await mock.stop()
        }
      }),
      { numRuns: 20, examples: [[[3, 9, 5]], [[9, 3]], [[100, 99, 2]], [[]]] },
    )
  }, 60_000)

  test("a post with no round held has no round", async () => {
    await start()
    expect(await posted("chat-one")).toMatchObject({
      outcome: "accepted",
      message: { id: "M1", roundId: null },
    })
  })

  test("a repeated post with one key stores and returns one message", async () => {
    await start()
    const first = await posted("chat-same", "First text.")
    const second = await posted("chat-same", "Different text.")
    expect(second).toEqual(first)
    expect(mock.messages()).toHaveLength(1)
    expect(mock.messages()[0]?.text).toBe("First text.")
    const other = await posted("chat-other", "Second.")
    expect(other).toMatchObject({ outcome: "accepted", message: { id: "M2" } })
    expect(mock.messages()).toHaveLength(2)
  })

  test("a post whose key belongs to a seeded page message returns that message and stores nothing", async () => {
    const seeds = [seedAt(2), seedAt(3), seedAt(4), seedAt(1), seedAt(5)]
    await start({ messages: seeds })
    for (const seed of seeds.filter((item) => item.author.kind === "page")) {
      if (seed.author.kind !== "page") throw new Error("seed is not a page message")
      expect(await posted(seed.author.idempotencyKey, "Different text.")).toEqual({
        outcome: "accepted",
        message: seed,
      })
    }
    expect(mock.messages()).toEqual(seeds.toSorted((a, b) => numberOf(a.id) - numberOf(b.id)))
    expect(await posted("chat-new")).toMatchObject({ message: { id: "M6" } })
  })

  test("a post stays queued until the scenario marks it delivered, which stamps the time", async () => {
    await start()
    const accepted = await posted("chat-one")
    if (accepted.outcome !== "accepted") throw new Error("post was refused")
    const { id } = accepted.message
    expect((await list()).page?.messages[0]?.author).toMatchObject({
      delivery: { status: "queued" },
    })

    const before = Date.now()
    mock.markDelivered(id)
    const after = Date.now()
    const held = (await list()).page?.messages[0]
    expect(held).toMatchObject({
      id,
      text: "Hello.",
      author: { kind: "page", idempotencyKey: "chat-one" },
    })
    const delivery = held?.author.kind === "page" ? held.author.delivery : null
    if (delivery?.status !== "delivered") throw new Error("message was not delivered")
    expect(Date.parse(delivery.at)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(delivery.at)).toBeLessThanOrEqual(after)
    expect(mock.messages()).toHaveLength(1)

    expect(await posted("chat-one")).toMatchObject({
      outcome: "accepted",
      message: { id, author: { delivery: { status: "delivered" } } },
    })
  })

  test("markDelivered refuses an unknown id, an agent message and an already delivered one", async () => {
    await start({ messages: [message(1)] })
    const accepted = await posted("chat-one")
    if (accepted.outcome !== "accepted") throw new Error("post was refused")
    expect(() => mock.markDelivered("M99" as never)).toThrow()
    expect(() => mock.markDelivered("M1" as never)).toThrow()
    mock.markDelivered(accepted.message.id)
    expect(() => mock.markDelivered(accepted.message.id)).toThrow()
  })

  test("pushMessage upserts by id, so a failed delivery replaces the queued one", async () => {
    await start()
    const accepted = await posted("chat-one")
    if (accepted.outcome !== "accepted") throw new Error("post was refused")
    mock.pushMessage({
      ...accepted.message,
      author: {
        kind: "page",
        idempotencyKey: "chat-one",
        delivery: { status: "failed", reason: "session-gone" },
      },
    })
    expect(mock.messages()).toHaveLength(1)
    expect(mock.messages()[0]?.author).toMatchObject({ delivery: { status: "failed" } })
    mock.pushMessage(message(40))
    expect(messageIds(mock.messages())).toEqual([accepted.message.id, "M40"])
    expect(await posted("chat-two")).toMatchObject({ message: { id: "M41" } })
  })

  test("pushMessage stores with no socket open, so a later list finds it", async () => {
    await start()
    mock.pushMessage(message(3))
    expect(messageIds((await list()).page?.messages ?? [])).toEqual(["M3"])
  })

  test("each refusal reason follows the producer's order and carries the chat setting and pairing", async () => {
    const chatOff = ChatSetting.parse({ enabled: false, defaultEnabled: false, reachable: false })
    const unreachable = ChatSetting.parse({ enabled: true, defaultEnabled: true, reachable: false })
    const stale = PAIRING.generation + 1
    const cases = [
      {
        name: "no pairing beats everything",
        pairing: null,
        chat: chatOff,
        generation: stale,
        reason: "no-pairing",
      },
      {
        name: "stale generation beats a gone session",
        pairing: GONE,
        chat: chatOff,
        generation: stale,
        reason: "stale-generation",
      },
      {
        name: "a gone session beats chat off",
        pairing: GONE,
        chat: chatOff,
        generation: GONE.generation,
        reason: "session-gone",
      },
      {
        name: "chat off beats unreachable",
        pairing: PAIRING,
        chat: chatOff,
        generation: PAIRING.generation,
        reason: "chat-off",
      },
      {
        name: "unreachable",
        pairing: PAIRING,
        chat: unreachable,
        generation: PAIRING.generation,
        reason: "unreachable",
      },
    ] as const
    for (const { name, pairing, chat, generation, reason } of cases) {
      await start({ pairing, chat })
      const result = await posted(`chat-${reason}`, "Hello.", generation)
      expect({ name, result }).toEqual({
        name,
        result: { outcome: "refused", reason, chat, pairing },
      })
      expect(mock.messages()).toEqual([])
      await mock.stop()
    }
  })

  test("an enabled, reachable chat on a live pairing at the current generation is accepted", async () => {
    await start({ chat: CHAT_ON })
    expect((await posted("chat-one")).outcome).toBe("accepted")
  })

  test("a stored message is returned even when the chat has since been refused", async () => {
    await start()
    const first = await posted("chat-one")
    mock.setChat({ enabled: false, defaultEnabled: true, reachable: false })
    expect(await posted("chat-one")).toEqual(first)
    expect(mock.messages()).toHaveLength(1)
  })

  test("every refusal carries the chat and pairing as they are now, and an injected refusal wins once", async () => {
    await start()
    const settings = fc.record({
      enabled: fc.boolean(),
      defaultEnabled: fc.boolean(),
      reachable: fc.boolean(),
    })
    let sequence = 0
    await fc.assert(
      fc.asyncProperty(
        settings,
        fc.constantFrom(null, PAIRING, GONE),
        fc.constantFrom(-1, 0, 1),
        fc.boolean(),
        async (setting, pairing, offset, inject) => {
          const chat = ChatSetting.parse(setting)
          mock.setChat(chat)
          mock.setPairing(pairing)
          const generation = Math.max(0, (pairing?.generation ?? PAIRING.generation) + offset)
          const mayAccept =
            pairing !== null &&
            generation === pairing.generation &&
            pairing.state.status !== "gone" &&
            chat.enabled &&
            chat.reachable

          if (inject) {
            mock.failNextPost({ outcome: "refused", reason: "unreachable" })
            expect(await posted(`chat-key-${++sequence}`, "Hello.", generation)).toEqual({
              outcome: "refused",
              reason: "unreachable",
              chat,
              pairing,
            })
          }
          const outcome = await posted(`chat-key-${++sequence}`, "Hello.", generation)
          expect(outcome.outcome).toBe(mayAccept ? "accepted" : "refused")
          if (outcome.outcome === "refused") {
            expect(outcome.chat).toEqual(chat)
            expect(outcome.pairing).toEqual(pairing)
          }
        },
      ),
      { numRuns: 150 },
    )
  }, 60_000)

  test("an injected refusal wins over an ordinary one and then clears", async () => {
    await start({ chat: { enabled: false, defaultEnabled: false, reachable: false } })
    mock.failNextPost({ outcome: "refused", reason: "unreachable" })
    expect(await posted("chat-one")).toMatchObject({ outcome: "refused", reason: "unreachable" })
    expect(await posted("chat-two")).toMatchObject({ outcome: "refused", reason: "chat-off" })
    expect(mock.messages()).toEqual([])
  })

  test("failNextPost refuses exactly one new post with the current chat and pairing, then clears", async () => {
    await start()
    const first = await posted("chat-kept")
    mock.failNextPost({ outcome: "refused", reason: "unreachable" })

    expect(await posted("chat-kept")).toEqual(first)
    const refused = await posted("chat-failed")
    expect(refused).toEqual({
      outcome: "refused",
      reason: "unreachable",
      chat: CHAT_ON,
      pairing: PAIRING,
    })
    expect(mock.messages()).toHaveLength(1)

    expect(await posted("chat-failed")).toMatchObject({
      outcome: "accepted",
      message: { author: { idempotencyKey: "chat-failed" } },
    })
    expect(mock.messages()).toHaveLength(2)
  })

  test("a post whose body does not parse is 400 and stores nothing", async () => {
    await start()
    const bodies = [
      {},
      { idempotencyKey: "chat-one", generation: 2 },
      { idempotencyKey: "chat-one", generation: 2, text: "" },
      { idempotencyKey: "chat-one", generation: 2, text: "x".repeat(MESSAGE_MAX_CHARS + 1) },
      { idempotencyKey: "chat-one", generation: -1, text: "Hello." },
    ]
    for (const body of bodies) {
      const response = await call("POST", R.postMessage.path, body)
      expect(response.status).toBe(400)
    }
    const raw = await mock.app.request(mock.pageUrl(R.postMessage.path), {
      method: "POST",
      headers: { [TOKEN_HEADER]: mock.token, origin: mock.origin },
      body: "not json",
    })
    expect(raw.status).toBe(400)
    expect(mock.messages()).toEqual([])
    const limit = await posted("chat-at-cap", "x".repeat(MESSAGE_MAX_CHARS))
    expect(limit.outcome).toBe("accepted")
  })

  test("holdPosts keeps a post pending until released, and a post after the release is not held", async () => {
    await start()
    const release = mock.holdPosts()
    let settled = false
    const pending = post("chat-held").then((response) => {
      settled = true
      return response
    })
    await call("GET", R.getChat.path)
    await call("GET", R.listMessages.path)
    expect(settled).toBe(false)
    expect(mock.messages()).toEqual([])

    release()
    const response = await pending
    expect(PostMessageResult.parse(await response.json())).toMatchObject({ outcome: "accepted" })
    expect(mock.messages()).toHaveLength(1)

    release()
    expect((await posted("chat-after")).outcome).toBe("accepted")
  })

  test("held posts with one key store one message once released", async () => {
    await start()
    const release = mock.holdPosts()
    const pending = Promise.all([post("chat-same"), post("chat-same"), post("chat-same")])
    await call("GET", R.getChat.path)
    expect(mock.messages()).toEqual([])
    release()
    const results = await Promise.all(
      (await pending).map(async (response) => PostMessageResult.parse(await response.json())),
    )
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(mock.messages()).toHaveLength(1)
  })
})

describe("held posts", () => {
  test("a retry of a stored key and a refused post both stay pending until released", async () => {
    await start()
    const first = await posted("chat-kept")
    const release = mock.holdPosts()
    const retry = track(post("chat-kept"))
    const refused = track(post("chat-new", "Hello.", PAIRING.generation + 1))
    await idle()
    expect(retry.settled()).toBe(false)
    expect(refused.settled()).toBe(false)

    release()
    expect(await result(await retry.done)).toEqual(first)
    expect(await result(await refused.done)).toMatchObject({
      outcome: "refused",
      reason: "stale-generation",
    })
    expect(mock.messages()).toHaveLength(1)
  })

  test("a held post is processed against the chat and pairing at release, not at arrival", async () => {
    await start()
    let release = mock.holdPosts()
    const toOff = track(post("chat-one"))
    await idle()
    mock.setChat({ enabled: false, defaultEnabled: true, reachable: true })
    release()
    expect(await result(await toOff.done)).toMatchObject({
      outcome: "refused",
      reason: "chat-off",
      chat: { enabled: false },
    })

    release = mock.holdPosts()
    const toGone = track(post("chat-two"))
    await idle()
    mock.setChat(CHAT_ON)
    mock.setPairing(GONE)
    release()
    expect(await result(await toGone.done)).toMatchObject({
      outcome: "refused",
      reason: "session-gone",
      pairing: GONE,
    })

    release = mock.holdPosts()
    const toAccepted = track(post("chat-three", "Hello.", PAIRING.generation))
    await idle()
    mock.setPairing(PAIRING)
    release()
    expect(await result(await toAccepted.done)).toMatchObject({ outcome: "accepted" })
    expect(mock.messages()).toHaveLength(1)
  })

  test("a post held behind a refusing state is accepted when the state recovers before release", async () => {
    await start({ chat: { enabled: false, defaultEnabled: true, reachable: true } })
    const release = mock.holdPosts()
    const pending = track(post("chat-one"))
    await idle()
    mock.setChat(CHAT_ON)
    release()
    expect(await result(await pending.done)).toMatchObject({ outcome: "accepted" })
  })
})

describe("chat setting", () => {
  test("the setting defaults to enabled, default-enabled and reachable, and getChat replies it", async () => {
    await start()
    expect(mock.chat()).toEqual(CHAT_ON)
    const response = await call("GET", R.getChat.path)
    expect(ChatSetting.parse(await response.json())).toEqual(CHAT_ON)
  })

  test("the chat option seeds the setting", async () => {
    const seeded = { enabled: false, defaultEnabled: false, reachable: true }
    await start({ chat: seeded })
    expect(ChatSetting.parse(await (await call("GET", R.getChat.path)).json())).toEqual(seeded)
  })

  test("setChat over HTTP stores enabled only, keeps the other fields and replies the setting", async () => {
    await start({ chat: { enabled: false, defaultEnabled: false, reachable: false } })
    const response = await call("PUT", R.setChat.path, { enabled: true })
    const expected = { enabled: true, defaultEnabled: false, reachable: false }
    expect(ChatSetting.parse(await response.json())).toEqual(expected)
    expect(mock.chat()).toEqual(expected)
    const off = await call("PUT", R.setChat.path, { enabled: false })
    expect(ChatSetting.parse(await off.json())).toEqual({ ...expected, enabled: false })
  })

  test("a toggle that does not parse is 400 and changes nothing", async () => {
    await start()
    for (const body of [{}, { enabled: "yes" }, { enabled: null }]) {
      expect((await call("PUT", R.setChat.path, body)).status).toBe(400)
    }
    expect(mock.chat()).toEqual(CHAT_ON)
  })

  test("the control setChat replaces the whole setting", async () => {
    await start()
    const next = { enabled: false, defaultEnabled: false, reachable: false }
    mock.setChat(next)
    expect(ChatSetting.parse(await (await call("GET", R.getChat.path)).json())).toEqual(next)
    expect(() => mock.setChat({ enabled: "yes" } as never)).toThrow()
  })
})

describe("sendNow", () => {
  test("a queued round is marked sent-now once, and a second call keeps the first time", async () => {
    await start({
      pageState: { drafts: [], agentNotes: [], rounds: [roundAt("R5", queuedState)] },
    })
    const firstAt = new Date("2026-10-10T09:00:00.000Z")
    try {
      setSystemTime(firstAt)
      const first = await nudged("R5")
      expect(first).toMatchObject({
        outcome: "accepted",
        round: { id: "R5", state: { stage: "queued", sendNowAt: firstAt.toISOString() } },
      })
      if (first.outcome !== "accepted") throw new Error("send now was refused")
      expect(mock.rounds()).toEqual([first.round])

      setSystemTime(new Date("2026-10-10T09:05:00.000Z"))
      expect(await nudged("R5")).toEqual(first)
      expect(mock.rounds()).toEqual([first.round])
    } finally {
      setSystemTime()
    }
  })

  test("a queued round that already has sendNowAt keeps it", async () => {
    const stamp = "2026-10-09T18:35:00.000Z"
    await start({
      pageState: {
        drafts: [],
        agentNotes: [],
        rounds: [roundAt("R5", { ...queuedState, sendNowAt: stamp })],
      },
    })
    const result = await nudged("R5")
    expect(result).toMatchObject({ outcome: "accepted", round: { state: { sendNowAt: stamp } } })
  })

  test("an announced or claimed round is refused as not waiting and left unchanged", async () => {
    const announced = roundAt("R5", announcedState)
    const claimed = roundAt("R6", claimedState)
    await start({ pageState: { drafts: [], agentNotes: [], rounds: [announced, claimed] } })
    expect(await nudged("R5")).toEqual({
      outcome: "refused",
      reason: "not-waiting",
      round: announced,
    })
    expect(await nudged("R6")).toEqual({
      outcome: "refused",
      reason: "not-waiting",
      round: claimed,
    })
    expect(mock.rounds()).toEqual([announced, claimed])
  })

  test("an orphaned round, a gone pairing and no pairing are refused in that producer order", async () => {
    const orphaned = roundAt("R5", orphanedState)
    const queued = roundAt("R6", queuedState)
    const rounds = [orphaned, queued]
    await start({ pageState: { drafts: [], agentNotes: [], rounds } })
    expect(await nudged("R5")).toEqual({
      outcome: "refused",
      reason: "session-gone",
      round: orphaned,
    })
    await mock.stop()

    await start({ pairing: GONE, pageState: { drafts: [], agentNotes: [], rounds } })
    expect(await nudged("R6")).toEqual({
      outcome: "refused",
      reason: "session-gone",
      round: queued,
    })
    await mock.stop()

    await start({ pairing: null, pageState: { drafts: [], agentNotes: [], rounds } })
    expect(await nudged("R5")).toEqual({
      outcome: "refused",
      reason: "no-pairing",
      round: orphaned,
    })
    expect(await nudged("R6")).toEqual({ outcome: "refused", reason: "no-pairing", round: queued })
    expect(mock.rounds()).toEqual(rounds)
  })

  test("refusals follow the producer's order for every pairing and round stage", async () => {
    const rounds = {
      queued: roundAt("R1", queuedState),
      announced: roundAt("R2", announcedState),
      claimed: roundAt("R3", claimedState),
      orphaned: roundAt("R4", orphanedState),
    }
    const pairings = { absent: null, live: PAIRING, gone: GONE } as const
    const expected = {
      absent: {
        queued: "no-pairing",
        announced: "no-pairing",
        claimed: "no-pairing",
        orphaned: "no-pairing",
      },
      live: {
        queued: "accepted",
        announced: "not-waiting",
        claimed: "not-waiting",
        orphaned: "session-gone",
      },
      gone: {
        queued: "session-gone",
        announced: "session-gone",
        claimed: "session-gone",
        orphaned: "session-gone",
      },
    } as const
    for (const [pairingName, pairing] of Object.entries(pairings)) {
      await start({
        pairing,
        pageState: { drafts: [], agentNotes: [], rounds: Object.values(rounds) },
      })
      for (const [stage, round] of Object.entries(rounds)) {
        const reason = expected[pairingName as keyof typeof expected][stage as keyof typeof rounds]
        const outcome = await nudged(round.id)
        expect({
          pairingName,
          stage,
          outcome: outcome.outcome === "accepted" ? "accepted" : outcome.reason,
        }).toEqual({
          pairingName,
          stage,
          outcome: reason,
        })
        if (outcome.outcome === "refused") expect(outcome.round).toEqual(round)
      }
      await mock.stop()
    }
  })

  test("an injected failure wins over every ordinary refusal and an accepted call, once", async () => {
    const queued = roundAt("R1", queuedState)
    const announced = roundAt("R2", announcedState)
    const orphaned = roundAt("R3", orphanedState)
    await start({
      pairing: null,
      pageState: { drafts: [], agentNotes: [], rounds: [queued, announced, orphaned] },
    })
    mock.failNextSendNow("not-waiting")
    expect(await nudged("R3")).toEqual({
      outcome: "refused",
      reason: "not-waiting",
      round: orphaned,
    })
    expect(await nudged("R3")).toEqual({
      outcome: "refused",
      reason: "no-pairing",
      round: orphaned,
    })
    await mock.stop()

    await start({
      pairing: GONE,
      pageState: { drafts: [], agentNotes: [], rounds: [queued, announced, orphaned] },
    })
    mock.failNextSendNow("no-pairing")
    expect(await nudged("R2")).toEqual({
      outcome: "refused",
      reason: "no-pairing",
      round: announced,
    })
    expect(await nudged("R2")).toEqual({
      outcome: "refused",
      reason: "session-gone",
      round: announced,
    })
    await mock.stop()

    await start({ pageState: { drafts: [], agentNotes: [], rounds: [queued] } })
    mock.failNextSendNow("session-gone")
    expect(await nudged("R1")).toEqual({
      outcome: "refused",
      reason: "session-gone",
      round: queued,
    })
    expect(mock.rounds()).toEqual([queued])
  })

  test("an unknown round is 404, including when a failure is queued, which it does not consume", async () => {
    const queued = roundAt("R5", queuedState)
    await start({ pageState: { drafts: [], agentNotes: [], rounds: [queued] } })
    mock.failNextSendNow("not-waiting")
    expect((await sendNow("R999")).status).toBe(404)
    expect(await nudged("R5")).toEqual({ outcome: "refused", reason: "not-waiting", round: queued })
  })

  test("failNextSendNow refuses exactly the next call with that reason and the held round", async () => {
    const queued = roundAt("R5", queuedState)
    await start({ pageState: { drafts: [], agentNotes: [], rounds: [queued] } })
    mock.failNextSendNow("session-gone")
    expect(await nudged("R5")).toEqual({
      outcome: "refused",
      reason: "session-gone",
      round: queued,
    })
    expect(mock.rounds()).toEqual([queued])
    expect((await nudged("R5")).outcome).toBe("accepted")
  })

  test("requeuing on attach drops sendNowAt", async () => {
    await start({
      liveSessions: [LIVE_SESSION],
      pageState: { drafts: [], agentNotes: [], rounds: [roundAt("R5", queuedState)] },
    })
    expect((await nudged("R5")).outcome).toBe("accepted")
    const attach = await call("POST", R.attach.path, { owner: LIVE_SESSION.owner })
    expect(await attach.json()).toMatchObject({ outcome: "accepted", requeued: ["R5"] })
    const [round] = mock.rounds()
    expect(round?.state.stage).toBe("queued")
    expect(round?.state).not.toHaveProperty("sendNowAt")
  })
})

describe("live events", () => {
  test("posting, delivering, pushing, chat changes and send now each reach a connected socket", async () => {
    await start({
      pageState: { drafts: [], agentNotes: [], rounds: [roundAt("R5", queuedState)] },
    })
    const { socket, received, opened } = connect()
    try {
      await opened
      const accepted = await posted("chat-one")
      if (accepted.outcome !== "accepted") throw new Error("post was refused")
      await waitFor("the queued message event", async () => (received.length >= 1 ? true : null))
      expect(received[0]).toEqual({ type: "message", message: accepted.message })

      mock.markDelivered(accepted.message.id)
      await waitFor("the delivered message event", async () => (received.length >= 2 ? true : null))
      expect(received[1]).toMatchObject({
        type: "message",
        message: { id: accepted.message.id, author: { delivery: { status: "delivered" } } },
      })

      mock.pushMessage(message(50))
      await waitFor("the pushed message event", async () => (received.length >= 3 ? true : null))
      expect(received[2]).toEqual({ type: "message", message: message(50) })

      await call("PUT", R.setChat.path, { enabled: false })
      await waitFor("the chat event from HTTP", async () => (received.length >= 4 ? true : null))
      expect(received[3]).toEqual({
        type: "chat",
        chat: { enabled: false, defaultEnabled: true, reachable: true },
      })

      mock.setChat(CHAT_ON)
      await waitFor("the chat event from the control", async () =>
        received.length >= 5 ? true : null,
      )
      expect(received[4]).toEqual({ type: "chat", chat: CHAT_ON })

      const nudge = await nudged("R5")
      if (nudge.outcome !== "accepted") throw new Error("send now was refused")
      await waitFor("the round event", async () => (received.length >= 6 ? true : null))
      expect(received[5]).toEqual({ type: "round", round: nudge.round })
    } finally {
      socket.close()
    }
  })

  test("an accepted post is written to the live socket before its reply is", async () => {
    await start()
    const order: string[] = []
    let handshaken = false
    const host = new URL(mock.origin).host
    const live = await rawConnect(
      [
        `GET ${LIVE_PATH} HTTP/1.1`,
        `Host: ${host}`,
        `Origin: ${mock.origin}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${liveSubprotocols(mock.token).join(", ")}`,
      ],
      "",
      (chunk) => {
        if (handshaken) order.push(chunk.includes('"type":"message"') ? "event" : "other")
        else handshaken = chunk.startsWith("HTTP/1.1 101")
      },
    )
    try {
      await waitFor("the live upgrade", async () => (handshaken ? true : null))
      for (let n = 1; n <= 5; n++) {
        order.length = 0
        const body = JSON.stringify({
          idempotencyKey: `chat-key-${n}`,
          generation: PAIRING.generation,
          text: "Hello.",
        })
        const request = await rawConnect(
          [
            `POST ${R.postMessage.path} HTTP/1.1`,
            `Host: ${host}`,
            `Origin: ${mock.origin}`,
            `${TOKEN_HEADER}: ${mock.token}`,
            "Content-Type: application/json",
            `Content-Length: ${body.length}`,
            "Connection: close",
          ],
          body,
          (chunk) => {
            if (!order.includes("reply") && chunk.startsWith("HTTP/1.1 200")) order.push("reply")
          },
        )
        try {
          await waitFor("the event and the reply", async () => (order.length >= 2 ? true : null))
        } finally {
          request.end()
        }
        expect(order).toEqual(["event", "reply"])
      }
    } finally {
      live.end()
    }
  })

  test("a refused post and a refused send now push nothing", async () => {
    const announced = roundAt("R5", announcedState)
    await start({
      chat: { enabled: false, defaultEnabled: true, reachable: true },
      pageState: { drafts: [], agentNotes: [], rounds: [announced] },
    })
    const { socket, received, opened } = connect()
    try {
      await opened
      expect((await posted("chat-one")).outcome).toBe("refused")
      expect((await nudged("R5")).outcome).toBe("refused")
      mock.push({ type: "reload" })
      await waitFor("the reload marker", async () => (received.length >= 1 ? true : null))
      expect(received).toEqual([{ type: "reload" }])
    } finally {
      socket.close()
    }
  })

  test("dropSockets closes every open socket with 1012 and leaves the server answering", async () => {
    await start()
    const one = connect()
    const two = connect()
    try {
      await Promise.all([one.opened, two.opened])
      mock.dropSockets()
      expect(await Promise.all([one.closed, two.closed])).toEqual([1012, 1012])

      const again = connect()
      try {
        await again.opened
        mock.pushMessage(message(1))
        await waitFor("the event on the new socket", async () =>
          again.received.length > 0 ? true : null,
        )
      } finally {
        again.socket.close()
      }
      expect(ChatSetting.parse(await (await call("GET", R.getChat.path)).json())).toEqual(CHAT_ON)
    } finally {
      one.socket.close()
      two.socket.close()
    }
  })

  test("dropSockets with no socket open does nothing", async () => {
    await start()
    mock.dropSockets()
    expect((await list()).status).toBe(200)
  })
})

describe("access", () => {
  test("every conversation route with an omitted, empty or wrong page token is 401 and a foreign Origin is 403", async () => {
    await start({
      pageState: { drafts: [], agentNotes: [], rounds: [roundAt("R5", queuedState)] },
    })
    const routes = [
      ["GET", R.listMessages.path, undefined],
      ["POST", R.postMessage.path, { idempotencyKey: "chat-one", generation: 2, text: "Hello." }],
      ["GET", R.getChat.path, undefined],
      ["PUT", R.setChat.path, { enabled: false }],
      ["POST", R.sendNow.path.replace(":roundId", "R5"), undefined],
    ] as const
    for (const [method, path, body] of routes) {
      const omitted = await call(method, path, body, { [TOKEN_HEADER]: undefined })
      expect({ path, status: omitted.status }).toEqual({ path, status: 401 })
      const empty = await call(method, path, body, { [TOKEN_HEADER]: "" })
      expect({ path, status: empty.status }).toEqual({ path, status: 401 })
      const wrong = await call(method, path, body, { [TOKEN_HEADER]: `${mock.token}x` })
      expect({ path, status: wrong.status }).toEqual({ path, status: 401 })
      const foreign = await call(method, path, body, { origin: "http://elsewhere.localhost:1" })
      expect({ path, status: foreign.status }).toEqual({ path, status: 403 })
    }
    expect(mock.messages()).toEqual([])
    expect(mock.chat()).toEqual(CHAT_ON)
    expect(mock.rounds().map((round) => round.state)).toEqual([
      expect.not.objectContaining({ sendNowAt: expect.anything() }),
    ])
  })
})
