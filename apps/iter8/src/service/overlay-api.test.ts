import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ASSET_PREFIX,
  AttachResult,
  ChatSetting,
  DraftBody,
  HelloResult,
  LANDING_PATH,
  LiveSessionList,
  liveSubprotocols,
  MachineId,
  MessagePage,
  Note,
  OVERLAY_PREFIX,
  OVERLAY_ROUTES,
  OverlayBoot,
  OverlayPrefs,
  OwnerId,
  PageToken,
  Pairing,
  PairingGeneration,
  PostMessageRequest,
  PostMessageResult,
  PROTOCOL_VERSION,
  ResolvedSourceLead,
  RoundSummaryList,
  Screenshot,
  SendNowResult,
  SendResult,
  ServerMessage,
  SOURCE_BUNDLE_PATH,
  type SourceLead,
  TOKEN_HEADER,
  Whoami,
} from "@iter8/protocol"
import { createAgentNotes } from "../pages/agent-notes"
import { createPages, type PageRecord } from "../pages/pages"
import { createPrefs } from "../pages/prefs"
import { createScreenshots } from "../pages/screenshots"
import { createOwners } from "../pairing/owners"
import { createInbox } from "../rounds/inbox"
import { openStore } from "../store/db"
import type { SymbolicateScope } from "../symbolicate/symbolicate"
import { createLiveHub } from "./live"
import {
  authorizeLive,
  bootFor,
  createOverlayApi,
  type OverlayApiDeps,
  type OverlayEnv,
  pageChat,
  pagePairing,
} from "./overlay-api"
import { createWaiters } from "./waiters"

const databases: Database[] = []
const directories: string[] = []
const waitersToCancel: ReturnType<typeof createWaiters>[] = []

afterEach(async () => {
  for (const waiters of waitersToCancel.splice(0)) waiters.cancelAll()
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

const R = OVERLAY_ROUTES
const machineId = MachineId.parse("machine-under-test")
const png = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=",
    "base64",
  ),
)
const sessionA = { pid: 4821, startedAt: "start-a", label: "session-a" }
const sessionB = { pid: 5930, startedAt: "start-b", label: "session-b" }
const jsonHeader = { "content-type": "application/json" }
const TABLES = [
  "meta",
  "owners",
  "pages",
  "page_upstreams",
  "retired_labels",
  "notes",
  "rounds",
  "round_keys",
  "announcements",
  "screenshots",
  "prefs",
  "messages",
  "page_chat",
  "owner_focus",
]

function draftBody(body: string) {
  return DraftBody.parse({
    intent: "fix",
    body,
    target: {
      kind: "region",
      box: { x: 0, y: 10, width: 200, height: 40 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
    },
    anchorStatus: "anchored",
  })
}

const reactLead: SourceLead = {
  confidence: "exact",
  framework: "react",
  build: "vite",
  component: "Card",
  frames: [{ kind: "source", file: "src/Card.jsx", line: 4, column: 3 }],
}

type Fake = { sent: ServerMessage[]; closed: boolean }

async function setup(now = () => new Date(Date.UTC(2026, 9, 9, 18, 0, 0))) {
  const db = openStore(":memory:")
  databases.push(db)
  const scratch = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(scratch)
  const folder = join(scratch, "site")
  const overlayDir = join(scratch, "overlay")
  await mkdir(folder)
  await mkdir(overlayDir)
  await writeFile(join(overlayDir, "overlay.js"), "export function mount() {}\n")

  const starts = new Map<number, string>([
    [sessionA.pid, sessionA.startedAt],
    [sessionB.pid, sessionB.startedAt],
  ])

  const owners = createOwners(db, { processStart: (pid) => starts.get(pid) ?? null, now })
  const tokens = ["a", "b"].map((letter) => PageToken.parse(letter.repeat(43)))
  const pages = createPages(db, {
    randomToken: () => {
      const token = tokens.shift()
      if (!token) throw new Error("Out of test tokens")
      return token
    },
  })
  const waiters = createWaiters()
  waitersToCancel.push(waiters)
  const resolved: Array<{ lead: SourceLead; scope: SymbolicateScope }> = []
  const symbolicated = ResolvedSourceLead.parse({
    confidence: "exact",
    framework: "react",
    component: "Card",
    file: "src/Card.jsx",
    line: 4,
    column: 3,
  })
  const deps: OverlayApiDeps = {
    pages,
    owners,
    inbox: createInbox(db, {
      now,
      ownerState: (ownerId) => owners.state(ownerId),
      pairing: (pageId) => {
        const record = pages.get(pageId)
        return record && pagePairing(deps, record)
      },
    }),
    agentNotes: createAgentNotes(db, { now }),
    screenshots: createScreenshots(db, { now }),
    prefs: createPrefs(db),
    live: createLiveHub(),
    waiters,
    symbolicator: {
      async resolve(lead, scope) {
        resolved.push({ lead, scope })
        return symbolicated
      },
    },
    overlayDir,
    machineId,
    machineName: "devbox",
    serviceVersion: "9.9.9-test",
  }
  const larkspur = pages.open({
    target: {
      kind: "server",
      upstream: "http://127.0.0.1:5173",
      extras: ["http://127.0.0.1:5174"],
    },
    projectRoot: "/project",
    poolPorts: [3990, 3991],
  })
  const yarrow = pages.open({
    target: { kind: "folder", root: folder },
    projectRoot: "/project",
    poolPorts: [3990, 3991],
  })
  const ownerA = owners.register({ ...sessionA, source: "startup", agent: "claude", cwd: "/a" })
  const ownerB = owners.register({ ...sessionB, source: "startup", agent: "codex", cwd: "/b" })

  const app = createOverlayApi(deps)

  function envFor(record: PageRecord, port?: number): OverlayEnv["Bindings"] {
    const origin = new URL(record.page.origin)
    const listenerPort = port ?? Number(origin.port)
    return {
      match: pages.match(origin.hostname, listenerPort),
      pageOrigin: `http://${origin.hostname}:${listenerPort}`,
    }
  }

  type Call = {
    page?: PageRecord
    params?: Record<string, string>
    query?: Record<string, string>
    body?: unknown
    raw?: Uint8Array<ArrayBuffer>
    method?: string
    headers?: Record<string, string>
    omit?: string[]
    env?: OverlayEnv["Bindings"]
  }

  function call(route: (typeof R)[keyof typeof R], options: Call = {}) {
    const record = pages.get(options.page?.page.id ?? larkspur.page.id)
    if (!record) throw new Error("Unknown test page")
    let path: string = route.path
    for (const [name, value] of Object.entries(options.params ?? {})) {
      path = path.replace(`:${name}`, encodeURIComponent(value))
    }
    if (options.query) path += `?${new URLSearchParams(options.query)}`
    const headers = new Headers({ origin: record.page.origin, [TOKEN_HEADER]: record.token })
    if (options.body !== undefined) headers.set("content-type", "application/json")
    for (const name of options.omit ?? []) headers.delete(name)
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value)
    const body = options.raw ?? (options.body === undefined ? null : JSON.stringify(options.body))
    return app.request(
      path,
      { method: options.method ?? route.method, headers, body },
      options.env ?? envFor(record),
    )
  }

  function socket(record: PageRecord): Fake {
    const fake: Fake = { sent: [], closed: false }
    deps.live.attach(record.page.id, {
      send: (data) => fake.sent.push(ServerMessage.parse(JSON.parse(data))),
      close: () => {
        fake.closed = true
      },
    })
    return fake
  }

  const snapshot = () =>
    TABLES.map((table) => db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())

  return {
    db,
    deps,
    app,
    pages,
    owners,
    waiters,
    starts,
    larkspur,
    yarrow,
    folder,
    ownerA: ownerA.owner,
    ownerB: ownerB.owner,
    resolved,
    symbolicated,
    envFor,
    call,
    socket,
    snapshot,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

async function createDraft(t: Setup, body: string, page?: PageRecord) {
  const response = await t.call(R.createDraft, {
    body: draftBody(body),
    ...(page ? { page } : {}),
  })
  expect(response.status).toBe(201)
  return Note.parse(await response.json())
}

function sendBody(noteIds: string[], generation: number, key = "send-key-0001") {
  return { idempotencyKey: key, noteIds, generation }
}

async function everyRouteCall(t: Setup) {
  const draft = await createDraft(t, "seeded")
  await t.call(R.send, { body: sendBody([draft.id], 1) })
  const stored = t.deps.screenshots.store(t.larkspur.page.id, png)
  if (!stored) throw new Error("Seed screenshot was refused")
  const calls: Record<keyof typeof R, Parameters<Setup["call"]>[1]> = {
    hello: {
      body: { protocolVersion: PROTOCOL_VERSION, pageId: t.larkspur.page.id, machineId },
    },
    whoami: {},
    listDrafts: {},
    createDraft: { body: draftBody("another") },
    putDraft: { params: { noteId: draft.id }, body: draftBody("edited") },
    deleteDraft: { params: { noteId: draft.id } },
    send: { body: sendBody([draft.id], 1) },
    listRounds: {},
    listMessages: {},
    postMessage: {
      body: { idempotencyKey: "chat-key-0001", generation: 1, text: "From the page" },
    },
    getChat: {},
    setChat: { body: { enabled: false } },
    sendNow: { params: { roundId: "R1" } },
    uploadScreenshot: { raw: png },
    getScreenshot: { params: { ref: stored.ref } },
    symbolicate: { body: reactLead },
    listSessions: {},
    attach: { body: { owner: t.ownerB } },
    getPrefs: {},
    savePrefs: {
      body: { theme: "dark", dock: "tl", collapsed: true, pinsVisible: false, coachDone: true },
    },
  }
  return calls
}

function routeNames() {
  return Object.keys(R) as Array<keyof typeof R>
}

test("a request without the page's token, or with another page's, answers 401 and stores nothing", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const calls = await everyRouteCall(t)
  const armed = t.waiters.arm(t.ownerA, 60_000)
  const live = t.socket(t.larkspur)
  const before = t.snapshot()
  for (const name of routeNames()) {
    for (const headers of [{}, { [TOKEN_HEADER]: t.yarrow.token }]) {
      const response = await t.call(R[name], { ...calls[name], omit: [TOKEN_HEADER], headers })
      expect({ name, status: response.status }).toEqual({ name, status: 401 })
      if (name === "hello") {
        expect(R.hello.response.parse(await response.json())).toEqual({
          outcome: "refused",
          reason: "bad-token",
          expected: { protocolVersion: PROTOCOL_VERSION, machineId },
        })
      }
    }
  }
  expect(t.snapshot()).toEqual(before)
  expect(t.waiters.isArmed(t.ownerA)).toBe(true)
  expect(live.sent).toEqual([])
  t.waiters.wake(t.ownerA)
  await armed
})

test("a foreign Origin, or a missing Origin without same-origin fetch metadata, answers 403", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const calls = await everyRouteCall(t)
  const before = t.snapshot()
  const refusals: Array<Pick<NonNullable<Parameters<Setup["call"]>[1]>, "headers" | "omit">> = [
    { headers: { origin: "http://evil.localhost:3990" } },
    { headers: { origin: t.yarrow.page.origin } },
    { headers: { origin: "null", "sec-fetch-site": "same-origin" } },
    { omit: ["origin"], headers: { "sec-fetch-site": "cross-site" } },
    { omit: ["origin"], headers: { "sec-fetch-site": "same-site" } },
    { omit: ["origin"] },
  ]
  for (const name of routeNames()) {
    for (const refusal of refusals) {
      const response = await t.call(R[name], { ...calls[name], ...refusal })
      expect({ name, status: response.status }).toEqual({ name, status: 403 })
    }
  }
  expect(t.snapshot()).toEqual(before)

  const sameOrigin = await t.call(R.whoami, {
    omit: ["origin"],
    headers: { "sec-fetch-site": "same-origin" },
  })
  expect(sameOrigin.status).toBe(200)
})

test("an OPTIONS preflight answers 403 with no Access-Control-Allow header", async () => {
  const t = await setup()
  const before = t.snapshot()
  for (const name of routeNames()) {
    const response = await t.call(R[name], {
      method: "OPTIONS",
      params: { noteId: "N1", ref: "ref" },
      headers: {
        "access-control-request-method": R[name].method,
        "access-control-request-headers": TOKEN_HEADER,
      },
    })
    expect({ name, status: response.status }).toEqual({ name, status: 403 })
    const allow = [...response.headers.keys()].filter((key) =>
      key.startsWith("access-control-allow"),
    )
    expect(allow).toEqual([])
  }
  expect(t.snapshot()).toEqual(before)
})

test("a credential-free OPTIONS preflight answers 403 with no Access-Control-Allow header, whatever the host", async () => {
  const t = await setup()
  const before = t.snapshot()
  const envs = [undefined, { match: null, pageOrigin: t.larkspur.page.origin }]
  for (const name of routeNames()) {
    for (const env of envs) {
      const response = await t.call(R[name], {
        method: "OPTIONS",
        params: { noteId: "N1", ref: "ref" },
        omit: [TOKEN_HEADER, "origin"],
        headers: {
          "access-control-request-method": R[name].method,
          "access-control-request-headers": TOKEN_HEADER,
        },
        ...(env ? { env } : {}),
      })
      expect({ name, status: response.status }).toEqual({ name, status: 403 })
      expect(
        [...response.headers.keys()].filter((key) => key.startsWith("access-control-")),
      ).toEqual([])
    }
  }
  expect(t.snapshot()).toEqual(before)
})

test("a host that matches no page answers 404 to every overlay route", async () => {
  const t = await setup()
  const calls = await everyRouteCall(t)
  const before = t.snapshot()
  for (const name of routeNames()) {
    const response = await t.call(R[name], {
      ...calls[name],
      env: { match: null, pageOrigin: t.larkspur.page.origin },
    })
    expect({ name, status: response.status }).toEqual({ name, status: 404 })
  }
  expect(t.snapshot()).toEqual(before)
})

test("hello refuses a protocol version, machine or page that is not this one, with the expected values", async () => {
  const t = await setup()
  const expected = { protocolVersion: PROTOCOL_VERSION, machineId }
  const hello = { protocolVersion: PROTOCOL_VERSION, pageId: t.larkspur.page.id, machineId }
  const cases = [
    { body: { ...hello, protocolVersion: PROTOCOL_VERSION + 1 }, reason: "version-mismatch" },
    { body: { ...hello, machineId: "some-other-machine" }, reason: "wrong-machine" },
    { body: { ...hello, pageId: t.yarrow.page.id }, reason: "unknown-page" },
  ]
  for (const { body, reason } of cases) {
    const response = await t.call(R.hello, { body })
    expect(response.status).toBe(200)
    expect(R.hello.response.parse(await response.json())).toEqual({
      outcome: "refused",
      reason,
      expected,
    } as HelloResult)
  }
  expect((await t.call(R.hello, { body: { pageId: t.larkspur.page.id } })).status).toBe(400)
  expect(
    (await t.call(R.hello, { raw: new TextEncoder().encode("{"), headers: jsonHeader })).status,
  ).toBe(400)
})

test("an accepted hello returns the page with its drafts, rounds, agent notes, pairing, sessions and prefs", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const kept = await createDraft(t, "keep this draft")
  const sent = await createDraft(t, "send this one")
  t.owners.pairPage(t.yarrow.page.id, t.ownerB)
  await createDraft(t, "yarrow's kept draft", t.yarrow)
  const yarrowSent = await createDraft(t, "yarrow's sent draft", t.yarrow)
  const yarrowRound = await t.call(R.send, {
    page: t.yarrow,
    body: sendBody([yarrowSent.id], 1, "yarrow-key-0001"),
  })
  expect(yarrowRound.status).toBe(200)
  t.deps.agentNotes.add(t.yarrow.page.id, {
    author: { kind: "agent", owner: t.ownerB, name: "session-b", agent: "codex" },
    intent: "fix",
    body: "Yarrow's agent note",
    at: ["body"],
  })
  const sendResponse = await t.call(R.send, { body: sendBody([sent.id], 1) })
  const accepted = SendResult.parse(await sendResponse.json())
  if (accepted.outcome !== "accepted") throw new Error("Expected the seed round to be accepted")
  const agentNote = t.deps.agentNotes.add(t.larkspur.page.id, {
    author: { kind: "agent", owner: t.ownerA, name: "session-a", agent: "claude" },
    intent: "question",
    body: "Is this the card you meant?",
    at: ["main", ".card"],
  })
  const prefs = { theme: "dark", dock: "tl", collapsed: true, pinsVisible: false, coachDone: true }
  expect((await t.call(R.savePrefs, { body: prefs })).status).toBe(200)
  const waiting = t.waiters.arm(t.ownerA, 60_000)

  const response = await t.call(R.hello, {
    body: { protocolVersion: PROTOCOL_VERSION, pageId: t.larkspur.page.id, machineId },
  })
  expect(response.status).toBe(200)
  const liveA = { owner: t.ownerA, agent: "claude", process: sessionA, cwd: "/a" }
  const liveB = { owner: t.ownerB, agent: "codex", process: sessionB, cwd: "/b" }
  expect(R.hello.response.parse(await response.json())).toEqual(
    HelloResult.parse({
      outcome: "accepted",
      protocolVersion: PROTOCOL_VERSION,
      serviceVersion: "9.9.9-test",
      machineId,
      machineName: "devbox",
      page: {
        ...t.larkspur.page,
        pairing: { owner: t.ownerA, generation: 1 },
      },
      state: {
        drafts: [kept],
        rounds: [accepted.round],
        agentNotes: [agentNote],
        pairing: {
          ...liveA,
          generation: 1,
          state: { status: "live" },
          relabelPending: false,
          listener: "armed",
        },
        liveSessions: [
          { ...liveA, state: { status: "live" } },
          { ...liveB, state: { status: "live" } },
        ],
        prefs,
      },
    }),
  )
  t.waiters.wake(t.ownerA)
  await waiting
})

test("sending to a paired owner wakes its armed waiter and pushes the round to the page's sockets", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const first = await createDraft(t, "first")
  const second = await createDraft(t, "second")
  const larkspurSocket = t.socket(t.larkspur)
  const secondLarkspurSocket = t.socket(t.larkspur)
  const yarrowSocket = t.socket(t.yarrow)
  const waiting = t.waiters.arm(t.ownerA, 60_000)
  const other = t.waiters.arm(t.ownerB, 60_000)

  const response = await t.call(R.send, { body: sendBody([first.id, second.id], 1) })
  expect(response.status).toBe(200)
  const result = R.send.response.parse(await response.json())
  if (result.outcome !== "accepted") throw new Error(`Expected accepted, got ${result.reason}`)
  expect(result.round).toMatchObject({
    id: "R1",
    pageId: t.larkspur.page.id,
    owner: t.ownerA,
    state: { stage: "queued", idempotencyKey: "send-key-0001" },
  })
  expect(result.round.notes.map((note) => [note.id, note.body])).toEqual([
    [first.id, "first"],
    [second.id, "second"],
  ])
  expect(await waiting).toBe("woken")
  expect(t.waiters.isArmed(t.ownerB)).toBe(true)
  expect(larkspurSocket.sent).toEqual([{ type: "round", round: result.round }])
  expect(secondLarkspurSocket.sent).toEqual([{ type: "round", round: result.round }])
  expect(yarrowSocket.sent).toEqual([])

  const drafts = await t.call(R.listDrafts)
  expect(R.listDrafts.response.parse(await drafts.json())).toEqual([])
  const rounds = await t.call(R.listRounds)
  expect(RoundSummaryList.parse(await rounds.json())).toEqual([
    {
      id: result.round.id,
      pageId: t.larkspur.page.id,
      owner: t.ownerA,
      stage: "queued",
      noteCount: 2,
      doneCount: 0,
      answeredCount: 0,
    },
  ])
  const yarrowRounds = await t.call(R.listRounds, { page: t.yarrow })
  expect(RoundSummaryList.parse(await yarrowRounds.json())).toEqual([])

  const retried = await t.call(R.send, { body: sendBody([first.id, second.id], 1) })
  expect(R.send.response.parse(await retried.json())).toEqual(result)

  t.waiters.wake(t.ownerB)
  await other
})

test("a send naming a note that is not a draft of this page answers 404 and stores nothing", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const mine = await createDraft(t, "mine")
  const theirs = await createDraft(t, "theirs", t.yarrow)
  const before = t.snapshot()
  for (const noteIds of [[mine.id, theirs.id], ["N999"]]) {
    expect((await t.call(R.send, { body: sendBody(noteIds, 1) })).status).toBe(404)
  }
  expect((await t.call(R.send, { body: { noteIds: [mine.id], generation: 1 } })).status).toBe(400)
  expect(t.snapshot()).toEqual(before)
})

test("send refuses an unpaired page, a stale generation and a gone owner, and stores nothing", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const draft = await createDraft(t, "larkspur draft")
  const yarrowDraft = await createDraft(t, "yarrow draft", t.yarrow)
  const live = t.socket(t.larkspur)
  const before = t.snapshot()

  const unpaired = await t.call(R.send, { page: t.yarrow, body: sendBody([yarrowDraft.id], 0) })
  expect(R.send.response.parse(await unpaired.json())).toEqual({
    outcome: "refused",
    reason: "no-pairing",
    pairing: null,
  })

  const stale = await t.call(R.send, { body: sendBody([draft.id], 0) })
  const staleResult = R.send.response.parse(await stale.json())
  expect(staleResult).toMatchObject({ outcome: "refused", reason: "stale-generation" })
  const staleGeneration = staleResult.outcome === "refused" && staleResult.pairing?.generation
  expect(staleGeneration).toBe(PairingGeneration.parse(1))
  expect(t.snapshot()).toEqual(before)

  t.starts.delete(sessionA.pid)
  expect(t.owners.state(t.ownerA)).toEqual({ status: "gone", reason: "crashed" })
  const goneBefore = t.snapshot()
  const gone = await t.call(R.send, { body: sendBody([draft.id], 1) })
  expect(gone.status).toBe(200)
  expect(R.send.response.parse(await gone.json())).toEqual({
    outcome: "refused",
    reason: "session-gone",
    pairing: Pairing.parse({
      owner: t.ownerA,
      agent: "claude",
      process: sessionA,
      cwd: "/a",
      generation: 1,
      state: { status: "gone", reason: "crashed" },
      relabelPending: false,
      listener: "none",
    }),
  })
  expect(t.snapshot()).toEqual(goneBefore)
  expect(live.sent).toEqual([])
})

test("attach to a live session re-pairs only the calling page and requeues its rounds", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.pairPage(t.yarrow.page.id, t.ownerA)
  const draft = await createDraft(t, "orphan me")
  const sent = SendResult.parse(
    await (await t.call(R.send, { body: sendBody([draft.id], 1) })).json(),
  )
  if (sent.outcome !== "accepted") throw new Error("Expected the seed round to be accepted")
  t.starts.delete(sessionA.pid)
  expect(t.owners.state(t.ownerA).status).toBe("gone")
  expect(t.deps.inbox.orphanFor(t.ownerA).map((round) => round.state.stage)).toEqual(["orphaned"])
  const larkspurSocket = t.socket(t.larkspur)
  const yarrowSocket = t.socket(t.yarrow)
  const waiting = t.waiters.arm(t.ownerB, 60_000)

  const response = await t.call(R.attach, { body: { owner: t.ownerB } })
  expect(response.status).toBe(200)
  const result = R.attach.response.parse(await response.json())
  const pairing = Pairing.parse({
    owner: t.ownerB,
    agent: "codex",
    process: sessionB,
    cwd: "/b",
    generation: 2,
    state: { status: "live" },
    relabelPending: false,
    listener: "armed",
  })
  expect(result).toEqual(AttachResult.parse({ outcome: "accepted", pairing, requeued: ["R1"] }))
  expect(await waiting).toBe("woken")

  const pairedTo = (record: PageRecord) => t.pages.get(record.page.id)?.page.pairing
  expect(pairedTo(t.larkspur)).toEqual({ owner: t.ownerB, generation: PairingGeneration.parse(2) })
  expect(pairedTo(t.yarrow)).toEqual({ owner: t.ownerA, generation: PairingGeneration.parse(1) })
  const requeued = t.deps.inbox.round(sent.round.id)
  if (!requeued) throw new Error("The requeued round vanished")
  expect(requeued.owner).toBe(t.ownerB)
  expect(requeued.state.stage).toBe("queued")
  expect(larkspurSocket.sent).toEqual([
    { type: "pairing", pairing },
    { type: "chat", chat: { enabled: true, defaultEnabled: true, reachable: false } },
    { type: "round", round: requeued },
  ])
  expect(yarrowSocket.sent).toEqual([])
})

test("attach refuses a gone or unknown owner with the live sessions and stores nothing", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.starts.delete(sessionA.pid)
  expect(t.owners.state(t.ownerA).status).toBe("gone")
  const live = t.socket(t.larkspur)
  const before = t.snapshot()
  const sessions = LiveSessionList.parse([
    { owner: t.ownerB, agent: "codex", process: sessionB, cwd: "/b", state: { status: "live" } },
  ])
  for (const [owner, reason] of [
    [t.ownerA, "not-live"],
    [OwnerId.parse("o_never_registered"), "unknown-owner"],
  ] as const) {
    const response = await t.call(R.attach, { body: { owner } })
    expect(response.status).toBe(200)
    expect(R.attach.response.parse(await response.json())).toEqual({
      outcome: "refused",
      reason,
      sessions,
    })
  }
  const listed = await t.call(R.listSessions)
  expect(R.listSessions.response.parse(await listed.json())).toEqual(sessions)
  expect(t.snapshot()).toEqual(before)
  expect(live.sent).toEqual([])
})

test("drafts are created, listed, replaced and deleted per page, and unknown ids answer 404", async () => {
  const t = await setup()
  const created = await createDraft(t, "first words")
  expect(created).toMatchObject({
    id: "N1",
    pageId: t.larkspur.page.id,
    author: { kind: "user" },
    resolution: { status: "open" },
    body: "first words",
  })

  const put = await t.call(R.putDraft, {
    params: { noteId: created.id },
    body: { ...draftBody("better words"), intent: "change" },
  })
  expect(put.status).toBe(200)
  const replaced = R.putDraft.response.parse(await put.json())
  expect(replaced).toEqual({ ...created, intent: "change", body: "better words" })

  const listed = await t.call(R.listDrafts)
  expect(R.listDrafts.response.parse(await listed.json())).toEqual([replaced])
  const yarrowList = await t.call(R.listDrafts, { page: t.yarrow })
  expect(R.listDrafts.response.parse(await yarrowList.json())).toEqual([])

  const before = t.snapshot()
  for (const noteId of ["N999", "not-a-note-id"]) {
    expect((await t.call(R.putDraft, { params: { noteId }, body: draftBody("x") })).status).toBe(
      404,
    )
    expect((await t.call(R.deleteDraft, { params: { noteId } })).status).toBe(404)
  }
  const otherPage = { page: t.yarrow, params: { noteId: created.id } }
  expect((await t.call(R.putDraft, { ...otherPage, body: draftBody("x") })).status).toBe(404)
  expect((await t.call(R.deleteDraft, otherPage)).status).toBe(404)
  expect((await t.call(R.createDraft, { body: { body: "no target" } })).status).toBe(400)
  expect(t.snapshot()).toEqual(before)

  const deleted = await t.call(R.deleteDraft, { params: { noteId: created.id } })
  expect(R.deleteDraft.response.parse(await deleted.json())).toEqual({ ok: true })
  expect((await t.call(R.deleteDraft, { params: { noteId: created.id } })).status).toBe(404)
})

test("a PNG upload is stored for its page; a non-PNG body answers 415 and stores nothing", async () => {
  const t = await setup()
  const before = t.snapshot()
  for (const raw of [new TextEncoder().encode("GIF89a not a png"), new Uint8Array()]) {
    expect((await t.call(R.uploadScreenshot, { raw })).status).toBe(415)
  }
  expect(t.snapshot()).toEqual(before)

  const uploaded = await t.call(R.uploadScreenshot, { raw: png })
  expect(uploaded.status).toBe(201)
  const screenshot = Screenshot.parse(await uploaded.json())
  expect(screenshot).toMatchObject({ width: 1, height: 1 })

  const read = await t.call(R.getScreenshot, { params: { ref: screenshot.ref } })
  expect(read.status).toBe(200)
  expect(read.headers.get("content-type")).toBe("image/png")
  expect(new Uint8Array(await read.arrayBuffer())).toEqual(png)

  const params = { ref: screenshot.ref }
  expect((await t.call(R.getScreenshot, { page: t.yarrow, params })).status).toBe(404)
  expect((await t.call(R.getScreenshot, { params: { ref: "missing" } })).status).toBe(404)
  expect((await t.call(R.getScreenshot, { params: { ref: "bad ref!" } })).status).toBe(404)
})

test("symbolicate resolves within the page's project root against the listener's upstream or folder", async () => {
  const t = await setup()
  const primary = await t.call(R.symbolicate, { body: reactLead })
  expect(R.symbolicate.response.parse(await primary.json())).toEqual(t.symbolicated)

  const extraPort = 3991
  const extraOrigin = `http://${t.larkspur.page.id}.localhost:${extraPort}`
  const extra = await t.call(R.symbolicate, {
    body: reactLead,
    headers: { origin: extraOrigin },
    env: t.envFor(t.larkspur, extraPort),
  })
  expect(extra.status).toBe(200)

  await t.call(R.symbolicate, { page: t.yarrow, body: reactLead })
  expect((await t.call(R.symbolicate, { body: { confidence: "exact" } })).status).toBe(400)

  expect(t.resolved).toEqual([
    {
      lead: reactLead,
      scope: {
        projectRoot: "/project",
        pageOrigin: t.larkspur.page.origin,
        upstream: "http://127.0.0.1:5173",
        folderRoot: null,
      },
    },
    {
      lead: reactLead,
      scope: {
        projectRoot: "/project",
        pageOrigin: extraOrigin,
        upstream: "http://127.0.0.1:5174",
        folderRoot: null,
      },
    },
    {
      lead: reactLead,
      scope: {
        projectRoot: "/project",
        pageOrigin: t.yarrow.page.origin,
        upstream: null,
        folderRoot: await realpath(t.folder),
      },
    },
  ])
})

test("whoami names this machine and page; prefs default, then persist what was saved", async () => {
  const t = await setup()
  const whoami = await t.call(R.whoami)
  expect(Whoami.parse(await whoami.json())).toEqual({ machineId, pageId: t.larkspur.page.id })

  const defaults = await t.call(R.getPrefs)
  expect(OverlayPrefs.parse(await defaults.json())).toEqual({
    theme: "auto",
    dock: "br",
    collapsed: false,
    pinsVisible: true,
    coachDone: false,
  })
  const prefs = { theme: "light", dock: "ml", collapsed: false, pinsVisible: true, coachDone: true }
  const saved = await t.call(R.savePrefs, { body: prefs })
  expect(R.savePrefs.response.parse(await saved.json())).toEqual(OverlayPrefs.parse(prefs))
  const reread = await t.call(R.getPrefs, { page: t.yarrow })
  expect(R.getPrefs.response.parse(await reread.json())).toEqual(OverlayPrefs.parse(prefs))
  expect((await t.call(R.savePrefs, { body: { ...prefs, dock: "middle" } })).status).toBe(400)
})

test("overlay assets are served without a token, and a missing source.js answers 404", async () => {
  const t = await setup()
  const noPage = { match: null, pageOrigin: "http://unknown.localhost:3990" }
  const script = await t.app.request(`${ASSET_PREFIX}overlay.js`, {}, noPage)
  expect(script.status).toBe(200)
  expect(script.headers.get("content-type")).toStartWith("text/javascript")
  expect(await script.text()).toBe("export function mount() {}\n")
  expect((await t.app.request(SOURCE_BUNDLE_PATH, {}, noPage)).status).toBe(404)
  expect((await t.app.request(`${ASSET_PREFIX}..%2F..%2Fetc%2Fpasswd`, {}, noPage)).status).toBe(
    404,
  )
})

test("the landing page is served without a token, and its CSP admits exactly its inline script", async () => {
  const t = await setup()
  const response = await t.app.request(LANDING_PATH, {}, { match: null, pageOrigin: "" })
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toStartWith("text/html")
  const html = await response.text()
  const csp = response.headers.get("content-security-policy") ?? ""
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1])
  expect(scripts.length).toBe(1)
  expect(styles.length).toBe(1)
  const hash = (text: string | undefined) =>
    new Bun.CryptoHasher("sha256").update(text ?? "").digest("base64")
  const directives = Object.fromEntries(
    csp.split(";").map((directive) => {
      const [name = "", ...sources] = directive.trim().split(/\s+/)
      return [name, sources]
    }),
  )
  expect(directives["default-src"]).toEqual(["'none'"])
  expect(directives["script-src"]).toEqual([`'sha256-${hash(scripts[0])}'`])
  expect(directives["style-src"]).toEqual([`'sha256-${hash(styles[0])}'`])
  expect(directives["connect-src"]).toEqual(["'self'"])
  expect(html).not.toMatch(/\b(src|href)=/)
  expect(scripts[0]).toContain(JSON.stringify(R.whoami.path))
  expect(scripts[0]).toContain(JSON.stringify(TOKEN_HEADER))
  expect(scripts[0]).toContain('location.replace("/")')
  expect(scripts[0]).toContain("is not the iter8 service that opened this page")
})

test("a live upgrade needs the page Origin, the primary listener and every live subprotocol", async () => {
  const t = await setup()
  const origin = t.larkspur.page.origin
  const offered = liveSubprotocols(t.larkspur.token).join(", ")
  const upgrade = (headers: Record<string, string>) =>
    new Request(`${origin}${OVERLAY_PREFIX}/live`, { headers })
  const primary = t.envFor(t.larkspur).match

  expect(
    authorizeLive(upgrade({ origin, "sec-websocket-protocol": offered }), primary, origin, t.pages),
  ).toEqual({ ok: true, pageId: t.larkspur.page.id, protocol: `iter8.v${PROTOCOL_VERSION}` })

  const refusals: Array<[Request, typeof primary, number]> = [
    [upgrade({ "sec-websocket-protocol": offered }), primary, 403],
    [upgrade({ origin: t.yarrow.page.origin, "sec-websocket-protocol": offered }), primary, 403],
    [upgrade({ origin, "sec-websocket-protocol": offered }), null, 403],
    [upgrade({ origin, "sec-websocket-protocol": offered }), t.envFor(t.larkspur, 3991).match, 403],
    [upgrade({ origin }), primary, 401],
    [upgrade({ origin, "sec-websocket-protocol": `iter8.v${PROTOCOL_VERSION}` }), primary, 401],
    [
      upgrade({ origin, "sec-websocket-protocol": `iter8-token.${t.larkspur.token}` }),
      primary,
      401,
    ],
    [
      upgrade({ origin, "sec-websocket-protocol": liveSubprotocols(t.yarrow.token).join(", ") }),
      primary,
      401,
    ],
    [
      upgrade({
        origin,
        "sec-websocket-protocol": [
          `iter8.v${PROTOCOL_VERSION + 1}`,
          `iter8-token.${t.larkspur.token}`,
        ].join(", "),
      }),
      primary,
      401,
    ],
  ]
  for (const [request, match, status] of refusals) {
    const result = authorizeLive(request, match, origin, t.pages)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(status)
  }
})

test("the boot for a page names its id, token, machine and the overlay's fixed paths", async () => {
  const t = await setup()
  expect(OverlayBoot.parse(bootFor(t.larkspur, machineId, "devbox"))).toEqual({
    protocolVersion: PROTOCOL_VERSION,
    pageId: t.larkspur.page.id,
    machineId,
    machineName: "devbox",
    token: t.larkspur.token,
    apiBase: OVERLAY_PREFIX,
    sourceBundleUrl: SOURCE_BUNDLE_PATH,
  })
})

test("a page's pairing reports the listener armed only while its owner's waiter is armed", async () => {
  const t = await setup()
  expect(pagePairing(t.deps, t.larkspur)).toBeNull()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const paired = t.pages.get(t.larkspur.page.id)
  if (!paired) throw new Error("Page vanished")
  expect(pagePairing(t.deps, paired)?.listener).toBe("none")
  const waiting = t.waiters.arm(t.ownerA, 60_000)
  expect(pagePairing(t.deps, paired)).toMatchObject({
    owner: t.ownerA,
    generation: 1,
    listener: "armed",
    state: { status: "live" },
  })
  t.waiters.wake(t.ownerA)
  await waiting
})

test("an accepted hello for a page with nothing yet has empty collections, no pairing and the default prefs", async () => {
  const t = await setup()
  const response = await t.call(R.hello, {
    page: t.yarrow,
    body: { protocolVersion: PROTOCOL_VERSION, pageId: t.yarrow.page.id, machineId },
  })
  const hello = R.hello.response.parse(await response.json())
  if (hello.outcome !== "accepted") throw new Error("Expected the hello to be accepted")
  expect<unknown>(hello.page).toEqual(t.yarrow.page)
  expect<unknown>(hello.state).toEqual({
    drafts: [],
    rounds: [],
    agentNotes: [],
    pairing: null,
    liveSessions: [
      {
        owner: t.ownerA,
        agent: "claude",
        process: sessionA,
        cwd: "/a",
        state: { status: "live" },
      },
      { owner: t.ownerB, agent: "codex", process: sessionB, cwd: "/b", state: { status: "live" } },
    ],
    prefs: { theme: "auto", dock: "br", collapsed: false, pinsVisible: true, coachDone: false },
  })
})

async function sendDraftOn(t: Setup, page: PageRecord, key: string) {
  const draft = await createDraft(t, key, page)
  const response = await t.call(R.send, { page, body: sendBody([draft.id], 1, key) })
  const result = SendResult.parse(await response.json())
  if (result.outcome !== "accepted") throw new Error(`Send refused: ${result.reason}`)
  return result.round
}

test("attach requeues every round of the calling page, leaves other pages' rounds, and pairs at the next generation each time", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.pairPage(t.yarrow.page.id, t.ownerA)
  const first = await sendDraftOn(t, t.larkspur, "send-key-0001")
  const second = await sendDraftOn(t, t.larkspur, "send-key-0002")
  const elsewhere = await sendDraftOn(t, t.yarrow, "send-key-0003")
  const waiting = t.waiters.arm(t.ownerB, 60_000)

  const attach = async (owner: typeof t.ownerA) => {
    const response = await t.call(R.attach, { body: { owner } })
    const result = R.attach.response.parse(await response.json())
    if (result.outcome !== "accepted") throw new Error(`Attach refused: ${result.reason}`)
    return result
  }
  const ownerOf = (id: string) => t.deps.inbox.summaries({}).find((round) => round.id === id)?.owner

  const toB = await attach(t.ownerB)
  expect<unknown>(toB.pairing.generation).toBe(2)
  expect<unknown>(toB.requeued).toEqual([first.id, second.id])
  expect(await waiting).toBe("woken")
  expect([first.id, second.id, elsewhere.id].map(ownerOf)).toEqual([t.ownerB, t.ownerB, t.ownerA])

  const backToA = await attach(t.ownerA)
  expect<unknown>(backToA.pairing.generation).toBe(3)
  expect<unknown>(backToA.requeued).toEqual([first.id, second.id])
  const again = await attach(t.ownerA)
  expect<unknown>(again.pairing.generation).toBe(4)
  expect<unknown>(again.requeued).toEqual([first.id, second.id])
  expect([first.id, second.id, elsewhere.id].map(ownerOf)).toEqual([t.ownerA, t.ownerA, t.ownerA])
  expect(t.pages.get(t.yarrow.page.id)?.page.pairing).toEqual({
    owner: t.ownerA,
    generation: PairingGeneration.parse(1),
  })
})

test("attach on a page with no rounds pairs it, pushes the pairing and leaves the new owner's armed waiter asleep", async () => {
  const t = await setup()
  const live = t.socket(t.larkspur)
  const waiting = t.waiters.arm(t.ownerB, 60_000)

  const response = await t.call(R.attach, { body: { owner: t.ownerB } })
  const result = R.attach.response.parse(await response.json())
  if (result.outcome !== "accepted") throw new Error(`Attach refused: ${result.reason}`)
  expect(result.requeued).toEqual([])
  expect<unknown>(result.pairing.generation).toBe(1)
  expect(t.waiters.isArmed(t.ownerB)).toBe(true)
  expect(live.sent).toEqual([
    { type: "pairing", pairing: result.pairing },
    { type: "chat", chat: { enabled: true, defaultEnabled: true, reachable: false } },
  ])
  expect(t.deps.inbox.conversation.focus(t.ownerB)).toEqual({
    pageId: t.larkspur.page.id,
    roundId: null,
  })

  t.waiters.wake(t.ownerB)
  expect(await waiting).toBe("woken")
})

test("a body that does not parse is 400 on putDraft and attach, and stores nothing", async () => {
  const t = await setup()
  const draft = await createDraft(t, "keep me")
  const before = t.snapshot()
  const params = { noteId: draft.id }
  for (const body of [{}, { ...draftBody("x"), intent: "shout" }, { body: "no target" }]) {
    expect((await t.call(R.putDraft, { params, body })).status).toBe(400)
  }
  for (const body of [{}, { owner: "" }, { owner: 7 }]) {
    expect((await t.call(R.attach, { body })).status).toBe(400)
  }
  expect(t.snapshot()).toEqual(before)
})

test("an upload that is not a whole PNG answers 415 and stores nothing", async () => {
  const t = await setup()
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  const image = (chunk: string, width: number, height: number, first = signature) => {
    const bytes = new Uint8Array(33)
    bytes.set(first)
    bytes.set(new TextEncoder().encode(chunk), 12)
    const view = new DataView(bytes.buffer)
    view.setUint32(16, width)
    view.setUint32(20, height)
    return bytes
  }
  const before = t.snapshot()
  const bodies = {
    "signature only": new Uint8Array(signature),
    "signature with a short header": new Uint8Array([...signature, ...new Array(15).fill(0)]),
    "another first chunk": image("IDAT", 1, 1),
    "zero width": image("IHDR", 0, 1),
    "zero height": image("IHDR", 1, 0),
    "broken signature": image("IHDR", 1, 1, [137, 80, 78, 71, 13, 10, 26, 11]),
  }
  for (const [name, raw] of Object.entries(bodies)) {
    const response = await t.call(R.uploadScreenshot, { raw })
    expect({ name, status: response.status }).toEqual({ name, status: 415 })
  }
  expect(t.snapshot()).toEqual(before)
  expect((await t.call(R.uploadScreenshot, { raw: image("IHDR", 1, 1) })).status).toBe(201)
})

test("a pairing reports relabelPending once its owner's context was cleared", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const record = t.pages.get(t.larkspur.page.id)
  if (!record) throw new Error("Page vanished")
  expect(pagePairing(t.deps, record)?.relabelPending).toBe(false)

  t.owners.end(sessionA.pid, sessionA.label, "clear")
  expect(pagePairing(t.deps, record)).toMatchObject({
    relabelPending: true,
    state: { status: "live" },
  })
  const response = await t.call(R.hello, {
    body: { protocolVersion: PROTOCOL_VERSION, pageId: t.larkspur.page.id, machineId },
  })
  const hello = R.hello.response.parse(await response.json())
  expect(hello.outcome === "accepted" && hello.state.pairing?.relabelPending).toBe(true)
})

function messageBody(key = "chat-key-0001", generation = 1, text = "From the page") {
  return PostMessageRequest.parse({ idempotencyKey: key, generation, text })
}

async function postMessage(t: Setup, body = messageBody(), page?: PageRecord) {
  const response = await t.call(R.postMessage, { body, ...(page ? { page } : {}) })
  expect(response.status).toBe(200)
  return PostMessageResult.parse(await response.json())
}

test("messages return the newest 30 in numeric order and page backwards without crossing pages", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  for (let id = 1; id <= 35; id++) {
    t.deps.inbox.conversation.post(
      t.larkspur.page.id,
      t.ownerA,
      messageBody(`chat-key-${String(id).padStart(4, "0")}`, 1, `Message ${id}`),
    )
  }
  t.deps.inbox.conversation.post(t.yarrow.page.id, t.ownerA, messageBody("other-page-key"))
  const newest = MessagePage.parse(await (await t.call(R.listMessages)).json())
  expect<unknown>(newest.messages.map((message) => message.id)).toEqual(
    Array.from({ length: 30 }, (_, index) => `M${index + 6}`),
  )
  expect(newest.hasOlder).toBe(true)
  const older = MessagePage.parse(
    await (await t.call(R.listMessages, { query: { before: "M6" } })).json(),
  )
  expect<unknown>(older.messages.map((message) => message.id)).toEqual([
    "M1",
    "M2",
    "M3",
    "M4",
    "M5",
  ])
  expect(older.hasOlder).toBe(false)
  const limited = MessagePage.parse(
    await (await t.call(R.listMessages, { query: { before: "M6", limit: "2" } })).json(),
  )
  expect<unknown>(limited.messages.map((message) => message.id)).toEqual(["M4", "M5"])
  expect(limited.hasOlder).toBe(true)
  const all = MessagePage.parse(
    await (await t.call(R.listMessages, { query: { limit: "100" } })).json(),
  )
  expect(all.messages).toHaveLength(35)
  expect(all.hasOlder).toBe(false)
  expect(
    MessagePage.parse(await (await t.call(R.listMessages, { query: { before: "M1" } })).json()),
  ).toEqual({ messages: [], hasOlder: false })
})

test("invalid message queries and chat bodies answer 400 and store nothing", async () => {
  const t = await setup()
  const before = t.snapshot()
  for (const query of [
    { before: "M0" },
    { before: "R1" },
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { limit: "01" },
  ]) {
    expect((await t.call(R.listMessages, { query })).status).toBe(400)
  }
  for (const body of [{}, { ...messageBody(), text: "" }, { ...messageBody(), generation: -1 }]) {
    expect((await t.call(R.postMessage, { body })).status).toBe(400)
  }
  for (const body of [{}, { enabled: "yes" }]) {
    expect((await t.call(R.setChat, { body })).status).toBe(400)
  }
  expect(t.snapshot()).toEqual(before)
})

test("postMessage is idempotent even after chat is disabled, with no repeated push or wake", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const waiting = t.waiters.armMod(t.ownerA, 60_000)
  const live = t.socket(t.larkspur)
  const body = messageBody("chat-key-0001", 1, "<b>Stored as given</b>\n**message**")
  const accepted = await postMessage(t, body)
  if (accepted.outcome !== "accepted") throw new Error(`Message refused: ${accepted.reason}`)
  expect(await waiting).toBe("woken")
  expect(accepted.message).toMatchObject({
    id: "M1",
    pageId: t.larkspur.page.id,
    roundId: null,
    text: body.text,
    author: {
      kind: "page",
      idempotencyKey: body.idempotencyKey,
      delivery: { status: "queued" },
    },
  })
  expect(live.sent).toEqual([{ type: "message", message: accepted.message }])
  await t.call(R.setChat, { body: { enabled: false } })
  const delivered = t.deps.inbox.conversation.takeQueued(t.ownerA)[0]
  const retriedWait = t.waiters.armMod(t.ownerA, 60_000)
  const before = t.snapshot()
  const pushed = [...live.sent]
  expect<unknown>(
    await postMessage(t, { ...body, generation: PairingGeneration.parse(0), text: "retry" }),
  ).toEqual({ outcome: "accepted", message: delivered })
  expect(t.snapshot()).toEqual(before)
  expect(live.sent).toEqual(pushed)
  t.waiters.cancelAll()
  expect(await retriedWait).toBe("cancelled")
})

test("postMessage refusals follow pairing, generation, session, setting, then mod reachability", async () => {
  const t = await setup()
  const live = t.socket(t.larkspur)
  await t.call(R.setChat, { body: { enabled: false } })
  const assertRefusal = async (reason: string, generation: number) => {
    const before = t.snapshot()
    const result = await postMessage(t, messageBody("refused-chat-key", generation))
    const record = t.pages.get(t.larkspur.page.id)
    if (!record) throw new Error("Page vanished")
    expect<unknown>(result).toEqual({
      outcome: "refused",
      reason,
      chat: { enabled: reason === "unreachable", defaultEnabled: true, reachable: false },
      pairing: pagePairing(t.deps, record),
    })
    expect(t.snapshot()).toEqual(before)
  }
  await assertRefusal("no-pairing", 0)
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.end(sessionA.pid, sessionA.label, "other")
  await assertRefusal("stale-generation", 0)
  await assertRefusal("session-gone", 1)
  t.owners.pairPage(t.larkspur.page.id, t.ownerB)
  await assertRefusal("chat-off", 2)
  const hookWait = t.waiters.arm(t.ownerB, 60_000)
  await t.call(R.setChat, { body: { enabled: true } })
  await assertRefusal("unreachable", 2)
  expect(ChatSetting.parse(await (await t.call(R.getChat)).json())).toEqual({
    enabled: true,
    defaultEnabled: true,
    reachable: false,
  })
  expect(live.sent.every((event) => event.type === "chat")).toBe(true)
  t.waiters.cancelAll()
  expect(await hookWait).toBe("cancelled")
})

test("page chat reports reachable only for a paired living owner with a mod channel", async () => {
  const t = await setup()
  const chat = async () => ChatSetting.parse(await (await t.call(R.getChat)).json())
  expect(await chat()).toEqual({ enabled: true, defaultEnabled: true, reachable: false })
  const waiting = t.waiters.armMod(t.ownerA, 60_000)
  expect((await chat()).reachable).toBe(false)
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.setBusy(t.ownerA, true)
  expect(await chat()).toEqual({ enabled: true, defaultEnabled: true, reachable: true })
  t.owners.end(sessionA.pid, sessionA.label, "other")
  expect((await chat()).reachable).toBe(false)
  t.waiters.cancelAll()
  expect(await waiting).toBe("cancelled")
})

test("setChat persists on the same database across a fresh API and pushes only to its page", async () => {
  const t = await setup()
  const live = t.socket(t.larkspur)
  const elsewhere = t.socket(t.yarrow)
  const saved = await t.call(R.setChat, { body: { enabled: false } })
  const expected = { enabled: false, defaultEnabled: true, reachable: false }
  expect(ChatSetting.parse(await saved.json())).toEqual(expected)
  expect(live.sent).toEqual([{ type: "chat", chat: expected }])
  expect(elsewhere.sent).toEqual([])
  const freshDeps = {
    ...t.deps,
    inbox: createInbox(t.db, {
      now: () => new Date("2026-10-09T18:00:00.000Z"),
      ownerState: (owner) => t.owners.state(owner),
      pairing: (pageId) => {
        const record = t.pages.get(pageId)
        return record && pagePairing(t.deps, record)
      },
    }),
  }
  const fresh = createOverlayApi(freshDeps)
  const response = await fresh.request(
    R.getChat.path,
    { headers: { origin: t.larkspur.page.origin, [TOKEN_HEADER]: t.larkspur.token } },
    t.envFor(t.larkspur),
  )
  expect(ChatSetting.parse(await response.json())).toEqual(expected)
  expect(ChatSetting.parse(await (await t.call(R.getChat, { page: t.yarrow })).json())).toEqual({
    enabled: true,
    defaultEnabled: true,
    reachable: false,
  })
})

test("postMessage attaches the page's newest round and isolates idempotency keys by page", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.pairPage(t.yarrow.page.id, t.ownerA)
  await sendDraftOn(t, t.larkspur, "send-key-0001")
  const newest = await sendDraftOn(t, t.larkspur, "send-key-0002")
  const waiting = t.waiters.armMod(t.ownerA, 60_000)
  const live = t.socket(t.larkspur)
  const elsewhere = t.socket(t.yarrow)
  const first = await postMessage(t)
  expect(first).toMatchObject({ outcome: "accepted", message: { id: "M1", roundId: newest.id } })
  expect(await waiting).toBe("woken")
  expect(live.sent).toHaveLength(1)
  expect(elsewhere.sent).toEqual([])
  const second = await postMessage(t, messageBody(), t.yarrow)
  expect(second).toMatchObject({ outcome: "accepted", message: { id: "M2", roundId: null } })
})

test("sendNow sets and preserves sendNowAt, pushes its round and leaves a busy owner's waiter asleep", async () => {
  let time = Date.parse("2026-10-09T18:00:00.000Z")
  const t = await setup(() => new Date(time))
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  const round = await sendDraftOn(t, t.larkspur, "send-key-0001")
  t.owners.setBusy(t.ownerA, true)
  const waiting = t.waiters.armMod(t.ownerA, 60_000)
  const live = t.socket(t.larkspur)
  const elsewhere = t.socket(t.yarrow)
  for (let retry = 0; retry < 2; retry++) {
    const response = await t.call(R.sendNow, { params: { roundId: round.id } })
    expect(response.status).toBe(200)
    const result = SendNowResult.parse(await response.json())
    expect<unknown>(result).toEqual({
      outcome: "accepted",
      round: { ...round, state: { ...round.state, sendNowAt: "2026-10-09T18:00:00.000Z" } },
    })
    expect(t.deps.inbox.round(round.id)?.state).toMatchObject({
      stage: "queued",
      sendNowAt: "2026-10-09T18:00:00.000Z",
    })
    time += 60_000
  }
  expect(live.sent).toHaveLength(2)
  expect(live.sent.every((event) => event.type === "round")).toBe(true)
  expect(elsewhere.sent).toEqual([])
  t.waiters.cancelAll()
  expect(await waiting).toBe("cancelled")
})

test("sendNow refuses unpaired, gone and nonwaiting rounds in order and hides other pages' rounds", async () => {
  const t = await setup()
  t.owners.pairPage(t.larkspur.page.id, t.ownerA)
  t.owners.pairPage(t.yarrow.page.id, t.ownerA)
  const round = await sendDraftOn(t, t.larkspur, "send-key-0001")
  const elsewhere = await sendDraftOn(t, t.yarrow, "send-key-0002")
  const live = t.socket(t.larkspur)
  const assertRefusal = async (reason: string) => {
    const before = t.snapshot()
    const response = await t.call(R.sendNow, { params: { roundId: round.id } })
    expect(response.status).toBe(200)
    expect<unknown>(SendNowResult.parse(await response.json())).toEqual({
      outcome: "refused",
      reason,
      round: t.deps.inbox.round(round.id),
    })
    expect(t.snapshot()).toEqual(before)
  }
  for (const roundId of ["bad", "R0", "R999", elsewhere.id]) {
    expect((await t.call(R.sendNow, { params: { roundId } })).status).toBe(404)
  }
  t.deps.inbox.announce(t.ownerA, sessionA.label, [round.id])
  await assertRefusal("not-waiting")
  t.deps.inbox.claim(round.id)
  await assertRefusal("not-waiting")
  t.owners.end(sessionA.pid, sessionA.label, "other")
  await assertRefusal("session-gone")
  t.deps.inbox.orphanFor(t.ownerA)
  const orphan = await t.call(R.sendNow, { page: t.yarrow, params: { roundId: elsewhere.id } })
  expect(SendNowResult.parse(await orphan.json())).toMatchObject({
    outcome: "refused",
    reason: "session-gone",
    round: { state: { stage: "orphaned" } },
  })
  t.db.query("UPDATE pages SET owner_id = NULL WHERE id = ?").run(t.larkspur.page.id)
  await assertRefusal("no-pairing")
  expect(live.sent).toEqual([])
})

test("attach resets an owner's round focus and pushes chat using the attached mod's reachability", async () => {
  const t = await setup()
  t.owners.pairPage(t.yarrow.page.id, t.ownerB)
  const round = await sendDraftOn(t, t.yarrow, "send-key-0001")
  t.deps.inbox.claim(round.id)
  const waiting = t.waiters.armMod(t.ownerB, 60_000)
  const live = t.socket(t.larkspur)
  const response = await t.call(R.attach, { body: { owner: t.ownerB } })
  expect(AttachResult.parse(await response.json()).outcome).toBe("accepted")
  expect(t.deps.inbox.conversation.focus(t.ownerB)).toEqual({
    pageId: t.larkspur.page.id,
    roundId: null,
  })
  expect(live.sent[1]).toEqual({
    type: "chat",
    chat: { enabled: true, defaultEnabled: true, reachable: true },
  })
  const record = t.pages.get(t.larkspur.page.id)
  if (!record) throw new Error("Page vanished")
  expect(pageChat(t.deps, record)).toEqual({ enabled: true, defaultEnabled: true, reachable: true })
  t.waiters.cancelAll()
  expect(await waiting).toBe("cancelled")
})

type LandingRun = {
  replaced: string[]
  status: string
  fetched: Array<{ url: string; headers: unknown }>
}

async function runLanding(
  html: string,
  page: { hash: string; port: string },
  respond: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<LandingRun> {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1] ?? ""
  const initial = "Checking"
  const status = { textContent: initial }
  const run: LandingRun = { replaced: [], status: initial, fetched: [] }
  const location = {
    hash: page.hash,
    port: page.port,
    replace: (url: string) => run.replaced.push(url),
  }
  const document = { getElementById: (id: string) => (id === "status" ? status : null) }
  const fetchStub = (url: string, init: { headers: unknown }) => {
    run.fetched.push({ url, headers: init.headers })
    return respond()
  }
  new Function("location", "document", "fetch", script)(location, document, fetchStub)
  for (let tick = 0; tick < 50 && !run.replaced.length && status.textContent === initial; tick++) {
    await Promise.resolve()
  }
  run.status = status.textContent
  return run
}

test("the landing script redirects only when whoami names the machine and page in the fragment, and otherwise names the port", async () => {
  const t = await setup()
  const response = await t.app.request(LANDING_PATH, {}, { match: null, pageOrigin: "" })
  const html = await response.text()
  const fragment = { m: machineId, p: t.larkspur.page.id, t: t.larkspur.token }
  const hash = (parts: Record<string, string>) => `#${new URLSearchParams(parts)}`
  const whoami = (body: unknown) => async () => ({ ok: true, json: async () => body })
  const sameService = whoami({ machineId, pageId: t.larkspur.page.id })
  const refusal =
    "Port 3990 on this computer is not the iter8 service that opened this page. Check the SSH forward for port 3990."

  const matched = await runLanding(html, { hash: hash(fragment), port: "3990" }, sameService)
  expect(matched.replaced).toEqual(["/"])
  expect(matched.status).toBe("Checking")
  expect(matched.fetched).toEqual([
    { url: R.whoami.path, headers: { [TOKEN_HEADER]: t.larkspur.token } },
  ])

  const refused: Array<[string, Awaited<ReturnType<typeof runLanding>>]> = [
    [
      "another machine",
      await runLanding(
        html,
        { hash: hash(fragment), port: "3990" },
        whoami({ machineId: "other", pageId: t.larkspur.page.id }),
      ),
    ],
    [
      "another page",
      await runLanding(
        html,
        { hash: hash(fragment), port: "3990" },
        whoami({ machineId, pageId: t.yarrow.page.id }),
      ),
    ],
    [
      "page id in the machine place",
      await runLanding(
        html,
        { hash: hash(fragment), port: "3990" },
        whoami({ machineId: t.larkspur.page.id, pageId: machineId }),
      ),
    ],
    [
      "a refusing service",
      await runLanding(html, { hash: hash(fragment), port: "3990" }, async () => ({
        ok: false,
        json: async () => ({ machineId, pageId: t.larkspur.page.id }),
      })),
    ],
    [
      "an unreachable service",
      await runLanding(html, { hash: hash(fragment), port: "3990" }, async () => {
        throw new Error("connection refused")
      }),
    ],
  ]
  for (const key of ["m", "p", "t"] as const) {
    const { [key]: _omitted, ...rest } = fragment
    const run = await runLanding(html, { hash: hash(rest), port: "3990" }, sameService)
    expect(run.fetched).toEqual([])
    refused.push([`no ${key} in the fragment`, run])
  }
  refused.push(["no fragment", await runLanding(html, { hash: "", port: "3990" }, sameService)])
  for (const [name, run] of refused) {
    expect({ name, replaced: run.replaced, status: run.status }).toEqual({
      name,
      replaced: [],
      status: refusal,
    })
  }
})
