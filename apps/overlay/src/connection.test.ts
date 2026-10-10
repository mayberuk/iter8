import { afterEach, describe, expect, jest, test } from "bun:test"
import {
  DraftBody,
  HelloResult,
  LIVE_PATH,
  liveSubprotocols,
  Note,
  NoteId,
  OVERLAY_ROUTES,
  OverlayBoot,
  OverlayPrefs,
  OwnerId,
  PROTOCOL_VERSION,
  Screenshot,
  type ScreenshotRef,
  SendRequest,
  ServerMessage,
  SourceLead,
  TOKEN_HEADER,
} from "@iter8/protocol"
import fc from "fast-check"
import attachFixture from "../../../packages/protocol/fixtures/AttachResult.json"
import draftFixture from "../../../packages/protocol/fixtures/DraftBody.json"
import helloFixture from "../../../packages/protocol/fixtures/HelloResult.json"
import refusedFixture from "../../../packages/protocol/fixtures/HelloResult.refused.json"
import sessionsFixture from "../../../packages/protocol/fixtures/LiveSessionList.json"
import noteFixture from "../../../packages/protocol/fixtures/Note.json"
import okFixture from "../../../packages/protocol/fixtures/Ok.json"
import bootFixture from "../../../packages/protocol/fixtures/OverlayBoot.json"
import prefsFixture from "../../../packages/protocol/fixtures/OverlayPrefs.json"
import resolvedFixture from "../../../packages/protocol/fixtures/ResolvedSourceLead.json"
import screenshotFixture from "../../../packages/protocol/fixtures/Screenshot.json"
import sendRequestFixture from "../../../packages/protocol/fixtures/SendRequest.json"
import sendFixture from "../../../packages/protocol/fixtures/SendResult.json"
import drainingFixture from "../../../packages/protocol/fixtures/ServerMessage.draining.json"
import reloadFixture from "../../../packages/protocol/fixtures/ServerMessage.reload.json"
import leadFixture from "../../../packages/protocol/fixtures/SourceLead.json"
import { type Connection, type ConnectionEvent, createConnection } from "./connection"

const boot = OverlayBoot.parse(bootFixture)
const draft = DraftBody.parse(draftFixture)
const note = Note.parse(noteFixture)
const prefs = OverlayPrefs.parse(prefsFixture)
const screenshot = Screenshot.parse(screenshotFixture)
const sendRequest = SendRequest.parse(sendRequestFixture)
const lead = SourceLead.parse(leadFixture)
const owner = OwnerId.parse("own_9pz2mr4c")

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeSockets() {
  return class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    closed = false

    constructor(
      readonly url: string,
      readonly protocols: string | string[] | undefined,
    ) {
      FakeWebSocket.instances.push(this)
    }

    receive(data: unknown) {
      this.onmessage?.(new MessageEvent("message", { data }))
    }

    close() {
      if (this.closed) return
      this.closed = true
      this.onclose?.(new Event("close") as CloseEvent)
    }
  }
}

function fixtureResponse(path: string, init: RequestInit): Response {
  if (path === "/__iter8/hello") return Response.json(helloFixture)
  if (
    path === "/__iter8/drafts" ||
    (path.startsWith("/__iter8/drafts/") && init.method === "PUT")
  ) {
    return Response.json(noteFixture)
  }
  if (path.startsWith("/__iter8/drafts/") && init.method === "DELETE") {
    return Response.json(okFixture)
  }
  if (path === "/__iter8/rounds") return Response.json(sendFixture)
  if (path === "/__iter8/screenshots") return Response.json(screenshotFixture)
  if (path.startsWith("/__iter8/screenshots/")) {
    return new Response(new Blob(["png bytes"], { type: "image/png" }))
  }
  if (path === "/__iter8/symbolicate") return Response.json(resolvedFixture)
  if (path === "/__iter8/sessions") return Response.json(sessionsFixture)
  if (path === "/__iter8/attach") return Response.json(attachFixture)
  if (path === "/__iter8/prefs") return Response.json(prefsFixture)
  throw new Error(`Unexpected fake fetch: ${init.method} ${path}`)
}

const routes: {
  key: keyof typeof OVERLAY_ROUTES
  path: string
  invoke: (connection: Connection) => unknown
}[] = [
  { key: "hello", path: "/__iter8/hello", invoke: (c) => c.start() },
  { key: "createDraft", path: "/__iter8/drafts", invoke: (c) => c.createDraft(draft) },
  { key: "putDraft", path: "/__iter8/drafts/N12", invoke: (c) => c.putDraft(note.id, draft) },
  { key: "deleteDraft", path: "/__iter8/drafts/N12", invoke: (c) => c.deleteDraft(note.id) },
  { key: "send", path: "/__iter8/rounds", invoke: (c) => c.send(sendRequest) },
  {
    key: "uploadScreenshot",
    path: "/__iter8/screenshots",
    invoke: (c) => c.uploadScreenshot(new Blob(["png bytes"], { type: "image/png" })),
  },
  {
    key: "getScreenshot",
    path: "/__iter8/screenshots/shot_8f2c1a9e",
    invoke: (c) => c.fetchScreenshot(screenshot.ref),
  },
  { key: "symbolicate", path: "/__iter8/symbolicate", invoke: (c) => c.symbolicate(lead) },
  { key: "listSessions", path: "/__iter8/sessions", invoke: (c) => c.listSessions() },
  { key: "attach", path: "/__iter8/attach", invoke: (c) => c.attach(owner) },
  { key: "savePrefs", path: "/__iter8/prefs", invoke: (c) => c.savePrefs(prefs) },
]

describe("service connection", () => {
  const connections = new Set<Connection>()

  afterEach(() => {
    for (const connection of connections) connection.close()
    connections.clear()
    jest.useRealTimers()
  })

  function setup(
    respond: (path: string, init: RequestInit) => Response | Promise<Response> = fixtureResponse,
    secure = false,
  ) {
    const calls: { path: string; init: RequestInit }[] = []
    const messages: ServerMessage[] = []
    const events: ConnectionEvent[] = []
    const Socket = fakeSockets()
    const fakeFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
        const path = String(input)
        calls.push({ path, init })
        return respond(path, init)
      },
      { preconnect() {} },
    )
    const connection = createConnection({
      boot,
      host: "larkspur.localhost:3990",
      secure,
      fetch: fakeFetch,
      WebSocket: Socket as unknown as typeof WebSocket,
      onMessage: (message) => messages.push(message),
      onEvent: (event) => events.push(event),
    })
    connections.add(connection)
    return { connection, calls, messages, events, Socket }
  }

  async function microtasks() {
    for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  }

  for (const { key, path, invoke } of routes) {
    test(`${key} uses its route method, relative path and page token`, async () => {
      const { connection, calls } = setup()
      await invoke(connection)
      await connection.flush()
      expect(calls).toHaveLength(1)
      expect(calls[0]?.path).toBe(path)
      expect(calls[0]?.init.method).toBe(OVERLAY_ROUTES[key].method)
      expect(new Headers(calls[0]?.init.headers).get(TOKEN_HEADER)).toBe(boot.token)
    })

    test(`${key} rejects an HTTP failure with a plain route/status Error`, async () => {
      const { connection, calls } = setup(() => new Response("unavailable", { status: 503 }))
      const result = async () => {
        await invoke(connection)
        await connection.flush()
      }
      try {
        await result()
        throw new Error("Expected the route to fail")
      } catch (error) {
        expect(error?.constructor).toBe(Error)
        expect((error as Error).message).toContain(`${key} status 503`)
      }
      expect(calls).toHaveLength(1)
    })

    if (key !== "getScreenshot") {
      test(`${key} rejects a malformed JSON response with the route and HTTP status`, async () => {
        const { connection } = setup(() => Response.json({ unexpected: true }))
        await expect(
          (async () => {
            await invoke(connection)
            await connection.flush()
          })(),
        ).rejects.toThrow(`${key} status 200: invalid response`)
      })
    }
  }

  test("hello sends the current protocol version and page/machine identity", async () => {
    const { connection, calls, events } = setup()
    await connection.start()
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      pageId: boot.pageId,
      machineId: boot.machineId,
    })
    expect(events).toEqual([{ kind: "ready", hello: HelloResult.options[0].parse(helloFixture) }])
  })

  for (const secure of [false, true]) {
    test(`accepted hello offers exactly the live token subprotocols over ${secure ? "wss" : "ws"}`, async () => {
      const { connection, Socket } = setup(fixtureResponse, secure)
      await connection.start()
      expect(Socket.instances).toHaveLength(1)
      expect(Socket.instances[0]?.url).toBe(
        `${secure ? "wss" : "ws"}://larkspur.localhost:3990${LIVE_PATH}`,
      )
      expect(Socket.instances[0]?.protocols).toEqual(liveSubprotocols(boot.token))
    })
  }

  for (const reason of [
    "version-mismatch",
    "wrong-machine",
    "unknown-page",
    "bad-token",
  ] as const) {
    test(`hello reports ${reason} without opening a socket`, async () => {
      const hello = HelloResult.options[1].parse({ ...refusedFixture, reason })
      const { connection, events, Socket } = setup(() =>
        Response.json(hello, { status: reason === "bad-token" ? 401 : 200 }),
      )
      await connection.start()
      expect(events).toEqual([{ kind: "refused", hello }])
      expect(Socket.instances).toHaveLength(0)
    })
  }

  test("a network failure reports unreachable without opening a socket or retrying HTTP", async () => {
    const { connection, events, Socket, calls } = setup(() => {
      throw new TypeError("fetch failed")
    })
    await connection.start()
    expect(events).toEqual([{ kind: "unreachable" }])
    expect(Socket.instances).toHaveLength(0)
    expect(calls).toHaveLength(1)
  })

  test("401 hello still validates the HelloResult response", async () => {
    const { connection, events } = setup(() => Response.json({}, { status: 401 }))
    await expect(connection.start()).rejects.toThrow("hello status 401: invalid response")
    expect(events).toEqual([])
  })

  test("invalid JSON is a plain Error naming the route and status", async () => {
    const { connection } = setup(() => new Response("not JSON", { status: 200 }))
    await expect(connection.listSessions()).rejects.toThrow(
      "listSessions status 200: invalid response",
    )
  })

  test("request schemas strip extra fields before sending", async () => {
    const { connection, calls } = setup()
    const body = { ...draft, untrusted: "must not cross the boundary" }
    await connection.createDraft(body)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(draft)
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("application/json")
  })

  test("invalid JSON requests fail before fetching", async () => {
    const { connection, calls } = setup()
    const body = { ...draft, intent: "invalid" } as unknown as DraftBody
    await expect(connection.createDraft(body)).rejects.toThrow(
      "createDraft status 0: invalid request",
    )
    expect(() => connection.putDraft(note.id, body)).toThrow("putDraft status 0: invalid request")
    expect(() =>
      connection.savePrefs({ ...prefs, theme: "invalid" } as unknown as OverlayPrefs),
    ).toThrow("savePrefs status 0: invalid request")
    expect(calls).toHaveLength(0)
  })

  test("path parameters are encoded as a single segment", async () => {
    const { connection, calls } = setup((path, init) => {
      if (init.method === "DELETE") return Response.json(okFixture)
      if (path.startsWith("/__iter8/screenshots/")) return new Response("png bytes")
      return Response.json(noteFixture)
    })
    connection.putDraft("N12 /?#" as NoteId, draft)
    await connection.flush()
    await connection.deleteDraft("N12 /?#" as NoteId)
    await connection.fetchScreenshot("shot /?#" as ScreenshotRef)
    expect(calls.map((call) => call.path)).toEqual([
      "/__iter8/drafts/N12%20%2F%3F%23",
      "/__iter8/drafts/N12%20%2F%3F%23",
      "/__iter8/screenshots/shot%20%2F%3F%23",
    ])
  })

  test("uploads PNG bytes and fetches screenshots as a Blob", async () => {
    const { connection, calls } = setup()
    const png = new Blob(["png bytes"], { type: "image/png" })
    expect(await connection.uploadScreenshot(png)).toEqual(screenshot)
    expect(calls[0]?.init.body).toBe(png)
    expect(new Headers(calls[0]?.init.headers).get("content-type")).toBe("image/png")
    const fetched = await connection.fetchScreenshot(screenshot.ref)
    expect(fetched).toBeInstanceOf(Blob)
    expect(fetched.type).toBe("image/png")
    expect(await fetched.text()).toBe("png bytes")
  })

  test("unparseable socket messages are dropped and the next valid message is delivered", async () => {
    const { connection, messages, Socket } = setup()
    await connection.start()
    const socket = Socket.instances[0]
    socket?.receive("not JSON")
    socket?.receive(JSON.stringify({ type: "not-a-message" }))
    socket?.receive(JSON.stringify({ type: "agent-note-removed", noteId: "invalid" }))
    expect(messages).toEqual([])
    socket?.receive(JSON.stringify(reloadFixture))
    expect(messages).toEqual([ServerMessage.parse(reloadFixture)])
  })

  test("draining is delivered, reported, and reconnects with a second hello after 1000 ms", async () => {
    jest.useFakeTimers()
    const { connection, messages, events, Socket, calls } = setup()
    await connection.start()
    Socket.instances[0]?.receive(JSON.stringify(drainingFixture))
    expect(messages).toEqual([ServerMessage.parse(drainingFixture)])
    expect(events.at(-1)).toEqual({ kind: "draining" })
    expect(Socket.instances[0]?.closed).toBe(true)
    jest.advanceTimersByTime(999)
    await microtasks()
    expect(calls).toHaveLength(1)
    jest.advanceTimersByTime(1)
    await microtasks()
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.path)).toEqual(["/__iter8/hello", "/__iter8/hello"])
    expect(Socket.instances).toHaveLength(2)
    expect(events.at(-1)?.kind).toBe("ready")
  })

  test("an ordinary socket close also reconnects", async () => {
    jest.useFakeTimers()
    const { connection, Socket, calls } = setup()
    await connection.start()
    Socket.instances[0]?.close()
    jest.advanceTimersByTime(999)
    await microtasks()
    expect(calls).toHaveLength(1)
    jest.advanceTimersByTime(1)
    await microtasks()
    expect(calls.map((call) => call.path)).toEqual(["/__iter8/hello", "/__iter8/hello"])
    expect(Socket.instances).toHaveLength(2)
  })

  test("close cancels a scheduled reconnect and further starts", async () => {
    jest.useFakeTimers()
    const { connection, Socket, calls } = setup()
    await connection.start()
    Socket.instances[0]?.close()
    connection.close()
    jest.advanceTimersByTime(2000)
    await connection.start()
    expect(calls).toHaveLength(1)
    expect(Socket.instances).toHaveLength(1)
  })

  test("close shuts down an active socket without scheduling reconnect", async () => {
    jest.useFakeTimers()
    const { connection, Socket, calls } = setup()
    await connection.start()
    connection.close()
    expect(Socket.instances[0]?.closed).toBe(true)
    jest.advanceTimersByTime(2000)
    expect(calls).toHaveLength(1)
  })

  test("close while hello is pending prevents a late socket and ready event", async () => {
    const response = deferred<Response>()
    const { connection, Socket, events } = setup(() => response.promise)
    const starting = connection.start()
    connection.close()
    response.resolve(Response.json(helloFixture))
    await starting
    expect(Socket.instances).toHaveLength(0)
    expect(events).toEqual([])
  })

  test("concurrent starts share one hello and socket", async () => {
    const { connection, Socket, calls } = setup()
    await Promise.all([connection.start(), connection.start(), connection.start()])
    expect(calls).toHaveLength(1)
    expect(Socket.instances).toHaveLength(1)
  })

  test("three rapid draft updates send the first and newest body, and flush waits for both", async () => {
    const first = deferred<Response>()
    const last = deferred<Response>()
    let requests = 0
    const { connection, calls } = setup(() => (++requests === 1 ? first.promise : last.promise))
    connection.putDraft(note.id, { ...draft, body: "first" })
    connection.putDraft(note.id, { ...draft, body: "middle" })
    connection.putDraft(note.id, { ...draft, body: "newest" })
    expect(calls).toHaveLength(1)
    let flushed = false
    const flushing = connection.flush().then(() => {
      flushed = true
    })
    first.resolve(Response.json(noteFixture))
    await first.promise
    await Promise.resolve()
    expect(flushed).toBe(false)
    last.resolve(Response.json(noteFixture))
    await flushing
    expect(flushed).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => JSON.parse(String(call.init.body)).body)).toEqual([
      "first",
      "newest",
    ])
  })

  test("latest draft body wins for arbitrary updates with only one request per id in flight", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string(), { minLength: 3, maxLength: 10 }), async (bodies) => {
        const first = deferred<Response>()
        let requests = 0
        let active = 0
        let maximum = 0
        const { connection, calls } = setup(async () => {
          active++
          maximum = Math.max(maximum, active)
          const response = ++requests === 1 ? await first.promise : Response.json(noteFixture)
          active--
          return response
        })
        for (const body of bodies) connection.putDraft(note.id, { ...draft, body })
        expect(calls).toHaveLength(1)
        first.resolve(Response.json(noteFixture))
        await connection.flush()
        expect(maximum).toBe(1)
        expect(calls).toHaveLength(2)
        expect(JSON.parse(String(calls.at(-1)?.init.body)).body).toBe(bodies.at(-1))
        connection.close()
      }),
      { numRuns: 25 },
    )
  })

  test("draft ids and prefs run independently, and flush waits for every queue", async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const preference = deferred<Response>()
    const { connection, calls } = setup((path) => {
      if (path.endsWith("N12")) return first.promise
      if (path.endsWith("N13")) return second.promise
      return preference.promise
    })
    connection.putDraft(note.id, draft)
    connection.putDraft(NoteId.parse("N13"), draft)
    connection.savePrefs(prefs)
    expect(calls).toHaveLength(3)
    let flushed = false
    const flushing = connection.flush().then(() => {
      flushed = true
    })
    first.resolve(Response.json(noteFixture))
    second.resolve(Response.json(noteFixture))
    await Promise.all([first.promise, second.promise])
    expect(flushed).toBe(false)
    preference.resolve(Response.json(prefsFixture))
    await flushing
    expect(flushed).toBe(true)
  })

  test("prefs coalesce to the latest validated body", async () => {
    const first = deferred<Response>()
    let requests = 0
    const { connection, calls } = setup(() =>
      ++requests === 1 ? first.promise : Response.json(prefsFixture),
    )
    connection.savePrefs({ ...prefs, theme: "light" })
    connection.savePrefs({ ...prefs, theme: "dark" })
    connection.savePrefs({ ...prefs, theme: "auto", collapsed: true })
    expect(calls).toHaveLength(1)
    first.resolve(Response.json(prefsFixture))
    await connection.flush()
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls.at(-1)?.init.body))).toEqual({
      ...prefs,
      theme: "auto",
      collapsed: true,
    })
  })

  test("flush waits for a newer write even when the first fails, then reports its error", async () => {
    const first = deferred<Response>()
    let requests = 0
    const { connection, calls } = setup(() =>
      ++requests === 1 ? first.promise : Response.json(noteFixture),
    )
    connection.putDraft(note.id, { ...draft, body: "first" })
    connection.putDraft(note.id, { ...draft, body: "latest" })
    first.resolve(new Response("failed", { status: 500 }))
    await expect(connection.flush()).rejects.toThrow("putDraft status 500")
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls.at(-1)?.init.body)).body).toBe("latest")
    await connection.flush()
  })
})
