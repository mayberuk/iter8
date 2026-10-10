import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { Server, ServerWebSocket, TCPSocketListener } from "bun"
import { type BridgeSocketData, bridgeHandlers, upgradeBridged } from "./ws-bridge"

type UpstreamSocket = ServerWebSocket<{ target: string }>

const EARLY_TEXT_FRAMES = 20
const EARLY_BINARY = Uint8Array.from({ length: 256 }, (_, i) => 255 - i)

const stops: Array<() => void> = []

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
})

type UpstreamOptions = {
  acceptDelayMs?: number
  afterOpen?: (ws: UpstreamSocket) => void
}

function startUpstream(
  select: (offers: string[]) => string | undefined = (offers) =>
    offers.includes("vite-hmr") ? "vite-hmr" : undefined,
  { acceptDelayMs = 0, afterOpen }: UpstreamOptions = {},
) {
  const offered: string[][] = []
  const requestHeaders: Record<string, string>[] = []
  const received: Array<string | Uint8Array> = []
  const closes: number[] = []
  const sockets: UpstreamSocket[] = []
  const server = Bun.serve<{ target: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      if (acceptDelayMs > 0) await Bun.sleep(acceptDelayMs)
      const offers = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
      offered.push(offers)
      requestHeaders.push(Object.fromEntries(req.headers))
      const { pathname, search } = new URL(req.url)
      const selected = select(offers)
      const headers = new Headers(
        selected === undefined ? {} : { "Sec-WebSocket-Protocol": selected },
      )
      if (srv.upgrade(req, { headers, data: { target: pathname + search } })) return undefined
      return new Response("not a websocket", { status: 400 })
    },
    websocket: {
      open(ws) {
        sockets.push(ws)
        for (let i = 0; i < EARLY_TEXT_FRAMES; i++) ws.send(`${i} ${ws.data.target}`)
        ws.send(EARLY_BINARY)
        afterOpen?.(ws)
      },
      message(ws, message) {
        received.push(typeof message === "string" ? message : new Uint8Array(message))
        if (typeof message !== "string") ws.send(message)
      },
      close(_ws, code) {
        closes.push(code)
      },
    },
  })
  stops.push(() => server.stop(true))
  return {
    url: `http://127.0.0.1:${server.port}`,
    offered,
    requestHeaders,
    received,
    closes,
    sockets,
  }
}

type UpgradeOptions = { headers?: HeadersInit; data: BridgeSocketData }

function startBridge(
  upstreamUrl: string,
  {
    deferUpgradeMs = 0,
    upstreamHeaders = { origin: upstreamUrl },
  }: { deferUpgradeMs?: number; upstreamHeaders?: Record<string, string> } = {},
) {
  const statuses: number[] = []
  const backlogAtOpen: number[] = []
  const server: Server<BridgeSocketData> = Bun.serve<BridgeSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      if (deferUpgradeMs === 0) {
        const response = await upgradeBridged(req, srv, upstreamUrl, upstreamHeaders)
        statuses.push(response?.status ?? 101)
        return response
      }
      // Bun runs open synchronously inside upgrade, so only a deferred upgrade lets upstream frames land first.
      let deferred: UpgradeOptions | undefined
      const deferring = Object.assign(Object.create(srv), {
        upgrade: (_req: Request, options: UpgradeOptions) => {
          deferred = options
          return true
        },
      }) as Server<BridgeSocketData>
      const response = await upgradeBridged(req, deferring, upstreamUrl, upstreamHeaders)
      if (response !== undefined || deferred === undefined) return response
      await Bun.sleep(deferUpgradeMs)
      statuses.push(srv.upgrade(req, deferred) ? 101 : 400)
      return undefined
    },
    websocket: {
      ...bridgeHandlers,
      open(ws) {
        backlogAtOpen.push(ws.data.backlog.length)
        bridgeHandlers.open(ws)
      },
    },
  })
  stops.push(() => server.stop(true))
  return { port: server.port, statuses, backlogAtOpen }
}

function connect(port: number | undefined, pathAndQuery: string, protocols: string[]) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${pathAndQuery}`, protocols)
  socket.binaryType = "arraybuffer"
  const received: Array<string | Uint8Array> = []
  socket.onmessage = (event) =>
    received.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data))
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener("close", (event) => resolve(event.code))
  })
  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("bridge refused the socket"))
  })
  stops.push(() => socket.close())
  return { socket, received, opened, closed }
}

async function until(label: string, ready: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

test("the upstream sees the original path, query and subprotocol, and the client gets the one it selected", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/_hmr/socket?token=abc&v=2", ["vite-hmr", "vite-ping"])
  await client.opened

  expect(client.socket.protocol).toBe("vite-hmr")
  expect(upstream.offered).toEqual([["vite-hmr", "vite-ping"]])
  await until("the first upstream frame", () => client.received.length > 0)
  expect(client.received[0]).toBe("0 /_hmr/socket?token=abc&v=2")
})

test("the client gets the subprotocol the upstream selected even when it is a later offer", async () => {
  const upstream = startUpstream(() => "vite-ping")
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr", "vite-ping", "other"])
  await client.opened

  expect(upstream.offered).toEqual([["vite-hmr", "vite-ping", "other"]])
  expect(client.socket.protocol).toBe("vite-ping")
})

test("the client upgrade completes with no subprotocol when none is offered or selected", async () => {
  const upstream = startUpstream(() => undefined)
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", [])
  await client.opened

  expect(upstream.offered).toEqual([[""]])
  expect(client.socket.protocol).toBe("")
  await until("the first upstream frame", () => client.received.length > 0)
  expect(client.received[0]).toBe("0 /hmr")
})

test("frames the upstream sends before the client opens arrive after open, in order", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url, { deferUpgradeMs: 100 })
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  await until("every early frame", () => client.received.length === EARLY_TEXT_FRAMES + 1)

  expect(bridge.backlogAtOpen).toEqual([EARLY_TEXT_FRAMES + 1])
  const texts = Array.from({ length: EARLY_TEXT_FRAMES }, (_, i) => `${i} /hmr`)
  expect(client.received).toEqual([...texts, EARLY_BINARY])
})

test("binary frames cross the bridge byte-identical in both directions, and text stays text", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  await until("the early frames", () => client.received.length === EARLY_TEXT_FRAMES + 1)

  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) % 256)
  client.socket.send(bytes)
  client.socket.send("plain text")
  await until("both frames upstream", () => upstream.received.length === 2)
  expect(upstream.received).toEqual([bytes, "plain text"])

  await until("the echoed bytes", () => client.received.length === EARLY_TEXT_FRAMES + 2)
  expect(client.received.at(-1)).toEqual(bytes)
  expect(client.received.at(-2)).toEqual(EARLY_BINARY)
})

test("a client close code reaches the upstream unchanged", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened

  client.socket.close(4001, "bye")
  await until("the upstream close", () => upstream.closes.length === 1)
  expect(upstream.closes).toEqual([4001])
})

test("an upstream close code reaches the client unchanged", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened

  upstream.sockets[0]?.close(1012, "restarting")
  expect(await client.closed).toBe(1012)
})

test("a client close frame without a code reaches the upstream as a normal close", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  let handshake = ""
  // Bun's own client always sends a code; a browser's bare close() sends an empty close frame.
  const raw = await Bun.connect({
    hostname: "127.0.0.1",
    port: bridge.port ?? 0,
    socket: {
      data(_socket, chunk) {
        handshake += chunk.toString("latin1")
      },
    },
  })
  stops.push(() => raw.end())
  raw.write(
    [
      "GET /hmr HTTP/1.1",
      `Host: 127.0.0.1:${bridge.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: vite-hmr",
      "",
      "",
    ].join("\r\n"),
  )
  await until("the upgrade response", () => handshake.includes("\r\n\r\n"))
  expect(handshake.startsWith("HTTP/1.1 101")).toBe(true)

  const maskedEmptyClose = [0x88, 0x80, 0x01, 0x02, 0x03, 0x04]
  raw.write(new Uint8Array(maskedEmptyClose))
  await until("the upstream close", () => upstream.closes.length === 1)
  expect(upstream.closes).toEqual([1000])
})

test("an upstream that drops the connection closes the client as an internal error", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened

  upstream.sockets[0]?.terminate()
  expect(await client.closed).toBe(1011)
})

test("an upstream that refuses the connection answers 502 and leaves the client un-upgraded", async () => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const closedPort = listener.port
  listener.stop(true)
  const bridge = startBridge(`http://127.0.0.1:${closedPort}`)

  await expect(connect(bridge.port, "/hmr", ["vite-hmr"]).opened).rejects.toThrow("refused")
  expect(bridge.statuses).toEqual([502])
})

test("an upstream that never opens within 5 s answers 502 and leaves the client un-upgraded", async () => {
  const silent: TCPSocketListener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  stops.push(() => silent.stop(true))
  const bridge = startBridge(`http://127.0.0.1:${silent.port}`)

  const startedAt = Date.now()
  await expect(connect(bridge.port, "/hmr", ["vite-hmr"]).opened).rejects.toThrow("refused")
  const elapsed = Date.now() - startedAt
  expect(elapsed).toBeGreaterThanOrEqual(4_900)
  expect(elapsed).toBeLessThan(6_000)
  expect(bridge.statuses).toEqual([502])
}, 10_000)

test.each([
  "/hmr",
  "/a%20b/c%2Fd.js",
  "/hmr?x=%26%3D&x=2&x=3&empty=&flag",
  "/_hmr/socket?token=abc%2Bdef&v=2",
])("the upstream sees the original path and query: %s", async (pathAndQuery) => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, pathAndQuery, ["vite-hmr"])
  await client.opened
  await until("the first upstream frame", () => client.received.length > 0)
  expect(client.received[0]).toBe(`0 ${pathAndQuery}`)
})

test("the caller's upstream headers, Origin included, reach the upstream handshake", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url, {
    upstreamHeaders: { origin: "http://app.example", "x-iter8-probe": "yes" },
  })
  await connect(bridge.port, "/hmr", ["vite-hmr"]).opened
  expect(upstream.requestHeaders).toHaveLength(1)
  expect(upstream.requestHeaders[0]?.origin).toBe("http://app.example")
  expect(upstream.requestHeaders[0]?.["x-iter8-probe"]).toBe("yes")
})

test("empty binary frames and frames viewed at a nonzero offset cross in both directions", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  await until("the early frames", () => client.received.length === EARLY_TEXT_FRAMES + 1)

  const backing = Uint8Array.from({ length: 64 }, (_, i) => i)
  const view = new Uint8Array(backing.buffer, 10, 5)
  const empty = new Uint8Array(0)
  client.socket.send(empty)
  client.socket.send(view)
  await until("both frames upstream", () => upstream.received.length === 2)
  expect(upstream.received).toEqual([empty, Uint8Array.of(10, 11, 12, 13, 14)])
  await until("the echoes", () => client.received.length === EARLY_TEXT_FRAMES + 3)
  expect(client.received.slice(-2)).toEqual([empty, Uint8Array.of(10, 11, 12, 13, 14)])

  const upstreamSocket = upstream.sockets[0]
  upstreamSocket?.send(empty)
  upstreamSocket?.send(new Uint8Array(backing.buffer, 20, 3))
  await until("the upstream-sent frames", () => client.received.length === EARLY_TEXT_FRAMES + 5)
  expect(client.received.slice(-2)).toEqual([empty, Uint8Array.of(20, 21, 22)])
})

test.each([
  ["a sendable code", 4001, 4001],
  ["another sendable code", 1012, 1012],
])(
  "an upstream that closes with %s before the client opens closes the client with it",
  async (_name, code, expected) => {
    const upstream = startUpstream(undefined, { afterOpen: (ws) => ws.close(code, "going away") })
    const bridge = startBridge(upstream.url, { deferUpgradeMs: 200 })
    const client = connect(bridge.port, "/hmr", ["vite-hmr"])
    await client.opened
    expect(await client.closed).toBe(expected)
    expect(client.received).toEqual([
      ...Array.from({ length: EARLY_TEXT_FRAMES }, (_, i) => `${i} /hmr`),
      EARLY_BINARY,
    ])
  },
)

test("an upstream that drops before the client opens closes the client as an internal error", async () => {
  const upstream = startUpstream(undefined, {
    afterOpen: (ws) => void setTimeout(() => ws.terminate(), 50),
  })
  const bridge = startBridge(upstream.url, { deferUpgradeMs: 200 })
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  expect(await client.closed).toBe(1011)
})

test("an upstream close frame without a code closes the client normally", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened

  upstream.sockets[0]?.close()
  expect(await client.closed).toBe(1000)
})

test("a client that drops the connection closes the upstream as an internal error", async () => {
  const upstream = startUpstream()
  const bridge = startBridge(upstream.url)
  let handshake = ""
  const raw = await Bun.connect({
    hostname: "127.0.0.1",
    port: bridge.port ?? 0,
    socket: {
      data(_socket, chunk) {
        handshake += chunk.toString("latin1")
      },
    },
  })
  stops.push(() => raw.end())
  raw.write(
    [
      "GET /hmr HTTP/1.1",
      `Host: 127.0.0.1:${bridge.port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: vite-hmr",
      "",
      "",
    ].join("\r\n"),
  )
  await until("the upgrade response", () => handshake.includes("\r\n\r\n"))
  raw.terminate()
  await until("the upstream close", () => upstream.closes.length === 1)
  expect(upstream.closes).toEqual([1011])
})

test("an upstream that accepts the connection but rejects the handshake answers 502", async () => {
  const rejecting = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("no websockets here", { status: 403 }),
  })
  stops.push(() => rejecting.stop(true))
  const bridge = startBridge(`http://127.0.0.1:${rejecting.port}`)

  await expect(connect(bridge.port, "/hmr", ["vite-hmr"]).opened).rejects.toThrow("refused")
  expect(bridge.statuses).toEqual([502])
})

test("an upstream that opens late but within 5 s is bridged, and the open timer does not outlive the open", async () => {
  const upstream = startUpstream(undefined, { acceptDelayMs: 1_000 })
  const bridge = startBridge(upstream.url)

  const startedAt = Date.now()
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900)
  expect(bridge.statuses).toEqual([101])

  await until("past the 5 s open deadline", () => Date.now() - startedAt > 5_600, 7_000)
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  const bytes = Uint8Array.of(1, 2, 3)
  client.socket.send(bytes)
  await until("the echo after the deadline", () => client.received.length === EARLY_TEXT_FRAMES + 2)
  expect(client.received.at(-1)).toEqual(bytes)
}, 15_000)

type FakeUpstream = {
  readyState: number
  onmessage: unknown
  onclose: ((event: { code: number; reason: string }) => void) | null
  close(code?: number, reason?: string): void
}

function fakeBridgedSocket() {
  const upstreamCloses: Array<[number | undefined, string | undefined]> = []
  const clientCloses: Array<[number | undefined, string | undefined]> = []
  const upstream: FakeUpstream = {
    readyState: WebSocket.OPEN,
    onmessage: null,
    onclose: null,
    close: (code, reason) => upstreamCloses.push([code, reason]),
  }
  const ws = {
    data: { kind: "bridge", upstream, backlog: [] },
    send() {},
    close: (code?: number, reason?: string) => clientCloses.push([code, reason]),
  } as unknown as ServerWebSocket<BridgeSocketData>
  return { ws, upstream, upstreamCloses, clientCloses }
}

const isSendable = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)

describe("close codes", () => {
  const sendable = [
    1000, 1001, 1002, 1003, 1007, 1008, 1011, 1012, 1013, 1014, 3000, 3999, 4000, 4999,
  ]
  const reserved = [999, 1004, 1015, 1016, 2999, 5000]

  test.each(sendable)("sendable code %d is kept in both directions", (code) => {
    const toUpstream = fakeBridgedSocket()
    bridgeHandlers.close(toUpstream.ws, code, "why")
    expect(toUpstream.upstreamCloses).toEqual([[code, "why"]])

    const toClient = fakeBridgedSocket()
    bridgeHandlers.open(toClient.ws)
    toClient.upstream.onclose?.({ code, reason: "why" })
    expect(toClient.clientCloses).toEqual([[code, "why"]])
  })

  test.each(reserved)(
    "reserved code %d is replaced by a sendable one in both directions",
    (code) => {
      const toUpstream = fakeBridgedSocket()
      bridgeHandlers.close(toUpstream.ws, code, "")
      const sentUpstream = toUpstream.upstreamCloses[0]?.[0] ?? 0
      expect(isSendable(sentUpstream)).toBe(true)

      const toClient = fakeBridgedSocket()
      bridgeHandlers.open(toClient.ws)
      toClient.upstream.onclose?.({ code, reason: "" })
      expect(isSendable(toClient.clientCloses[0]?.[0] ?? 0)).toBe(true)
    },
  )

  test("1005 becomes 1000 and 1006 becomes 1011, in both directions", () => {
    for (const [code, expected] of [
      [1005, 1000],
      [1006, 1011],
    ] as const) {
      const toUpstream = fakeBridgedSocket()
      bridgeHandlers.close(toUpstream.ws, code, "")
      expect(toUpstream.upstreamCloses[0]?.[0]).toBe(expected)

      const toClient = fakeBridgedSocket()
      bridgeHandlers.open(toClient.ws)
      toClient.upstream.onclose?.({ code, reason: "" })
      expect(toClient.clientCloses[0]?.[0]).toBe(expected)
    }
  })
})

test.each([
  ["a double slash", (port: number) => `//127.0.0.1:${port}/x?q=1`],
  ["a triple slash", (port: number) => `///127.0.0.1:${port}/x?q=1`],
  ["a backslash", (port: number) => `/\\127.0.0.1:${port}/x?q=1`],
  ["an encoded double slash", (port: number) => `/%2F%2F127.0.0.1:${port}/x?q=1`],
])("a path with %s cannot move the upstream socket to another host", async (_name, pathFor) => {
  const upstream = startUpstream()
  const elsewhere = startUpstream()
  const elsewherePort = Number(new URL(elsewhere.url).port)
  const bridge = startBridge(upstream.url)
  const sent = pathFor(elsewherePort)
  const client = connect(bridge.port, sent, ["vite-hmr"])
  await client.opened
  await until("the first upstream frame", () => client.received.length > 0)

  const expectedPath = new URL(`ws://127.0.0.1:${bridge.port}${sent}`).pathname
  expect(client.received[0]).toBe(`0 ${expectedPath}?q=1`)
  expect(upstream.offered).toHaveLength(1)
  expect(elsewhere.offered).toEqual([])
})

test("text and binary frames queued before the client opens keep their arrival order", async () => {
  const interleaved: Array<string | Uint8Array> = []
  for (let i = 0; i < 6; i++) {
    interleaved.push(`text ${i}`, Uint8Array.of(i, i + 1), Uint8Array.of(), `more ${i}`)
  }
  const upstream = startUpstream(undefined, {
    afterOpen: (ws) => {
      for (const frame of interleaved) ws.send(frame)
    },
  })
  const bridge = startBridge(upstream.url, { deferUpgradeMs: 200 })
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  const total = EARLY_TEXT_FRAMES + 1 + interleaved.length
  await until("every queued frame", () => client.received.length === total)

  expect(bridge.backlogAtOpen).toEqual([total])
  const texts = Array.from({ length: EARLY_TEXT_FRAMES }, (_, i) => `${i} /hmr`)
  expect(client.received).toEqual([...texts, EARLY_BINARY, ...interleaved])
})

test("an upstream that opens at about 4.6 s is used, not timed out", async () => {
  const upstream = startUpstream(undefined, { acceptDelayMs: 4_600 })
  const bridge = startBridge(upstream.url)

  const startedAt = Date.now()
  const client = connect(bridge.port, "/hmr", ["vite-hmr"])
  await client.opened
  const elapsed = Date.now() - startedAt
  expect(elapsed).toBeGreaterThanOrEqual(4_500)
  expect(elapsed).toBeLessThan(5_000)
  expect(bridge.statuses).toEqual([101])
  await until("the first upstream frame", () => client.received.length > 0)
  expect(client.received[0]).toBe("0 /hmr")
}, 15_000)

test("an upstream that ignores the offered subprotocols is refused with 502, since Bun's client fails that handshake", async () => {
  const offers: string[] = []
  const ignoring: TCPSocketListener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const text = chunk.toString()
        offers.push(/sec-websocket-protocol: (.+)\r\n/i.exec(text)?.[1]?.trim() ?? "")
        const key = /sec-websocket-key: (.+)\r\n/i.exec(text)?.[1]?.trim() ?? ""
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64")
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        )
      },
    },
  })
  stops.push(() => ignoring.stop(true))
  const bridge = startBridge(`http://127.0.0.1:${ignoring.port}`)

  await expect(connect(bridge.port, "/hmr", ["vite-hmr"]).opened).rejects.toThrow("refused")
  expect(offers).toEqual(["vite-hmr"])
  expect(bridge.statuses).toEqual([502])
})
