import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import {
  ASSET_PREFIX,
  DraftBody,
  LIVE_PATH,
  LiveSession,
  liveSubprotocols,
  OVERLAY_ROUTES,
  OverlayPrefs,
  Pairing,
  PROTOCOL_VERSION,
  ServerMessage,
  SourceLead,
  TOKEN_HEADER,
} from "@iter8/protocol"
import fc from "fast-check"
import { fixtureDir } from "../../rig/fixtures"
import { WORKER } from "../../rig/ports"
import { type Scratch, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import { type MockService, startMockService } from "../../stubs/mock-service"

const sample = (name: string) =>
  Bun.file(new URL(`../../../packages/protocol/fixtures/${name}.json`, import.meta.url)).json()

const draftBody = DraftBody.parse(await sample("DraftBody"))
const pairing = Pairing.parse(await sample("Pairing"))
const liveSession = LiveSession.parse(await sample("LiveSession"))
const sourceLead = SourceLead.parse(await sample("SourceLead"))
const prefs = OverlayPrefs.parse(await sample("OverlayPrefs"))

const FONT = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4])
const PNG_WIDTH = 640
const PNG_HEIGHT = 360

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])
  bytes.set(new TextEncoder().encode("IHDR"), 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

let overlay: Scratch
let overlayDir: string
let mock: MockService

beforeAll(async () => {
  overlay = await scratchDir(`/tmp/iter8-w${WORKER}-overlay-`)
  overlayDir = overlay.path
  await mkdir(join(overlayDir, "fonts"))
  await Bun.write(join(overlayDir, "fonts/probe.woff2"), FONT)
  await Bun.write(join(overlayDir, "overlay.js"), "export function mount() { return () => {} }\n")
})

async function start(options: Partial<Parameters<typeof startMockService>[0]> = {}) {
  mock = await startMockService({ folder: fixtureDir("static"), overlayDir, pairing, ...options })
  return mock
}

afterEach(async () => {
  await mock?.stop()
})

afterAll(async () => {
  await overlay?.dispose()
})

type Call = { body?: unknown; bytes?: Uint8Array<ArrayBuffer>; headers?: Record<string, string> }

async function api(method: string, path: string, { body, bytes, headers = {} }: Call = {}) {
  return await mock.app.request(mock.pageUrl(path), {
    method,
    headers: {
      [TOKEN_HEADER]: mock.token,
      origin: mock.origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(bytes === undefined ? {} : { body: bytes }),
  })
}

async function createDraft() {
  const response = await api("POST", OVERLAY_ROUTES.createDraft.path, { body: draftBody })
  expect(response.status).toBe(201)
  return OVERLAY_ROUTES.createDraft.response.parse(await response.json()).id
}

function send(
  noteIds: string[],
  { key = crypto.randomUUID(), generation = pairing.generation as number } = {},
) {
  return api("POST", OVERLAY_ROUTES.send.path, {
    body: { idempotencyKey: key, noteIds, generation },
  }).then(async (response) => OVERLAY_ROUTES.send.response.parse(await response.json()))
}

const withParams = (path: string) => path.replace(":noteId", "N1").replace(":ref", "missing")

describe("overlay routes", () => {
  test("every route answers with a body its protocol schema accepts", async () => {
    await start({ liveSessions: [liveSession] })
    let noteId = ""
    let ref = ""
    const cases: Record<keyof typeof OVERLAY_ROUTES, () => Promise<Response>> = {
      hello: () =>
        api("POST", OVERLAY_ROUTES.hello.path, {
          body: {
            protocolVersion: PROTOCOL_VERSION,
            pageId: mock.pageId,
            machineId: mock.machineId,
          },
        }),
      whoami: () => api("GET", OVERLAY_ROUTES.whoami.path),
      createDraft: async () => {
        const response = await api("POST", OVERLAY_ROUTES.createDraft.path, { body: draftBody })
        noteId = (await response.clone().json()).id
        return response
      },
      listDrafts: () => api("GET", OVERLAY_ROUTES.listDrafts.path),
      putDraft: () =>
        api("PUT", OVERLAY_ROUTES.putDraft.path.replace(":noteId", noteId), {
          body: { ...draftBody, body: "Edited." },
        }),
      deleteDraft: async () => {
        const doomed = await createDraft()
        return api("DELETE", OVERLAY_ROUTES.deleteDraft.path.replace(":noteId", doomed))
      },
      uploadScreenshot: async () => {
        const response = await api("POST", OVERLAY_ROUTES.uploadScreenshot.path, {
          bytes: png(PNG_WIDTH, PNG_HEIGHT),
          headers: { "content-type": "image/png" },
        })
        ref = (await response.clone().json()).ref
        return response
      },
      getScreenshot: () => api("GET", OVERLAY_ROUTES.getScreenshot.path.replace(":ref", ref)),
      symbolicate: () => api("POST", OVERLAY_ROUTES.symbolicate.path, { body: sourceLead }),
      send: () =>
        api("POST", OVERLAY_ROUTES.send.path, {
          body: { idempotencyKey: crypto.randomUUID(), noteIds: [noteId], generation: 2 },
        }),
      listRounds: () => api("GET", OVERLAY_ROUTES.listRounds.path),
      listSessions: () => api("GET", OVERLAY_ROUTES.listSessions.path),
      attach: () => api("POST", OVERLAY_ROUTES.attach.path, { body: { owner: liveSession.owner } }),
      getPrefs: () => api("GET", OVERLAY_ROUTES.getPrefs.path),
      savePrefs: () => api("PUT", OVERLAY_ROUTES.savePrefs.path, { body: prefs }),
    }

    for (const [name, call] of Object.entries(cases)) {
      const route = OVERLAY_ROUTES[name as keyof typeof OVERLAY_ROUTES]
      const response = await call()
      expect({ name, ok: response.ok }).toEqual({ name, ok: true })
      if (route.response === null) {
        expect(response.headers.get("content-type")).toBe("image/png")
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(png(PNG_WIDTH, PNG_HEIGHT))
        continue
      }
      const parsed = route.response.safeParse(await response.json())
      expect({ name, error: parsed.error?.message }).toEqual({ name, error: undefined })
    }

    const listed = await api("GET", OVERLAY_ROUTES.listRounds.path)
    expect(await listed.json()).toEqual([
      expect.objectContaining({ noteCount: 1, stage: "queued", owner: liveSession.owner }),
    ])
  })

  test("a request without the page token or from a foreign Origin is refused", async () => {
    await start()
    for (const [name, route] of Object.entries(OVERLAY_ROUTES)) {
      const path = withParams(route.path)
      const body = route.method === "GET" || route.method === "DELETE" ? undefined : {}
      const noToken = await api(route.method, path, { body, headers: { [TOKEN_HEADER]: "" } })
      expect({ name, status: noToken.status }).toEqual({ name, status: 401 })
      const foreign = await api(route.method, path, {
        body,
        headers: { origin: "http://elsewhere.localhost:1" },
      })
      expect({ name, status: foreign.status }).toEqual({ name, status: 403 })
      const preflight = await api("OPTIONS", path, {
        headers: {
          origin: "http://elsewhere.localhost:1",
          "access-control-request-method": route.method,
        },
      })
      expect({ name, status: preflight.status }).toEqual({ name, status: 403 })
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
    }
    const badToken = await api("POST", OVERLAY_ROUTES.hello.path, {
      body: { protocolVersion: PROTOCOL_VERSION, pageId: mock.pageId, machineId: mock.machineId },
      headers: { [TOKEN_HEADER]: "x".repeat(43) },
    })
    expect(OVERLAY_ROUTES.hello.response.parse(await badToken.json())).toMatchObject({
      outcome: "refused",
      reason: "bad-token",
    })
    expect(mock.draft()).toEqual([])
  })

  test("a same-origin GET without an Origin header is accepted only on Sec-Fetch-Site same-origin", async () => {
    await start()
    const unvouched = await mock.app.request(mock.pageUrl(OVERLAY_ROUTES.whoami.path), {
      headers: { [TOKEN_HEADER]: mock.token },
    })
    expect(unvouched.status).toBe(403)
    const vouched = await mock.app.request(mock.pageUrl(OVERLAY_ROUTES.whoami.path), {
      headers: { [TOKEN_HEADER]: mock.token, "sec-fetch-site": "same-origin" },
    })
    expect(await vouched.json()).toEqual({ machineId: mock.machineId, pageId: mock.pageId })
    const crossSite = await mock.app.request(mock.pageUrl(OVERLAY_ROUTES.whoami.path), {
      headers: { [TOKEN_HEADER]: mock.token, "sec-fetch-site": "cross-site" },
    })
    expect(crossSite.status).toBe(403)
  })

  test("hello with another protocol version is refused as a version mismatch", async () => {
    await start()
    const response = await api("POST", OVERLAY_ROUTES.hello.path, {
      body: {
        protocolVersion: PROTOCOL_VERSION + 1,
        pageId: mock.pageId,
        machineId: mock.machineId,
      },
    })
    expect(OVERLAY_ROUTES.hello.response.parse(await response.json())).toEqual({
      outcome: "refused",
      reason: "version-mismatch",
      expected: { protocolVersion: PROTOCOL_VERSION, machineId: mock.machineId },
    })
  })

  test("hello returns the seeded page state", async () => {
    await start({ liveSessions: [liveSession], prefs })
    const response = await api("POST", OVERLAY_ROUTES.hello.path, {
      body: { protocolVersion: PROTOCOL_VERSION, pageId: mock.pageId, machineId: mock.machineId },
    })
    const hello = OVERLAY_ROUTES.hello.response.parse(await response.json())
    expect(hello).toMatchObject({
      outcome: "accepted",
      page: { id: mock.pageId, origin: mock.origin, pairing: { owner: pairing.owner } },
      state: { drafts: [], rounds: [], pairing, liveSessions: [liveSession], prefs },
    })
  })

  test("sending twice with one idempotency key yields one round", async () => {
    await start()
    const noteId = await createDraft()
    const key = crypto.randomUUID()
    const first = await send([noteId], { key })
    const second = await send([noteId], { key })
    expect(first.outcome).toBe("accepted")
    expect(second).toEqual(first)
    expect(mock.rounds()).toHaveLength(1)
    expect(mock.draft()).toEqual([])
  })

  test("failNextSend refuses exactly the next send and keeps the drafts", async () => {
    await start()
    const noteId = await createDraft()
    mock.failNextSend({ outcome: "refused", reason: "session-gone", pairing: null })
    const refused = await send([noteId])
    expect(refused).toEqual({ outcome: "refused", reason: "session-gone", pairing: null })
    expect(mock.draft().map((note) => note.id)).toEqual([noteId])
    expect(mock.rounds()).toEqual([])
    const accepted = await send([noteId])
    expect(accepted.outcome).toBe("accepted")
    expect(mock.rounds()).toHaveLength(1)
    expect(mock.draft()).toEqual([])
  })

  test("a stale pairing generation is always refused", async () => {
    await start()
    const noteId = await createDraft()
    await fc.assert(
      fc.asyncProperty(
        fc.nat().filter((generation) => generation !== pairing.generation),
        async (generation) => {
          const result = await send([noteId], { generation })
          expect(result).toMatchObject({ outcome: "refused", reason: "stale-generation" })
        },
      ),
      { numRuns: 50 },
    )
    expect(mock.rounds()).toEqual([])
    expect(mock.draft().map((note) => note.id)).toEqual([noteId])
  })

  test("attach refuses an owner that is not a live session and requeues on a live one", async () => {
    const elsewhere = LiveSession.parse({ ...liveSession, owner: "own_elsewhere" })
    await start({ liveSessions: [elsewhere] })
    const sent = await send([await createDraft()])
    const attach = () =>
      api("POST", OVERLAY_ROUTES.attach.path, { body: { owner: liveSession.owner } }).then(
        async (response) => OVERLAY_ROUTES.attach.response.parse(await response.json()),
      )
    expect(await attach()).toEqual({
      outcome: "refused",
      reason: "not-live",
      sessions: [elsewhere],
    })

    mock.setLiveSessions([liveSession])
    const accepted = await attach()
    expect(accepted).toMatchObject({
      outcome: "accepted",
      pairing: { owner: liveSession.owner, generation: pairing.generation + 1 },
      requeued: [sent.outcome === "accepted" ? sent.round.id : "none"],
    })
    expect(mock.rounds()).toEqual([
      expect.objectContaining({
        owner: liveSession.owner,
        state: expect.objectContaining({ stage: "queued", requeuedAt: expect.any(String) }),
      }),
    ])
  })

  test("savePrefs, getPrefs and prefs() agree", async () => {
    await start()
    const saved = OverlayPrefs.parse({ ...prefs, theme: "dark", dock: "tl", collapsed: true })
    const put = await api("PUT", OVERLAY_ROUTES.savePrefs.path, { body: saved })
    expect(await put.json()).toEqual(saved)
    const got = await api("GET", OVERLAY_ROUTES.getPrefs.path)
    expect(await got.json()).toEqual(saved)
    expect(mock.prefs()).toEqual(saved)
  })
})

describe("folder and assets", () => {
  test("a font file in the overlay directory is served under the asset prefix without a token", async () => {
    await start()
    const response = await mock.app.request(mock.pageUrl(`${ASSET_PREFIX}fonts/probe.woff2`))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("font/woff2")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(FONT)
    const traversal = await mock.app.request(mock.pageUrl(`${ASSET_PREFIX}..%2F..%2Fetc%2Fpasswd`))
    expect(traversal.status).toBe(404)
  })

  test("an HTML page from the folder carries the boot script before its closing body tag", async () => {
    await start()
    const html = await (await mock.app.request(mock.pageUrl("/"))).text()
    const boot = html.indexOf(
      `<script type="module">import { mount } from "${ASSET_PREFIX}overlay.js"`,
    )
    expect(boot).toBeGreaterThan(html.indexOf('data-source-target="card"'))
    expect(boot).toBeLessThan(html.lastIndexOf("</body>"))
    expect(html.slice(boot)).toContain(mock.token)
    const other = await mock.app.request(`http://otherpage.localhost:${mock.port}/`)
    expect(other.status).toBe(404)
  })
})

describe("live socket", () => {
  // lib.dom's WebSocket type hides Bun's constructor option for request headers.
  function connect(origin: string, protocols: string[]) {
    const socket = new WebSocket(`ws://127.0.0.1:${mock.port}${LIVE_PATH}`, {
      headers: { host: new URL(mock.origin).host, origin },
      protocols,
    } as unknown as string[])
    const received: unknown[] = []
    socket.onmessage = (event) => received.push(JSON.parse(String(event.data)))
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error("live socket refused"))
    })
    return { socket, received, opened }
  }

  test("a pushed server message reaches a connected socket and a client ping is recorded", async () => {
    await start()
    const { socket, received, opened } = connect(mock.origin, liveSubprotocols(mock.token))
    await opened
    expect(socket.protocol).toBe(`iter8.v${PROTOCOL_VERSION}`)
    mock.push({ type: "reload" })
    await waitFor("the reload message", async () => (received.length > 0 ? true : null))
    expect(received.map((message) => ServerMessage.parse(message))).toEqual([{ type: "reload" }])
    const at = new Date().toISOString()
    socket.send(JSON.stringify({ type: "ping", at }))
    await waitFor("the ping", async () => (mock.clientMessages().length > 0 ? true : null))
    expect(mock.clientMessages()).toEqual([{ type: "ping", at }])
    socket.close()
  })

  test("a socket without the token subprotocol or from a foreign Origin is refused", async () => {
    await start()
    const [version] = liveSubprotocols(mock.token)
    await expect(connect(mock.origin, [version ?? ""]).opened).rejects.toThrow("refused")
    await expect(
      connect("http://elsewhere.localhost:1", liveSubprotocols(mock.token)).opened,
    ).rejects.toThrow("refused")
  })
})
