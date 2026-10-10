import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as nodeFs from "node:fs"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { networkInterfaces } from "node:os"
import { join } from "node:path"
import {
  LANDING_PATH,
  LIVE_PATH,
  liveSubprotocols,
  MachineId,
  OVERLAY_PREFIX,
  OverlayBoot,
  PageToken,
  PairingGeneration,
  PROTOCOL_VERSION,
  ResolvedSourceLead,
  RoundsResult,
  renderBootScript,
  ServerMessage,
  ServiceStatus,
  SOURCE_BUNDLE_PATH,
} from "@iter8/protocol"
import type { Server } from "bun"
import { createAgentNotes } from "../pages/agent-notes"
import { createPages, type PageRecord } from "../pages/pages"
import { createPrefs } from "../pages/prefs"
import { createScreenshots } from "../pages/screenshots"
import { createOwners } from "../pairing/owners"
import { createInbox } from "../rounds/inbox"
import { openStore } from "../store/db"
import { createControlApi } from "./control-api"
import { createLiveHub } from "./live"
import { createOverlayApi, type OverlayApiDeps, pagePairing } from "./overlay-api"
import { type RunningServer, startServer } from "./server"
import { createWaiters } from "./waiters"

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const machineId = MachineId.parse("machine-under-test")
const machineName = "devbox"
const APP_HTML = "<!doctype html><html><head><title>app</title></head><body>app body</body></html>"

async function until(label: string, read: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!read()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await Bun.sleep(10)
  }
}

function freePort(): number {
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const { port } = probe
  probe.stop(true)
  return port
}

function occupyPort(): number {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other") })
  cleanups.push(() => blocker.stop(true))
  if (blocker.port === undefined) throw new Error("Blocker has no port")
  return blocker.port
}

type UpstreamSocketData = {
  host: string | null
  origin: string | null
  path: string
  headers: Record<string, string>
}

function startUpstream(name: string, respond?: (req: Request) => Response) {
  const handshakes: UpstreamSocketData[] = []
  const requests: string[] = []
  const closes: number[] = []
  const server: Server<UpstreamSocketData> = Bun.serve<UpstreamSocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const offers = (req.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((p) => p.trim())
      const { pathname, search } = new URL(req.url)
      const data = {
        host: req.headers.get("host"),
        origin: req.headers.get("origin"),
        path: pathname + search,
        headers: Object.fromEntries(req.headers),
      }
      const headers = new Headers(
        offers.includes("vite-hmr") ? { "Sec-WebSocket-Protocol": "vite-hmr" } : {},
      )
      if (srv.upgrade(req, { headers, data })) return undefined
      requests.push(pathname + search)
      if (respond) return respond(req)
      return new Response(APP_HTML.replace("app body", `${name} body`), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    },
    websocket: {
      open(ws) {
        handshakes.push(ws.data)
      },
      message(ws, message) {
        if (message === "close-me") ws.close(4001, "bye")
        else ws.send(typeof message === "string" ? `${name} echo ${message}` : message)
      },
      close(_ws, code) {
        closes.push(code)
      },
    },
  })
  cleanups.push(() => server.stop(true))
  return { url: `http://127.0.0.1:${server.port}`, handshakes, requests, closes }
}

async function makeDeps() {
  const db = openStore(":memory:")
  cleanups.push(() => db.close())
  const scratch = await mkdtemp("/tmp/iter8-")
  cleanups.push(() => rm(scratch, { recursive: true, force: true }))
  const overlayDir = join(scratch, "overlay")
  const folder = join(scratch, "site")
  await mkdir(overlayDir)
  await mkdir(folder)
  await writeFile(join(overlayDir, "overlay.js"), "export function mount() {}\n")

  const now = () => new Date(Date.UTC(2026, 9, 9, 18, 0, 0))
  const owners = createOwners(db, { processStart: () => null, now })
  let tokens = 0
  const pages = createPages(db, {
    randomToken: () => PageToken.parse(`token${String(++tokens).padStart(40, "0")}`),
  })
  const waiters = createWaiters()
  const live = createLiveHub()
  const screenshots = createScreenshots(db, { now })
  const agentNotes = createAgentNotes(db, { now })
  const listener = (owner: Parameters<typeof waiters.isArmed>[0]) =>
    waiters.isArmed(owner) ? "armed" : "none"
  const overlay: OverlayApiDeps = {
    pages,
    owners,
    inbox: createInbox(db, {
      now,
      ownerState: (owner) => owners.state(owner),
      pairing: (pageId) => {
        const record = pages.get(pageId)
        return record && pagePairing(overlay, record)
      },
    }),
    agentNotes,
    screenshots,
    prefs: createPrefs(db),
    live,
    waiters,
    symbolicator: {
      resolve: async () => ResolvedSourceLead.parse({ confidence: "none", reason: "no-framework" }),
    },
    overlayDir,
    machineId,
    machineName,
    serviceVersion: "9.9.9-test",
  }
  let running: RunningServer | null = null
  const controlApp = createControlApi({
    pages,
    owners,
    inbox: overlay.inbox,
    agentNotes,
    screenshots,
    live,
    waiters,
    status: (owner) =>
      ServiceStatus.parse({
        state: "ready",
        version: "9.9.9-test",
        build: "source",
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: 1,
        machineId,
        machineName,
        pid: process.pid,
        home: scratch,
        pool: running?.ports ?? [],
        overlay: "present",
        owner: owner && owners.pairing(owner, PairingGeneration.parse(0), listener(owner)),
      }),
    drain: () => {},
    onPageOpened: () => {},
    poolPorts: () => running?.ports ?? [],
    machineId,
  })

  const controlSocket = join(scratch, "control.sock")

  async function start(poolPorts: number[]): Promise<RunningServer> {
    const server = await startServer({
      overlayApp: createOverlayApi(overlay),
      controlApp,
      overlay,
      poolPorts,
      controlSocket,
      fetch,
    })
    running = server
    cleanups.push(() => server.stop())
    return server
  }

  return { overlay, pages, live, scratch, folder, controlSocket, start }
}

async function startDefault(poolSize = 2) {
  const deps = await makeDeps()
  const running = await deps.start(new Array(poolSize).fill(0))

  function openServer(upstream: string, extras: string[] = []): PageRecord {
    return deps.pages.open({
      target: { kind: "server", upstream, extras },
      projectRoot: deps.scratch,
      poolPorts: running.ports,
    })
  }

  function openFolder(root = deps.folder): PageRecord {
    return deps.pages.open({
      target: { kind: "folder", root },
      projectRoot: deps.scratch,
      poolPorts: running.ports,
    })
  }

  return { ...deps, running, openServer, openFolder }
}

function primaryPort(record: PageRecord): number {
  return Number(new URL(record.page.origin).port)
}

function hostOf(record: PageRecord, port = primaryPort(record)): string {
  return `${record.page.id}.localhost:${port}`
}

function get(port: number, host: string, path = "/", headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { ...headers, host },
    redirect: "manual",
  })
}

function expectedBootTag(record: PageRecord): string {
  const boot = OverlayBoot.parse({
    protocolVersion: PROTOCOL_VERSION,
    pageId: record.page.id,
    machineId,
    machineName,
    token: record.token,
    apiBase: OVERLAY_PREFIX,
    sourceBundleUrl: SOURCE_BUNDLE_PATH,
  })
  return `<script type="module">${renderBootScript(boot)}</script>`
}

type Client = {
  ws: WebSocket
  messages: string[]
  frames: unknown[]
  closes: number[]
}

function connect(
  port: number,
  host: string,
  path: string,
  protocols: string[],
  origin: string | null = `http://${host}`,
  extraHeaders: Record<string, string> = {},
): Promise<Client> {
  // lib.dom's WebSocket type hides Bun's constructor option for request headers.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    ...(protocols.length ? { protocols } : {}),
    headers: { ...(origin === null ? { host } : { host, origin }), ...extraHeaders },
  } as unknown as string[])
  const client: Client = { ws, messages: [], frames: [], closes: [] }
  cleanups.push(() => ws.close())
  ws.binaryType = "arraybuffer"
  ws.onmessage = (event) => {
    client.frames.push(event.data)
    client.messages.push(String(event.data))
  }
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.onerror = null
      ws.onclose = (event) => client.closes.push(event.code)
      resolve(client)
    }
    ws.onerror = () => reject(new Error(`websocket to ${host}${path} failed to open`))
  })
}

function connectLive(record: PageRecord, token: PageToken = record.token, origin?: string) {
  const host = hostOf(record)
  return connect(primaryPort(record), host, LIVE_PATH, liveSubprotocols(token), origin)
}

function serverMessages(client: Client): ServerMessage[] {
  return client.messages.map((text) => ServerMessage.parse(JSON.parse(text)))
}

describe("pool listeners", () => {
  test("bind every pool listener to 127.0.0.1 and to no other address", async () => {
    const deps = await makeDeps()
    const serve = spyOn(Bun, "serve")
    let running: RunningServer
    let calls: typeof serve.mock.calls
    let results: typeof serve.mock.results
    try {
      running = await deps.start([0, 0])
    } finally {
      calls = [...serve.mock.calls]
      results = [...serve.mock.results]
      serve.mockRestore()
    }
    const poolCalls = calls.filter(([options]) => !("unix" in options && options.unix))
    expect(poolCalls).toHaveLength(2)
    for (const [options] of poolCalls) expect(options).toMatchObject({ hostname: "127.0.0.1" })
    const poolServers = results
      .map((result) => result.value as Server<unknown>)
      .filter((server) => server.port !== undefined)
    expect(poolServers.map((server) => server.hostname)).toEqual(["127.0.0.1", "127.0.0.1"])

    const elsewhere = [
      "[::1]",
      ...Object.values(networkInterfaces())
        .flat()
        .filter((info) => info !== undefined && !info.internal && info.family === "IPv4")
        .map((info) => info?.address),
    ]
    for (const port of running.ports) {
      expect((await get(port, `nobody.localhost:${port}`, LANDING_PATH)).status).toBe(200)
      for (const address of elsewhere) {
        await expect(fetch(`http://${address}:${port}${LANDING_PATH}`)).rejects.toThrow()
      }
    }
  })

  test("skip a pool port already in use and serve on the rest", async () => {
    const deps = await makeDeps()
    const busy = occupyPort()
    const running = await deps.start([busy, 0])
    expect(running.ports).toHaveLength(1)
    expect(running.ports).not.toContain(busy)
    const [free = 0] = running.ports
    expect((await get(free, `nobody.localhost:${free}`, LANDING_PATH)).status).toBe(200)
  })

  test("keep binding after a busy port in the middle of the pool and serve every available port", async () => {
    const deps = await makeDeps()
    const busy = occupyPort()
    const running = await deps.start([0, busy, 0])
    expect(running.ports).toHaveLength(2)
    expect(running.ports).not.toContain(busy)
    expect(new Set(running.ports).size).toBe(2)
    for (const port of running.ports) {
      expect((await get(port, `nobody.localhost:${port}`, LANDING_PATH)).status).toBe(200)
    }
  })

  test("fail to start with an empty pool, leaving no control socket", async () => {
    const deps = await makeDeps()
    await expect(deps.start([])).rejects.toThrow("No iter8 pool port could be bound")
    expect(existsSync(deps.controlSocket)).toBe(false)
  })

  test("fail naming every port tried on an error other than in use, and release the earlier listener", async () => {
    const deps = await makeDeps()
    const good = freePort()
    const failure = deps.start([good, 70_000, 0])
    await expect(failure).rejects.toThrow()
    const message = await failure.catch((error: Error) => error.message)
    expect(message).toContain(String(good))
    expect(message).toContain("70000")
    await expect(fetch(`http://127.0.0.1:${good}${LANDING_PATH}`)).rejects.toThrow()
    expect(existsSync(deps.controlSocket)).toBe(false)
  })

  test("fail to start naming every port tried when none can be bound", async () => {
    const deps = await makeDeps()
    const ports = [occupyPort(), occupyPort()]
    const failure = deps.start(ports)
    await expect(failure).rejects.toThrow()
    const message = await failure.catch((error: Error) => error.message)
    for (const port of ports) expect(message).toContain(String(port))
    expect(existsSync(deps.controlSocket)).toBe(false)
  })
})

describe("request routing", () => {
  test("proxy a page's primary port to its upstream with the boot script in HTML", async () => {
    const { openServer } = await startDefault()
    const upstream = startUpstream("primary")
    const record = openServer(upstream.url)

    const res = await get(primaryPort(record), hostOf(record))
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain("primary body")
    expect(html).toContain(`${expectedBootTag(record)}</head>`)
  })

  test("proxy an extra upstream's port on the page hostname without injection", async () => {
    const { openServer } = await startDefault()
    const primary = startUpstream("primary")
    const extra = startUpstream("extra")
    const record = openServer(primary.url, [extra.url])
    const extraPort = record.page.target.kind === "server" && record.page.target.extraUpstreams[0]
    if (!extraPort) throw new Error("Page has no extra upstream")

    const res = await get(extraPort.port, hostOf(record, extraPort.port))
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(html).toContain("extra body")
    expect(html).not.toContain('<script type="module">')
  })

  test("select the upstream and boot token by hostname and listener port together across pages", async () => {
    const { openServer } = await startDefault(4)
    const first = startUpstream("first")
    const firstExtraA = startUpstream("first-extra-a")
    const firstExtraB = startUpstream("first-extra-b")
    const second = startUpstream("second")
    const one = openServer(first.url, [firstExtraA.url, firstExtraB.url])
    const two = openServer(second.url)
    const extras = one.page.target.kind === "server" ? one.page.target.extraUpstreams : []
    expect(extras).toHaveLength(2)
    const [extraA, extraB] = extras
    if (!extraA || !extraB) throw new Error("Page has no extra upstreams")

    const primaryOne = await (await get(primaryPort(one), hostOf(one))).text()
    expect(primaryOne).toContain("first body")
    expect(primaryOne).toContain(expectedBootTag(one))
    const primaryTwo = await (await get(primaryPort(two), hostOf(two))).text()
    expect(primaryTwo).toContain("second body")
    expect(primaryTwo).toContain(expectedBootTag(two))
    expect(primaryTwo).not.toContain(expectedBootTag(one))
    for (const [extra, name] of [
      [extraA, "first-extra-a"],
      [extraB, "first-extra-b"],
    ] as const) {
      const html = await (await get(extra.port, hostOf(one, extra.port))).text()
      expect(html).toContain(`${name} body`)
      expect(html).not.toContain('<script type="module">')
    }
    expect(primaryPort(two)).toBe(primaryPort(one))
    expect(new Set([primaryPort(one), extraA.port, extraB.port]).size).toBe(3)
    const crossed = await get(extraA.port, hostOf(two, extraA.port))
    expect(crossed.status).toBe(404)
  })

  test("answer 404 for a page hostname on a port that is not its own, and route /__iter8 lookalikes to the app", async () => {
    const { openServer, running } = await startDefault()
    const upstream = startUpstream("primary")
    const one = openServer(upstream.url)
    const unassigned = running.ports.find((port) => port !== primaryPort(one))
    if (unassigned === undefined) throw new Error("The pool has no spare port")

    const foreign = await get(unassigned, hostOf(one, unassigned), "/page")
    expect(foreign.status).toBe(404)
    expect(await foreign.text()).toContain(`No iter8 page is open at ${hostOf(one, unassigned)}`)

    for (const path of ["/__iter8-other", "/__iter8x/live", "/x/__iter8/live"]) {
      const res = await get(primaryPort(one), hostOf(one), path)
      expect({ path, status: res.status, body: await res.text() }).toMatchObject({
        path,
        status: 200,
        body: expect.stringContaining("primary body"),
      })
    }
    expect(upstream.requests).toEqual(["/__iter8-other", "/__iter8x/live", "/x/__iter8/live"])
    const nobody = `nobody.localhost:${primaryPort(one)}`
    expect((await get(primaryPort(one), nobody, "/__iter8-other")).status).toBe(404)
  })

  test("rewrite an upstream redirect to the page port that serves that upstream", async () => {
    const { openServer } = await startDefault()
    const extra = startUpstream("extra")
    const primary = startUpstream("primary", (req) => {
      const to = new URL(req.url).pathname === "/to-extra" ? `${extra.url}/x` : "/inside"
      return new Response(null, { status: 302, headers: { location: to } })
    })
    const record = openServer(primary.url, [extra.url])
    const target = record.page.target
    const extraPort = target.kind === "server" ? target.extraUpstreams[0]?.port : undefined

    const host = hostOf(record)
    const toExtra = await get(primaryPort(record), host, "/to-extra")
    expect(toExtra.headers.get("location")).toBe(
      `http://${record.page.id}.localhost:${extraPort}/x`,
    )
    const inside = await get(primaryPort(record), host, "/same")
    expect(new URL(inside.headers.get("location") ?? "", record.page.origin).href).toBe(
      `${record.page.origin}/inside`,
    )
  })

  test("answer 404 naming the host when no page is open there, outside /__iter8", async () => {
    const { running } = await startDefault()
    const port = running.ports[0] ?? 0
    const host = `nobody.localhost:${port}`

    const res = await get(port, host, "/some/page")
    expect(res.status).toBe(404)
    expect(await res.text()).toContain(`No iter8 page is open at ${host}`)
    expect((await get(port, host, LANDING_PATH)).status).toBe(200)
  })

  test("push an upstream failure to the page's live sockets", async () => {
    const { openServer } = await startDefault()
    const deadUpstream = `http://127.0.0.1:${freePort()}`
    const record = openServer(deadUpstream)
    const client = await connectLive(record)

    expect((await get(primaryPort(record), hostOf(record))).status).toBe(502)
    await until("an upstream-failure message", () => client.messages.length > 0)
    expect(serverMessages(client)).toEqual([
      {
        type: "upstream-failure",
        port: primaryPort(record),
        url: record.page.target.kind === "server" ? record.page.target.upstream : "",
      },
    ])
  })
})

describe("websockets", () => {
  test("attach a live socket offering the page token to the page's live hub as iter8.v1", async () => {
    const { openServer, live } = await startDefault()
    const record = openServer(startUpstream("primary").url)

    const client = await connectLive(record)
    expect(client.ws.protocol).toBe("iter8.v1")
    await until("the socket to attach", () => live.size() === 1)
    live.push(record.page.id, { type: "draining" })
    await until("the pushed message", () => client.messages.length > 0)
    expect(serverMessages(client)).toEqual([{ type: "draining" }])

    client.ws.close()
    await until("the socket to detach", () => live.size() === 0)
  })

  test("refuse a live socket with the wrong token or from another origin", async () => {
    const { openServer, live } = await startDefault()
    const record = openServer(startUpstream("primary").url)

    await expect(connectLive(record, PageToken.parse("x".repeat(43)))).rejects.toThrow()
    await expect(connectLive(record, record.token, "http://evil.localhost:1")).rejects.toThrow()
    expect(live.size()).toBe(0)
  })

  test("refuse a live socket that omits a protocol or the Origin, names no page, or comes in on an extra port", async () => {
    const { openServer, live } = await startDefault()
    const primary = startUpstream("primary")
    const extra = startUpstream("extra")
    const record = openServer(primary.url, [extra.url])
    const extraPort =
      record.page.target.kind === "server" ? record.page.target.extraUpstreams[0]?.port : undefined
    if (extraPort === undefined) throw new Error("Page has no extra upstream")
    const host = hostOf(record)
    const port = primaryPort(record)
    const offered = liveSubprotocols(record.token)
    const [version = "", token = ""] = offered

    const refusals: Array<() => Promise<Client>> = [
      () => connect(port, host, LIVE_PATH, []),
      () => connect(port, host, LIVE_PATH, [version]),
      () => connect(port, host, LIVE_PATH, [token]),
      () => connect(port, host, LIVE_PATH, offered, null),
      () => connect(port, `nobody.localhost:${port}`, LIVE_PATH, offered),
      () => connect(extraPort, hostOf(record, extraPort), LIVE_PATH, offered),
    ]
    for (const refusal of refusals) await expect(refusal()).rejects.toThrow()
    expect(live.size()).toBe(0)
    expect((await connectLive(record)).ws.protocol).toBe("iter8.v1")
  })

  test("deliver a push to every live socket of its page and none of another page, and keep the rest when one closes", async () => {
    const { openServer, live } = await startDefault()
    const one = openServer(startUpstream("one").url)
    const two = openServer(startUpstream("two").url)
    const first = await connectLive(one)
    const second = await connectLive(one)
    const other = await connectLive(two)
    await until("three sockets", () => live.size() === 3)

    live.push(one.page.id, { type: "draining" })
    await until(
      "both sockets of the page",
      () => first.messages.length + second.messages.length === 2,
    )
    live.push(two.page.id, { type: "reload" })
    await until("the other page's socket", () => other.messages.length === 1)
    expect(serverMessages(first)).toEqual([{ type: "draining" }])
    expect(serverMessages(second)).toEqual([{ type: "draining" }])
    expect(serverMessages(other)).toEqual([{ type: "reload" }])

    first.ws.close()
    await until("the closed socket to detach", () => live.size() === 2)
    live.push(one.page.id, { type: "reload" })
    await until("the remaining socket", () => second.messages.length === 2)
    expect(serverMessages(second)).toEqual([{ type: "draining" }, { type: "reload" }])
    expect(serverMessages(first)).toEqual([{ type: "draining" }])
  })

  test("keep a live socket open after a valid ClientMessage", async () => {
    const { openServer, live } = await startDefault()
    const record = openServer(startUpstream("primary").url)
    const client = await connectLive(record)
    await until("the socket to attach", () => live.size() === 1)

    client.ws.send(JSON.stringify({ type: "ping", at: new Date().toISOString() }))
    live.push(record.page.id, { type: "draining" })
    await until("the pushed message", () => client.messages.length > 0)
    live.push(record.page.id, { type: "reload" })
    await until("a second pushed message", () => client.messages.length > 1)
    expect(client.closes).toEqual([])
    expect(live.size()).toBe(1)
  })

  test("close a live socket with 1007 for a frame that is not JSON, not a ClientMessage, or binary", async () => {
    const { openServer, live } = await startDefault()
    const record = openServer(startUpstream("primary").url)
    const frames: Array<[string, string | Uint8Array<ArrayBuffer>]> = [
      ["not json", "not json"],
      ["wrong shape", JSON.stringify({ type: "no-such-message" })],
      ["an array", JSON.stringify([1, 2])],
      ["binary", new Uint8Array(new ArrayBuffer(3))],
    ]
    for (const [name, frame] of frames) {
      const client = await connectLive(record)
      client.ws.send(frame)
      await until(`${name} to close the socket`, () => client.closes.length > 0)
      expect({ name, closes: client.closes }).toEqual({ name, closes: [1007] })
    }
    await until("every socket to detach", () => live.size() === 0)
  })

  test("bridge any other websocket on a page hostname to that page's upstream", async () => {
    const { openServer } = await startDefault()
    const upstream = startUpstream("primary")
    const record = openServer(upstream.url)

    const client = await connect(primaryPort(record), hostOf(record), "/hmr?t=1", ["vite-hmr"])
    expect(client.ws.protocol).toBe("vite-hmr")
    client.ws.send("hello")
    await until("the echo", () => client.messages.length > 0)
    expect(client.messages).toEqual(["primary echo hello"])
    const upstreamUrl = new URL(upstream.url)
    expect(upstream.handshakes.map(({ host, origin, path }) => ({ host, origin, path }))).toEqual([
      { host: upstreamUrl.host, origin: upstreamUrl.origin, path: "/hmr?t=1" },
    ])
  })

  test("forward the client's end-to-end headers to the upstream socket and drop hop-by-hop ones", async () => {
    const { openServer } = await startDefault()
    const upstream = startUpstream("primary")
    const record = openServer(upstream.url)

    await connect(primaryPort(record), hostOf(record), "/app", [], undefined, {
      cookie: "session=abc123; theme=dark",
      authorization: "Bearer app-token",
      "user-agent": "iter8-test-agent/1.0",
      "x-app-header": "custom-value",
      "keep-alive": "timeout=5",
      te: "trailers",
      "proxy-authorization": "Basic c2VjcmV0",
    })
    await until("the handshake", () => upstream.handshakes.length === 1)
    const received = upstream.handshakes[0]?.headers ?? {}
    expect(received).toMatchObject({
      cookie: "session=abc123; theme=dark",
      authorization: "Bearer app-token",
      "user-agent": "iter8-test-agent/1.0",
      "x-app-header": "custom-value",
      host: new URL(upstream.url).host,
      origin: new URL(upstream.url).origin,
    })
    for (const hopByHop of ["keep-alive", "te", "proxy-authorization"]) {
      expect(received).not.toHaveProperty(hopByHop)
    }
  })

  test("rewrite only the page's own Origin for the upstream and pass any other, or none, through", async () => {
    const { openServer } = await startDefault()
    const upstream = startUpstream("primary")
    const record = openServer(upstream.url)
    const host = hostOf(record)
    const upstreamUrl = new URL(upstream.url)

    await connect(primaryPort(record), host, "/own", [])
    await connect(primaryPort(record), host, "/foreign", [], "http://evil.example")
    await connect(primaryPort(record), host, "/other-page", [], "http://other.localhost:3990")
    await connect(primaryPort(record), host, "/none", [], null)
    await until("four handshakes", () => upstream.handshakes.length === 4)
    const originOf = (path: string) =>
      upstream.handshakes.find((handshake) => handshake.path === path)?.origin
    expect(originOf("/own")).toBe(upstreamUrl.origin)
    expect(originOf("/foreign")).toBe("http://evil.example")
    expect(originOf("/other-page")).toBe("http://other.localhost:3990")
    expect(originOf("/none")).toBeNull()
    for (const handshake of upstream.handshakes) expect(handshake.host).toBe(upstreamUrl.host)
  })
})

describe("websocket bridge", () => {
  test("bridge a socket on an extra port to that extra upstream, without a subprotocol", async () => {
    const { openServer } = await startDefault()
    const primary = startUpstream("primary")
    const extra = startUpstream("extra")
    const record = openServer(primary.url, [extra.url])
    const extraPort =
      record.page.target.kind === "server" ? record.page.target.extraUpstreams[0]?.port : undefined
    if (extraPort === undefined) throw new Error("Page has no extra upstream")

    const onExtra = await connect(extraPort, hostOf(record, extraPort), "/socket", [])
    expect(onExtra.ws.protocol).toBe("")
    onExtra.ws.send("hello")
    await until("the extra echo", () => onExtra.messages.length > 0)
    expect(onExtra.messages).toEqual(["extra echo hello"])
    expect(extra.handshakes.map((handshake) => handshake.path)).toEqual(["/socket"])
    expect(primary.handshakes).toEqual([])
  })

  test("forward binary frames both ways unchanged", async () => {
    const { openServer } = await startDefault()
    const record = openServer(startUpstream("primary").url)
    const client = await connect(primaryPort(record), hostOf(record), "/bin", [])

    const bytes = new Uint8Array([0, 255, 128, 7, 0])
    client.ws.send(bytes)
    await until("the binary echo", () => client.frames.length > 0)
    const [frame] = client.frames
    expect(frame).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(frame as ArrayBuffer)).toEqual(bytes)
  })

  test("carry a close from either side to the other", async () => {
    const { openServer } = await startDefault()
    const upstream = startUpstream("primary")
    const record = openServer(upstream.url)

    const fromUpstream = await connect(primaryPort(record), hostOf(record), "/a", [])
    fromUpstream.ws.send("close-me")
    await until("the client to see the upstream's close", () => fromUpstream.closes.length > 0)
    expect(fromUpstream.closes).toEqual([4001])

    const fromClient = await connect(primaryPort(record), hostOf(record), "/b", [])
    fromClient.ws.close(1000)
    await until("the upstream to see the client's close", () => upstream.closes.length === 2)
    expect(upstream.closes.sort()).toEqual([1000, 4001].sort())
  })
})

describe("folder pages", () => {
  test("serve a folder page's HTML with the boot script and other files as they are", async () => {
    const { openFolder, folder } = await startDefault()
    await writeFile(join(folder, "index.html"), APP_HTML)
    await writeFile(join(folder, "style.css"), "body { color: red }")
    const record = openFolder()

    const page = await get(primaryPort(record), hostOf(record))
    expect(await page.text()).toContain(`${expectedBootTag(record)}</head>`)
    const css = await get(primaryPort(record), hostOf(record), "/style.css")
    expect(await css.text()).toBe("body { color: red }")
  })

  test("push one reload per change to every live socket of the changed folder page and to no other page", async () => {
    const { openFolder, folder, running, scratch } = await startDefault()
    const watches: Array<{ close: ReturnType<typeof spyOn> }> = []
    const realWatch = nodeFs.watch
    const watchSpy = spyOn(nodeFs, "watch").mockImplementation(((
      ...args: Parameters<typeof realWatch>
    ) => {
      const watcher = realWatch(...args)
      watches.push({ close: spyOn(watcher, "close") })
      return watcher
    }) as typeof realWatch)
    cleanups.push(() => watchSpy.mockRestore())
    const otherFolder = join(scratch, "site-two")
    await mkdir(join(folder, "assets", "deep"), { recursive: true })
    await mkdir(otherFolder)
    await writeFile(join(folder, "index.html"), APP_HTML)
    await writeFile(join(otherFolder, "index.html"), APP_HTML)
    const record = openFolder()
    const other = openFolder(otherFolder)
    running.watchFolder(record)
    running.watchFolder(record)
    running.watchFolder(other)
    expect(watches).toHaveLength(2)
    const first = await connectLive(record)
    const second = await connectLive(record)
    const bystander = await connectLive(other)

    await writeFile(join(folder, "assets", "deep", "app.css"), "body { color: blue }")
    await until(
      "both sockets of the changed page",
      () => first.messages.length > 0 && second.messages.length > 0,
    )
    await writeFile(join(otherFolder, "index.html"), APP_HTML.replace("app body", "edited"))
    await until("the other page's reload", () => bystander.messages.length > 0)
    expect(serverMessages(first)).toEqual([{ type: "reload" }])
    expect(serverMessages(second)).toEqual([{ type: "reload" }])
    expect(serverMessages(bystander)).toEqual([{ type: "reload" }])
  })
})

describe("control socket", () => {
  test("serve the control app on a unix socket only the owner can open", async () => {
    const deps = await makeDeps()
    await deps.start([0])

    expect((await stat(deps.controlSocket)).mode & 0o777).toBe(0o600)
    const res = await fetch("http://localhost/rounds", {
      unix: deps.controlSocket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identities: [], owner: null }),
    })
    expect(res.status).toBe(200)
    expect(RoundsResult.parse(await res.json())).toEqual({ rounds: [] })
  })

  test("refuse to start while another process answers on the socket, leaving it in place", async () => {
    const deps = await makeDeps()
    const other = Bun.serve({ unix: deps.controlSocket, fetch: () => new Response("other") })
    cleanups.push(() => other.stop(true))
    const port = freePort()

    await expect(deps.start([port])).rejects.toThrow("already listening")
    expect(existsSync(deps.controlSocket)).toBe(true)
    const res = await fetch("http://localhost/", { unix: deps.controlSocket })
    expect(await res.text()).toBe("other")
    expect((await fetch(`http://127.0.0.1:${port}/`).catch(() => null))?.status).toBeUndefined()
  })

  test("replace a stale socket file nothing answers on", async () => {
    const deps = await makeDeps()
    await writeFile(deps.controlSocket, "")
    await deps.start([0])

    expect((await stat(deps.controlSocket)).mode & 0o777).toBe(0o600)
    const res = await fetch("http://localhost/rounds", {
      unix: deps.controlSocket,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identities: [], owner: null }),
    })
    expect(res.status).toBe(200)
  })

  test("serve the control socket with no idle timeout so a long poll can span its wait", async () => {
    const deps = await makeDeps()
    const serve = spyOn(Bun, "serve")
    let calls: typeof serve.mock.calls
    try {
      await deps.start([0])
    } finally {
      calls = [...serve.mock.calls]
      serve.mockRestore()
    }
    const control = calls.filter(([options]) => "unix" in options && options.unix)
    expect(control).toHaveLength(1)
    expect(control[0]?.[0]).toMatchObject({ unix: deps.controlSocket, idleTimeout: 0 })
  })

  test("stop closes every listener and every watcher and removes the socket file", async () => {
    const deps = await makeDeps()
    const running = await deps.start([0, 0])
    expect(running.ports).toHaveLength(2)
    const closes: Array<ReturnType<typeof spyOn>> = []
    const realWatch = nodeFs.watch
    const watchSpy = spyOn(nodeFs, "watch").mockImplementation(((
      ...args: Parameters<typeof realWatch>
    ) => {
      const watcher = realWatch(...args)
      closes.push(spyOn(watcher, "close"))
      return watcher
    }) as typeof realWatch)
    const second = join(deps.scratch, "site-two")
    await mkdir(second)
    for (const root of [deps.folder, second]) {
      running.watchFolder(
        deps.pages.open({
          target: { kind: "folder", root },
          projectRoot: deps.scratch,
          poolPorts: running.ports,
        }),
      )
    }
    watchSpy.mockRestore()
    expect(closes).toHaveLength(2)

    await running.stop()
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1])
    expect(existsSync(deps.controlSocket)).toBe(false)
    for (const port of running.ports) {
      await expect(fetch(`http://127.0.0.1:${port}${LANDING_PATH}`)).rejects.toThrow()
    }
  })
})
