import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentNoteResult,
  type Capture,
  DoneResult,
  DraftBody,
  IdempotencyKey,
  LANDING_PATH,
  LandingFragment,
  OpenResult,
  OwnerId,
  type PageId,
  PageToken,
  PairingGeneration,
  PairResult,
  PROTOCOL_VERSION,
  type Round,
  RoundsResult,
  ServerMessage,
  ServiceStatus,
  ShowResult,
} from "@iter8/protocol"
import fc from "fast-check"
import { createAgentNotes } from "../pages/agent-notes"
import { createPages, type PageRecord } from "../pages/pages"
import { createScreenshots } from "../pages/screenshots"
import { createOwners } from "../pairing/owners"
import { createInbox } from "../rounds/inbox"
import { openStore, readOrCreateMachineId } from "../store/db"
import { createControlApi } from "./control-api"
import { createLiveHub } from "./live"
import { createWaiters } from "./waiters"

const databases: Database[] = []
const directories: string[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

const projectRoot = "/home/biruk/dev/larkspur"
const devServer = "http://localhost:5173"
const cliPid = 9001

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  const starts = new Map<number, string>([[cliPid, "linux:1:9001"]])
  const now = () => new Date(Date.UTC(2026, 9, 9, 18, 0, 0))
  const owners = createOwners(db, { processStart: (pid) => starts.get(pid) ?? null, now })
  let tokens = 0
  const pages = createPages(db, {
    randomToken: () => PageToken.parse(`token${String(++tokens).padStart(40, "0")}`),
  })
  const waiters = createWaiters()
  const live = createLiveHub()
  const listener = (owner: OwnerId) => (waiters.isArmed(owner) ? "armed" : "none")
  const inbox = createInbox(db, {
    now,
    ownerState: (owner) => owners.state(owner),
    pairing(pageId) {
      const link = pages.get(pageId)?.page.pairing
      return link ? owners.pairing(link.owner, link.generation, listener(link.owner)) : null
    },
  })
  const agentNotes = createAgentNotes(db, { now })
  const screenshots = createScreenshots(db, { now })
  const machineId = readOrCreateMachineId(db)
  const opened: PageRecord[] = []
  const drains: number[] = []
  const app = createControlApi({
    pages,
    owners,
    inbox,
    agentNotes,
    screenshots,
    live,
    waiters,
    status: (owner) =>
      ServiceStatus.parse({
        state: "ready",
        version: "0.1.0",
        build: "source",
        protocolVersion: PROTOCOL_VERSION,
        schemaVersion: 1,
        machineId,
        machineName: "workstation",
        pid: process.pid,
        home: "/home/biruk/.iter8",
        pool: [3990, 3991, 3992, 3993],
        overlay: "present",
        owner: owner && owners.pairing(owner, PairingGeneration.parse(0), listener(owner)),
      }),
    drain: () => drains.push(drains.length + 1),
    onPageOpened: (record) => opened.push(record),
    poolPorts: () => [3990, 3991, 3992, 3993],
    machineId,
  })

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  async function startSession(pid: number, label: string, agent = "claude") {
    const startedAt = `linux:1:${pid}`
    starts.set(pid, startedAt)
    const response = await post("/hook/start", {
      pid,
      label,
      source: "startup",
      agent,
      cwd: projectRoot,
    })
    expect(response.status).toBe(200)
    const { pairing } = PairResult.parse(await response.json())
    return {
      pid,
      label,
      ownerId: pairing.owner,
      // The CLI's own process comes first, as the nearest ancestor that is not an owner.
      identities: [
        { pid: cliPid, startedAt: "linux:1:9001" },
        { pid, startedAt },
      ],
    }
  }
  type Session = Awaited<ReturnType<typeof startSession>>

  async function openServer(session: Session | null, upstream = devServer) {
    const response = await post("/open", {
      target: { kind: "server", upstream },
      upstreams: [],
      identities: session?.identities ?? [],
      owner: null,
      cwd: projectRoot,
    })
    expect(response.status).toBe(200)
    return OpenResult.parse(await response.json())
  }

  function sendDrafts(pageId: PageId, drafts: DraftBody[]): Round {
    const notes = drafts.map((draft) => inbox.createDraft(pageId, draft))
    const generation = pages.get(pageId)?.page.pairing?.generation
    if (generation === undefined) throw new Error(`Page ${pageId} is not paired`)
    const result = inbox.send(pageId, {
      idempotencyKey: IdempotencyKey.parse(`send-key-${notes[0]?.id}`),
      noteIds: notes.map((note) => note.id),
      generation,
    })
    if (result.outcome !== "accepted") throw new Error(`Send refused: ${result.reason}`)
    return result.round
  }

  const sendRound = (pageId: PageId, body: string, capture?: Capture): Round =>
    sendDrafts(pageId, [draftBody(body, capture)])

  const sendNotes = (pageId: PageId, bodies: string[]): Round =>
    sendDrafts(
      pageId,
      bodies.map((body) => draftBody(body)),
    )

  function socket(pageId: PageId): ServerMessage[] {
    const messages: ServerMessage[] = []
    live.attach(pageId, {
      send: (data) => messages.push(ServerMessage.parse(JSON.parse(data))),
      close() {},
    })
    return messages
  }

  return {
    db,
    app,
    owners,
    pages,
    inbox,
    agentNotes,
    waiters,
    screenshots,
    machineId,
    opened,
    drains,
    post,
    startSession,
    openServer,
    sendRound,
    sendNotes,
    sendDrafts,
    socket,
  }
}

function draftBody(body: string, capture?: Capture) {
  return DraftBody.parse({
    intent: "fix",
    body,
    target: {
      kind: "element",
      anchor: {
        selector: ["[data-source-target=card]"],
        role: "article",
        box: { x: 24, y: 80, width: 320, height: 180 },
        renderGeneration: 3,
      },
    },
    anchorStatus: "anchored",
    ...(capture === undefined ? {} : { capture }),
  })
}

function captureWith(text: string): Capture {
  return {
    completeness: "complete",
    omittedParts: [],
    url: `http://larkspur.localhost:3990/${text}`,
    viewport: { width: 1280, height: 800, devicePixelRatio: 2 },
    theme: "dark",
    landmark: `main ${text}`,
    surroundingText: `Card copy ${text}`,
    computedStyles: { padding: "8px", content: text },
    consoleErrors: [{ message: `TypeError ${text}`, at: "2026-10-09T17:59:00.000Z" }],
  }
}

async function until(label: string, condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

describe("hook routes", () => {
  test("agent claude from hook start reaches its pairing, status, live sessions and note author", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session", "claude")
    const started = await t.post("/hook/start", {
      pid: session.pid,
      label: session.label,
      source: "resume",
      agent: "claude",
      cwd: projectRoot,
    })
    expect(PairResult.parse(await started.json()).pairing.agent).toBe("claude")

    const status = await t.post("/status", { identities: session.identities, owner: null })
    expect(ServiceStatus.parse(await status.json()).owner?.agent).toBe("claude")

    expect(t.owners.liveSessions()).toEqual([
      expect.objectContaining({ owner: session.ownerId, agent: "claude" }),
    ])

    const { page } = await t.openServer(session)
    const posted = await t.post("/note", {
      page: page.id,
      intent: "question",
      body: "Should this card keep its shadow?",
      at: ["main", "[data-source-target=card]"],
      identities: session.identities,
      owner: null,
    })
    expect(posted.status).toBe(200)
    expect(AgentNoteResult.parse(await posted.json()).note.author).toEqual({
      kind: "agent",
      owner: session.ownerId,
      name: "larkspur-session",
      agent: "claude",
    })
  })

  test("a wait armed before a round arrives answers woken with its pointer, announced under the current label", async () => {
    const t = setup()
    await t.startSession(4821, "first-context")
    const session = await t.startSession(4821, "after-clear")
    const { page } = await t.openServer(session)
    const messages = t.socket(page.id)

    const waiting = t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=30`)
    await until("the wait to arm", () => t.waiters.isArmed(session.ownerId))
    const round = t.sendRound(page.id, "Tighten the card padding")
    t.waiters.wake(session.ownerId)

    const response = await waiting
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: round.id, pageId: page.id, noteCount: 1 }],
    })
    expect(t.inbox.round(round.id)?.state.stage).toBe("announced")
    expect(
      t.db.query("SELECT owner_id, label FROM announcements WHERE round_id = ?").all(round.id),
    ).toEqual([{ owner_id: session.ownerId, label: "after-clear" }])
    expect(
      messages.flatMap((message) =>
        message.type === "pairing" ? [message.pairing?.listener] : [],
      ),
    ).toEqual(["armed", "none"])
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "round",
        round: expect.objectContaining({ id: round.id }),
      }),
    )
  })

  test("a second wait for the same pid answers the first with replaced", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const first = t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=30`)
    await until("the first wait to arm", () => t.waiters.isArmed(session.ownerId))
    const second = t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=30`)

    expect(await (await first).json()).toEqual({ outcome: "replaced" })
    expect(t.waiters.isArmed(session.ownerId)).toBe(true)
    t.waiters.cancelAll()
    expect(await (await second).json()).toEqual({ outcome: "cancelled" })
  })

  test("cancelling every waiter answers a pending wait with cancelled and no pointers", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const waiting = t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=30`)
    await until("the wait to arm", () => t.waiters.isArmed(session.ownerId))
    t.waiters.cancelAll()

    const response = await waiting
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcome: "cancelled" })
  })

  test("a wait that finds a pending round answers at once without arming", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const round = t.sendRound(page.id, "Fix the header wrap")
    const messages = t.socket(page.id)

    const response = await t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=600`)
    expect(await response.json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: round.id, pageId: page.id, noteCount: 1 }],
    })
    expect(t.waiters.isArmed(session.ownerId)).toBe(false)
    expect(messages.filter((message) => message.type === "pairing")).toEqual([])
    expect(t.inbox.round(round.id)?.state.stage).toBe("announced")
  })

  test("a wait that times out answers timeout", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const response = await t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=0`)
    expect(await response.json()).toEqual({ outcome: "timeout" })
  })

  test("hook prompt marks the owner busy and points only at unclaimed rounds not yet announced", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const announced = t.sendRound(page.id, "Announced already")
    await t.app.request(`/hook/wait?pid=${session.pid}&timeoutSeconds=0`)
    const claimed = t.sendRound(page.id, "Claimed already")
    await t.post("/show", { round: claimed.id, identities: session.identities, owner: null })
    const fresh = t.sendRound(page.id, "Not seen yet")

    const response = await t.post("/hook/prompt", { pid: session.pid })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      pointers: [{ roundId: fresh.id, pageId: page.id, noteCount: 1 }],
    })
    expect(t.owners.state(session.ownerId)).toEqual({ status: "busy" })
    expect(t.inbox.round(announced.id)?.state.stage).toBe("announced")

    await t.post("/hook/stop", { pid: session.pid })
    expect(t.owners.state(session.ownerId)).toEqual({ status: "live" })
  })

  test("hook start points at rounds pending for the owner and pushes its pairing to its pages", async () => {
    const t = setup()
    const session = await t.startSession(4821, "first-context")
    const { page } = await t.openServer(session)
    const round = t.sendRound(page.id, "Queued before the clear")
    const messages = t.socket(page.id)

    const response = await t.post("/hook/start", {
      pid: session.pid,
      label: "after-clear",
      source: "clear",
      agent: "claude",
      cwd: projectRoot,
    })
    const body = await response.json()
    expect(body.pointers).toEqual([{ roundId: round.id, pageId: page.id, noteCount: 1 }])
    expect(PairResult.parse(body).pairing.generation).toBe(PairingGeneration.parse(1))
    expect(messages).toContainEqual({
      type: "pairing",
      pairing: expect.objectContaining({
        owner: session.ownerId,
        process: expect.objectContaining({ label: "after-clear" }),
      }),
    })
  })

  test("hook end with logout makes the owner gone and orphans its unclaimed rounds", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const round = t.sendRound(page.id, "Left behind")
    const messages = t.socket(page.id)

    const response = await t.post("/hook/end", {
      pid: session.pid,
      label: session.label,
      reason: "logout",
    })
    expect(response.status).toBe(200)
    expect(t.owners.state(session.ownerId)).toEqual({ status: "gone", reason: "ended" })
    expect(t.inbox.round(round.id)?.state.stage).toBe("orphaned")
    expect(messages).toContainEqual({
      type: "pairing",
      pairing: expect.objectContaining({ state: { status: "gone", reason: "ended" } }),
    })
  })

  test("an unregistered pid is 404 on prompt, stop, wait and end", async () => {
    const t = setup()
    const pid = 7777
    expect((await t.post("/hook/prompt", { pid })).status).toBe(404)
    expect((await t.post("/hook/stop", { pid })).status).toBe(404)
    expect((await t.app.request(`/hook/wait?pid=${pid}&timeoutSeconds=1`)).status).toBe(404)
    expect((await t.post("/hook/end", { pid, label: "nobody", reason: "logout" })).status).toBe(404)
  })

  test("a malformed hook body is 400", async () => {
    const t = setup()
    expect((await t.post("/hook/start", { pid: 4821, label: "x", source: "boot" })).status).toBe(
      400,
    )
    expect((await t.app.request("/hook/wait?pid=abc&timeoutSeconds=1")).status).toBe(400)
  })

  test("hook routes never carry note content", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Za-z0-9]{12,24}$/),
        fc.string(),
        fc.integer({ min: 1, max: 3 }),
        async (token, noise, roundCount) => {
          const sentinel = `sentinel-${token}`
          const t = setup()
          const session = await t.startSession(4821, "larkspur-session")
          const { page } = await t.openServer(session)
          const send = () => t.sendRound(page.id, `${noise}${sentinel}`, captureWith(sentinel))
          for (let index = 0; index < roundCount; index++) send()

          const responses: Response[] = []
          responses.push(
            await t.post("/hook/start", {
              pid: session.pid,
              label: "after-clear",
              source: "clear",
              agent: "claude",
              cwd: projectRoot,
            }),
          )
          send()
          responses.push(await t.post("/hook/prompt", { pid: session.pid }))
          send()
          responses.push(await t.app.request(waitUrl(session.pid, 0)))
          responses.push(await t.post("/hook/stop", { pid: session.pid }))
          responses.push(await t.app.request(waitUrl(session.pid, 0)))

          const replaced = t.app.request(waitUrl(session.pid, 30))
          await until("the first wait to arm", () => t.waiters.isArmed(session.ownerId))
          const woken = t.app.request(waitUrl(session.pid, 30))
          responses.push(await replaced)
          send()
          t.waiters.wake(session.ownerId)
          responses.push(await woken)
          const cancelled = t.app.request(waitUrl(session.pid, 30))
          await until("the last wait to arm", () => t.waiters.isArmed(session.ownerId))
          t.waiters.cancelAll()
          responses.push(await cancelled)

          responses.push(await t.post("/hook/prompt", { pid: 7777 }))
          responses.push(await t.post("/hook/start", { pid: 4821, label: sentinel }))
          responses.push(await t.app.request(waitUrl(session.pid, -1)))
          responses.push(
            await t.post("/hook/end", { pid: session.pid, label: "after-clear", reason: "clear" }),
          )

          const texts = await Promise.all(responses.map((response) => response.text()))
          expect(responses.map((response) => response.status)).toEqual([
            200, 200, 200, 200, 200, 200, 200, 200, 404, 400, 400, 200,
          ])
          expect(texts[0]).toContain('"pointers":[{')
          expect(texts[6]).toContain('"outcome":"woken"')
          const captureOnly = [
            "viewport",
            "devicePixelRatio",
            "theme",
            "computedStyles",
            "surroundingText",
            "landmark",
            "consoleErrors",
            "completeness",
            "omittedParts",
            "capture",
          ]
          for (const text of texts) {
            expect(text).not.toContain(sentinel)
            for (const field of captureOnly) expect(text).not.toContain(field)
          }
          for (const [index, text] of texts.entries()) {
            if (responses[index]?.status !== 200) continue
            const { pointers = [] } = JSON.parse(text) as { pointers?: object[] }
            for (const pointer of pointers) {
              expect(Object.keys(pointer).sort()).toEqual(["noteCount", "pageId", "roundId"])
            }
          }
        },
      ),
      { numRuns: 30 },
    )
  })
})

describe("agent routes", () => {
  test("show claims the round, pushes it and fences the capture under untrustedCapture", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const capture = captureWith("captured")
    const round = t.sendRound(page.id, "Card padding is cramped", capture)
    const messages = t.socket(page.id)

    const response = await t.post("/show", {
      round: round.id,
      identities: session.identities,
      owner: null,
    })
    expect(response.status).toBe(200)
    const show = ShowResult.parse(await response.json())
    expect(show.round).toEqual({
      id: round.id,
      pageId: page.id,
      stage: "claimed",
      url: `${page.origin}/`,
    })
    const [shown] = show.notes
    expect(shown?.untrustedCapture).toEqual(capture)
    expect(shown?.authored.body).toBe("Card padding is cramped")
    expect(Object.keys(shown?.authored ?? {})).not.toContain("capture")
    expect(t.inbox.round(round.id)?.state.stage).toBe("claimed")
    expect(messages).toContainEqual({
      type: "round",
      round: expect.objectContaining({
        id: round.id,
        state: expect.objectContaining({ stage: "claimed" }),
      }),
    })
  })

  test("show of an unknown round is 404", async () => {
    const t = setup()
    const response = await t.post("/show", { round: "R404", identities: [], owner: null })
    expect(response.status).toBe(404)
  })

  test("show and done by an owner that does not own the round are refused with 409", async () => {
    const t = setup()
    const owner = await t.startSession(4821, "owner-session")
    const other = await t.startSession(5133, "other-session")
    const { page } = await t.openServer(owner)
    const round = t.sendRound(page.id, "Owner's note")
    const noteId = round.notes[0]?.id

    const show = await t.post("/show", {
      round: round.id,
      identities: other.identities,
      owner: null,
    })
    expect(show.status).toBe(409)
    const done = await t.post("/done", {
      note: noteId,
      reply: null,
      identities: other.identities,
      owner: null,
    })
    expect(done.status).toBe(409)
    const viaFlag = await t.post("/show", { round: round.id, identities: [], owner: other.ownerId })
    expect(viaFlag.status).toBe(409)
    expect(t.inbox.round(round.id)?.state.stage).toBe("queued")
    expect(t.inbox.round(round.id)?.notes[0]?.resolution).toEqual({ status: "open" })

    const person = await t.post("/show", { round: round.id, identities: [], owner: null })
    expect(person.status).toBe(200)
  })

  test("an explicit owner that names no known owner is refused with 409", async () => {
    const t = setup()
    const response = await t.post("/rounds", {
      identities: [],
      owner: OwnerId.parse("o_missing"),
    })
    expect(response.status).toBe(409)
  })

  test("done with a reply marks the note answered and pushes the round", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const round = t.sendRound(page.id, "Why is this grey?")
    const noteId = round.notes[0]?.id
    const messages = t.socket(page.id)

    const response = await t.post("/done", {
      note: noteId,
      reply: "It inherits the muted token",
      identities: session.identities,
      owner: null,
    })
    expect(response.status).toBe(200)
    const done = DoneResult.parse(await response.json())
    expect<unknown>(done).toEqual({
      roundId: round.id,
      noteId,
      resolution: {
        status: "answered",
        reply: "It inherits the muted token",
        at: "2026-10-09T18:00:00.000Z",
      },
    })
    expect(t.inbox.round(round.id)?.notes[0]?.resolution.status).toBe("answered")
    expect(messages).toContainEqual({
      type: "round",
      round: expect.objectContaining({
        notes: [expect.objectContaining({ resolution: done.resolution })],
      }),
    })
  })

  test("done on an unknown note is 404", async () => {
    const t = setup()
    const response = await t.post("/done", {
      note: "N404",
      reply: null,
      identities: [],
      owner: null,
    })
    expect(response.status).toBe(404)
  })

  test("note pushes an agent-note to every live socket of the page", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const first = t.socket(page.id)
    const second = t.socket(page.id)

    const response = await t.post("/note", {
      page: page.id,
      intent: "change",
      body: "Moved the button into the card footer",
      at: ["[data-source-target=card]"],
      role: "button",
      name: "Save",
      identities: session.identities,
      owner: null,
    })
    expect(response.status).toBe(200)
    const { note, anchorStatus } = AgentNoteResult.parse(await response.json())
    expect(anchorStatus).toBe("unanchored")
    expect(note.target).toEqual({
      kind: "element",
      anchor: expect.objectContaining({
        selector: ["[data-source-target=card]"],
        role: "button",
        name: "Save",
      }),
    })
    expect(first).toEqual([{ type: "agent-note", note }])
    expect(second).toEqual([{ type: "agent-note", note }])
  })

  test("note refuses with no owner resolved and is 404 for an unknown page", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const note = { intent: "fix", body: "x", at: ["main"] }
    const unowned = await t.post("/note", { ...note, page: page.id, identities: [], owner: null })
    expect(unowned.status).toBe(409)
    const unknown = await t.post("/note", {
      ...note,
      page: "nowhere",
      identities: session.identities,
      owner: null,
    })
    expect(unknown.status).toBe(404)
  })

  test("open of a folder calls onPageOpened and keeps the file name in the url", async () => {
    const t = setup()
    const folder = await mkdtemp(join(tmpdir(), "iter8-"))
    directories.push(folder)
    const response = await t.post("/open", {
      target: { kind: "folder", root: folder, file: "index.html" },
      upstreams: [],
      identities: [],
      owner: null,
      cwd: projectRoot,
    })
    expect(response.status).toBe(200)
    const open = OpenResult.parse(await response.json())
    expect(open.page.target).toEqual({ kind: "folder", root: realpathSync(folder) })
    expect(open.url).toBe(`${open.page.origin}/index.html`)
    expect(open.poolPorts).toEqual([3990, 3991, 3992, 3993])
    expect(t.opened.map((record) => record.page)).toEqual([open.page])
  })

  test("open of the same target again reuses its page and token", async () => {
    const t = setup()
    const first = await t.openServer(null)
    const second = await t.openServer(null)
    expect(second.page.id).toBe(first.page.id)
    expect(second.landingUrl).toBe(first.landingUrl)
    expect(t.opened).toHaveLength(2)
    const other = await t.openServer(null, "http://localhost:4000")
    expect(other.page.id).not.toBe(first.page.id)
  })

  test("open by a resolved owner pairs the page and returns a landing fragment LandingFragment parses", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const open = await t.openServer(session)
    expect(open.page.pairing).toEqual({
      owner: session.ownerId,
      generation: PairingGeneration.parse(1),
    })
    const landing = new URL(open.landingUrl)
    expect(landing.origin + landing.pathname).toBe(`${open.page.origin}${LANDING_PATH}`)
    const fragment = LandingFragment.parse(
      Object.fromEntries(new URLSearchParams(landing.hash.slice(1))),
    )
    expect<unknown>(fragment).toEqual({
      m: t.machineId,
      p: open.page.id,
      t: t.pages.get(open.page.id)?.token,
    })
  })

  test("open by a different owner re-pairs the page and requeues its rounds to that owner", async () => {
    const t = setup()
    const first = await t.startSession(4821, "first-session")
    const second = await t.startSession(5133, "second-session")
    const { page } = await t.openServer(first)
    const round = t.sendRound(page.id, "Sent to the first session")

    const reopened = await t.openServer(second)
    expect(reopened.page.pairing).toEqual({
      owner: second.ownerId,
      generation: PairingGeneration.parse(2),
    })
    expect(t.inbox.round(round.id)?.owner).toBe(second.ownerId)
    const waited = await t.app.request(`/hook/wait?pid=${second.pid}&timeoutSeconds=0`)
    expect(await waited.json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: round.id, pageId: page.id, noteCount: 1 }],
    })
  })

  test("attach pairs a page with the resolved owner and refuses without one", async () => {
    const t = setup()
    const first = await t.startSession(4821, "first-session")
    const second = await t.startSession(5133, "second-session")
    const { page } = await t.openServer(first)
    const messages = t.socket(page.id)

    expect((await t.post("/attach", { page: page.id, identities: [], owner: null })).status).toBe(
      409,
    )
    const unknown = await t.post("/attach", {
      page: "nowhere",
      identities: second.identities,
      owner: null,
    })
    expect(unknown.status).toBe(404)

    const response = await t.post("/attach", {
      page: page.id,
      identities: second.identities,
      owner: null,
    })
    expect(response.status).toBe(200)
    const { pairing } = PairResult.parse(await response.json())
    expect(pairing.owner).toBe(second.ownerId)
    expect(pairing.generation).toBe(PairingGeneration.parse(2))
    expect(messages).toContainEqual({ type: "pairing", pairing })
  })

  test("rounds lists the resolved owner's rounds, and every round with no owner", async () => {
    const t = setup()
    const first = await t.startSession(4821, "first-session")
    const second = await t.startSession(5133, "second-session")
    const firstPage = (await t.openServer(first)).page
    const secondPage = (await t.openServer(second, "http://localhost:4000")).page
    const firstRound = t.sendRound(firstPage.id, "First")
    const secondRound = t.sendRound(secondPage.id, "Second")

    const ids = async (body: unknown) =>
      RoundsResult.parse(await (await t.post("/rounds", body)).json()).rounds.map(
        (round) => round.id,
      )
    expect(await ids({ identities: first.identities, owner: null })).toEqual([firstRound.id])
    expect(await ids({ identities: first.identities, owner: second.ownerId })).toEqual([
      secondRound.id,
    ])
    expect(await ids({ identities: [], owner: null })).toEqual([firstRound.id, secondRound.id])
  })

  test("screenshots answer PNG bytes by ref and 404 for an unknown ref", async () => {
    const t = setup()
    const { page } = await t.openServer(null)
    const png = pngBytes(64, 32)
    const stored = t.screenshots.store(page.id, png)
    if (!stored) throw new Error("The PNG was not stored")

    const response = await t.app.request(`/screenshots/${stored.ref}`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/png")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
    expect((await t.app.request("/screenshots/missing")).status).toBe(404)
  })

  test("status reports the resolved owner, or none", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const resolved = await t.post("/status", { identities: session.identities, owner: null })
    expect(ServiceStatus.parse(await resolved.json()).owner?.owner).toBe(session.ownerId)
    const none = await t.post("/status", { identities: [], owner: null })
    expect(ServiceStatus.parse(await none.json()).owner).toBeNull()
  })

  test("drain answers 202 and then drains", async () => {
    const t = setup()
    const response = await t.post("/drain", {})
    expect(response.status).toBe(202)
    await until("drain to run", () => t.drains.length === 1)
  })
})

const waitUrl = (pid: number, seconds: number) => `/hook/wait?pid=${pid}&timeoutSeconds=${seconds}`

describe("hook waits and prompts, in depth", () => {
  test("a wait pending across a label change announces under the label current when it wakes", async () => {
    const t = setup()
    const session = await t.startSession(4821, "first-context")
    const { page } = await t.openServer(session)
    const waiting = t.app.request(waitUrl(session.pid, 30))
    await until("the wait to arm", () => t.waiters.isArmed(session.ownerId))

    await t.startSession(4821, "after-clear")
    const round = t.sendRound(page.id, "Tighten the card padding")
    t.waiters.wake(session.ownerId)

    expect(await (await waiting).json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: round.id, pageId: page.id, noteCount: 1 }],
    })
    expect(
      t.db.query("SELECT owner_id, label FROM announcements WHERE round_id = ?").all(round.id),
    ).toEqual([{ owner_id: session.ownerId, label: "after-clear" }])
  })

  test("waits for different owners are replaced, woken and answered independently", async () => {
    const t = setup()
    const a = await t.startSession(4821, "session-a")
    const b = await t.startSession(5133, "session-b")
    const pageA = (await t.openServer(a)).page
    const pageB = (await t.openServer(b, "http://localhost:4000")).page

    const firstA = t.app.request(waitUrl(a.pid, 30))
    const waitB = t.app.request(waitUrl(b.pid, 30))
    await until(
      "both waits to arm",
      () => t.waiters.isArmed(a.ownerId) && t.waiters.isArmed(b.ownerId),
    )
    const secondA = t.app.request(waitUrl(a.pid, 30))
    expect(await (await firstA).json()).toEqual({ outcome: "replaced" })
    expect(t.waiters.isArmed(b.ownerId)).toBe(true)

    const roundB = t.sendRound(pageB.id, "For session b")
    t.waiters.wake(b.ownerId)
    expect(await (await waitB).json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: roundB.id, pageId: pageB.id, noteCount: 1 }],
    })
    expect(t.waiters.isArmed(a.ownerId)).toBe(true)

    const roundA = t.sendRound(pageA.id, "For session a")
    t.waiters.wake(a.ownerId)
    expect(await (await secondA).json()).toEqual({
      outcome: "woken",
      pointers: [{ roundId: roundA.id, pageId: pageA.id, noteCount: 1 }],
    })
    expect(
      t.db.query("SELECT owner_id, round_id FROM announcements ORDER BY round_id").all(),
    ).toEqual([
      { owner_id: b.ownerId, round_id: roundB.id },
      { owner_id: a.ownerId, round_id: roundA.id },
    ])
  })

  test("a wait answers every eligible round of its owner, each with its own note count", async () => {
    const t = setup()
    const a = await t.startSession(4821, "session-a")
    const b = await t.startSession(5133, "session-b")
    const pageA = (await t.openServer(a)).page
    const pageB = (await t.openServer(b, "http://localhost:4000")).page
    const wide = t.sendNotes(pageA.id, ["one", "two", "three"])
    const narrow = t.sendRound(pageA.id, "solo")
    t.sendRound(pageB.id, "belongs to session b")

    const response = await t.app.request(waitUrl(a.pid, 600))
    expect(await response.json()).toEqual({
      outcome: "woken",
      pointers: [
        { roundId: wide.id, pageId: pageA.id, noteCount: 3 },
        { roundId: narrow.id, pageId: pageA.id, noteCount: 1 },
      ],
    })
  })

  test("a wait times out after timeoutSeconds, counted in seconds", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const started = performance.now()
    const waiting = t.app.request(waitUrl(session.pid, 1))
    await until("the wait to arm", () => t.waiters.isArmed(session.ownerId))
    expect(await (await waiting).json()).toEqual({ outcome: "timeout" })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(3000)
  })

  test("a prompt announces what it points at, then points at nothing until the label changes", async () => {
    const t = setup()
    const session = await t.startSession(4821, "first-context")
    const { page } = await t.openServer(session)
    const round = t.sendRound(page.id, "Look at the footer")
    const pointer = { roundId: round.id, pageId: page.id, noteCount: 1 }
    const announced = () =>
      t.db.query("SELECT label FROM announcements WHERE round_id = ? ORDER BY label").all(round.id)

    const first = await t.post("/hook/prompt", { pid: session.pid })
    expect(await first.json()).toEqual({ pointers: [pointer] })
    expect(t.inbox.round(round.id)?.state.stage).toBe("announced")
    expect(announced()).toEqual([{ label: "first-context" }])

    const again = await t.post("/hook/prompt", { pid: session.pid })
    expect(await again.json()).toEqual({ pointers: [] })

    const relabelled = await t.post("/hook/start", {
      pid: session.pid,
      label: "after-clear",
      source: "clear",
      agent: "claude",
      cwd: projectRoot,
    })
    expect((await relabelled.json()).pointers).toEqual([pointer])
    expect(announced()).toEqual([{ label: "after-clear" }, { label: "first-context" }])
    const afterwards = await t.post("/hook/prompt", { pid: session.pid })
    expect(await afterwards.json()).toEqual({ pointers: [] })
  })

  test("a prompt points at and announces only its own owner's rounds, leaving another owner's eligible", async () => {
    const t = setup()
    const a = await t.startSession(4821, "session-a")
    const b = await t.startSession(5133, "session-b")
    const pageA = (await t.openServer(a)).page
    const pageB = (await t.openServer(b, "http://localhost:4000")).page
    const roundA = t.sendRound(pageA.id, "For session a")
    const roundB = t.sendRound(pageB.id, "For session b")
    const announced = () =>
      t.db.query("SELECT owner_id, round_id FROM announcements ORDER BY round_id").all()

    const promptA = await t.post("/hook/prompt", { pid: a.pid })
    expect(await promptA.json()).toEqual({
      pointers: [{ roundId: roundA.id, pageId: pageA.id, noteCount: 1 }],
    })
    expect(announced()).toEqual([{ owner_id: a.ownerId, round_id: roundA.id }])
    expect(t.inbox.round(roundA.id)?.state.stage).toBe("announced")
    expect(t.inbox.round(roundB.id)?.state.stage).toBe("queued")

    const promptB = await t.post("/hook/prompt", { pid: b.pid })
    expect(await promptB.json()).toEqual({
      pointers: [{ roundId: roundB.id, pageId: pageB.id, noteCount: 1 }],
    })
    expect(announced()).toEqual([
      { owner_id: a.ownerId, round_id: roundA.id },
      { owner_id: b.ownerId, round_id: roundB.id },
    ])
  })

  test("hook stop and end answer ok", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const stop = await t.post("/hook/stop", { pid: session.pid })
    expect(await stop.json()).toEqual({ ok: true })
    const end = await t.post("/hook/end", {
      pid: session.pid,
      label: session.label,
      reason: "clear",
    })
    expect(await end.json()).toEqual({ ok: true })
  })
})

describe("agent routes, in depth", () => {
  test("show lists every note with its authored fields apart from a capture that is null when absent", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const capture = captureWith("second")
    const round = t.sendDrafts(page.id, [
      draftBody("first, no capture"),
      draftBody("second, captured", capture),
      draftBody("third, no capture"),
    ])

    const response = await t.post("/show", {
      round: round.id,
      identities: session.identities,
      owner: null,
    })
    const raw = await response.json()
    expect(Object.keys(raw).sort()).toEqual(["notes", "round"])
    expect(Object.keys(raw.round).sort()).toEqual(["id", "pageId", "stage", "url"])
    const stored = t.inbox.round(round.id)?.notes ?? []
    expect(stored).toHaveLength(3)
    expect(raw.notes).toEqual(
      stored.map((note) => ({
        authored: {
          id: note.id,
          author: note.author,
          intent: note.intent,
          body: note.body,
          target: note.target,
          anchorStatus: note.anchorStatus,
          resolution: note.resolution,
        },
        untrustedCapture: note.capture ?? null,
      })),
    )
    expect(raw.notes.map((note: { untrustedCapture: unknown }) => note.untrustedCapture)).toEqual([
      null,
      capture,
      null,
    ])
    expect(raw.notes.map((note: { authored: { body: string } }) => note.authored.body)).toEqual([
      "first, no capture",
      "second, captured",
      "third, no capture",
    ])
    for (const note of raw.notes) {
      expect(Object.keys(note).sort()).toEqual(["authored", "untrustedCapture"])
      expect(Object.keys(note.authored)).not.toContain("capture")
      expect(Object.keys(note.authored).sort()).toEqual([
        "anchorStatus",
        "author",
        "body",
        "id",
        "intent",
        "resolution",
        "target",
      ])
    }
  })

  test("show pushes the claimed round to every live socket of its page and to no other page", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const { page: other } = await t.openServer(session, "http://localhost:4000")
    const round = t.sendRound(page.id, "Show me")
    const sockets = [t.socket(page.id), t.socket(page.id), t.socket(page.id)]
    const bystander = t.socket(other.id)

    await t.post("/show", { round: round.id, identities: session.identities, owner: null })
    for (const messages of sockets) {
      expect(messages).toEqual([
        {
          type: "round",
          round: expect.objectContaining({
            id: round.id,
            state: expect.objectContaining({ stage: "claimed" }),
          }),
        },
      ])
    }
    expect(bystander).toEqual([])
  })

  test("the nearest registered owner among a caller's identities is the one that acts", async () => {
    const t = setup()
    const outer = await t.startSession(4821, "outer-session")
    const inner = await t.startSession(5133, "inner-session")
    const { page } = await t.openServer(outer)
    const round = t.sendRound(page.id, "Outer's round")
    const [cli, outerIdentity] = outer.identities
    const innerIdentity = inner.identities[1]

    const nearestInner = await t.post("/show", {
      round: round.id,
      identities: [cli, innerIdentity, outerIdentity],
      owner: null,
    })
    expect(nearestInner.status).toBe(409)
    expect(t.inbox.round(round.id)?.state.stage).toBe("queued")

    const nearestOuter = await t.post("/show", {
      round: round.id,
      identities: [cli, outerIdentity, innerIdentity],
      owner: null,
    })
    expect(nearestOuter.status).toBe(200)
    const status = await t.post("/status", {
      identities: [cli, innerIdentity, outerIdentity],
      owner: null,
    })
    expect(ServiceStatus.parse(await status.json()).owner?.owner).toBe(inner.ownerId)
  })

  test("done without an owner resolved acts, closes only the named note and may carry no reply", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const round = t.sendNotes(page.id, ["first", "second", "third"])
    const [first, second, third] = round.notes
    const messages = t.socket(page.id)

    const closed = await t.post("/done", {
      note: second?.id,
      reply: null,
      identities: [],
      owner: null,
    })
    expect(closed.status).toBe(200)
    const done = DoneResult.parse(await closed.json())
    expect<unknown>(done).toEqual({
      roundId: round.id,
      noteId: second?.id,
      resolution: { status: "done", at: "2026-10-09T18:00:00.000Z" },
    })
    expect(t.inbox.round(round.id)?.notes.map((note) => note.resolution.status)).toEqual([
      "open",
      "done",
      "open",
    ])
    expect(messages).toContainEqual({
      type: "round",
      round: expect.objectContaining({ id: round.id }),
    })

    const answered = await t.post("/done", {
      note: third?.id,
      reply: "Left as is",
      identities: [],
      owner: null,
    })
    expect<unknown>(DoneResult.parse(await answered.json()).noteId).toBe(third?.id)
    expect<unknown>(t.inbox.round(round.id)?.notes.map((note) => note.id)).toEqual([
      first?.id,
      second?.id,
      third?.id,
    ])
    expect(t.inbox.round(round.id)?.notes.map((note) => note.resolution.status)).toEqual([
      "open",
      "done",
      "answered",
    ])
  })

  test("note posts the given words and anchor, names the author by the current label and reaches only its page", async () => {
    const t = setup()
    const session = await t.startSession(4821, "first-context")
    const { page } = await t.openServer(session)
    const { page: other } = await t.openServer(session, "http://localhost:4000")
    await t.startSession(4821, "after-clear")
    const sockets = [t.socket(page.id), t.socket(page.id)]
    const bystander = t.socket(other.id)

    const response = await t.post("/note", {
      page: page.id,
      intent: "question",
      body: "Is this the final copy?",
      at: ["main", "[data-source-target=card] h2"],
      role: "heading",
      name: "Pricing",
      text: "Pricing that scales",
      identities: session.identities,
      owner: null,
    })
    expect(response.status).toBe(200)
    const { note } = AgentNoteResult.parse(await response.json())
    expect(note.body).toBe("Is this the final copy?")
    expect(note.intent).toBe("question")
    expect(note.author).toEqual({
      kind: "agent",
      owner: session.ownerId,
      name: "after-clear",
      agent: "claude",
    })
    expect(note.target).toEqual({
      kind: "element",
      anchor: expect.objectContaining({
        selector: ["main", "[data-source-target=card] h2"],
        role: "heading",
        name: "Pricing",
        text: "Pricing that scales",
      }),
    })
    expect(t.agentNotes.forPage(page.id)).toEqual([note])
    expect(t.agentNotes.forPage(other.id)).toEqual([])
    for (const messages of sockets) expect(messages).toEqual([{ type: "agent-note", note }])
    expect(bystander).toEqual([])

    const bare = await t.post("/note", {
      page: page.id,
      intent: "fix",
      body: "Bare",
      at: ["main"],
      identities: session.identities,
      owner: null,
    })
    const anchor = AgentNoteResult.parse(await bare.json()).note.target
    expect(anchor.kind === "element" && anchor.anchor.text).toBeUndefined()
    expect(anchor.kind === "element" && anchor.anchor.role).toBeUndefined()
  })

  test("note by an owner the page is not paired with, or whose session is gone, is refused with 409", async () => {
    const t = setup()
    const owner = await t.startSession(4821, "owner-session")
    const other = await t.startSession(5133, "other-session")
    const { page } = await t.openServer(owner)
    const note = { page: page.id, intent: "fix", body: "x", at: ["main"] }

    const stranger = await t.post("/note", { ...note, identities: other.identities, owner: null })
    expect(stranger.status).toBe(409)
    await t.post("/hook/end", { pid: owner.pid, label: owner.label, reason: "logout" })
    const gone = await t.post("/note", { ...note, identities: owner.identities, owner: null })
    expect(gone.status).toBe(409)
    expect(t.agentNotes.forPage(page.id)).toEqual([])
  })

  test("open of a folder without a file, or with a name that needs escaping, builds its url", async () => {
    const t = setup()
    const folder = await mkdtemp(join(tmpdir(), "iter8-"))
    directories.push(folder)
    const open = async (file: string | null) => {
      const response = await t.post("/open", {
        target: { kind: "folder", root: folder, file },
        upstreams: [],
        identities: [],
        owner: null,
        cwd: projectRoot,
      })
      expect(response.status).toBe(200)
      return OpenResult.parse(await response.json())
    }
    const bare = await open(null)
    expect(bare.url).toBe(`${bare.page.origin}/`)
    const escaped = await open("my file #1?.html")
    expect(escaped.url).toBe(`${bare.page.origin}/my%20file%20%231%3F.html`)
    expect(new URL(escaped.url).pathname).toBe("/my%20file%20%231%3F.html")
    expect(new URL(escaped.url).hash).toBe("")
  })

  test("open of a dev server records its extra upstreams on distinct pool ports", async () => {
    const t = setup()
    const response = await t.post("/open", {
      target: { kind: "server", upstream: devServer },
      upstreams: ["http://localhost:5174", "http://localhost:5175"],
      identities: [],
      owner: null,
      cwd: projectRoot,
    })
    expect(response.status).toBe(200)
    const open = OpenResult.parse(await response.json())
    expect(open.url).toBe(`${open.page.origin}/`)
    expect(open.poolPorts).toEqual([3990, 3991, 3992, 3993])
    const primaryPort = Number(new URL(open.page.origin).port)
    if (open.page.target.kind !== "server") throw new Error("Expected a server target")
    expect(open.page.target.upstream).toBe(devServer)
    const extras = open.page.target.extraUpstreams
    expect(extras.map((extra) => extra.upstream)).toEqual([
      "http://localhost:5174",
      "http://localhost:5175",
    ])
    const ports = extras.map((extra) => extra.port)
    expect(new Set([primaryPort, ...ports]).size).toBe(3)
    for (const port of ports) expect(open.poolPorts).toContain(port)
  })

  test("open refuses an upstream on a folder target with 400", async () => {
    const t = setup()
    const response = await t.post("/open", {
      target: { kind: "folder", root: "/tmp", file: null },
      upstreams: [devServer],
      identities: [],
      owner: null,
      cwd: projectRoot,
    })
    expect(response.status).toBe(400)
    expect(t.opened).toEqual([])
  })

  test("open of a folder that does not exist is 404, and of more upstreams than the pool holds is 409, opening nothing", async () => {
    const t = setup()
    const root = await mkdtemp(join(tmpdir(), "iter8-"))
    directories.push(root)
    const missing = await t.post("/open", {
      target: { kind: "folder", root: join(root, "typo-dir"), file: null },
      upstreams: [],
      identities: [],
      owner: null,
      cwd: projectRoot,
    })
    expect(missing.status).toBe(404)

    const crowded = await t.post("/open", {
      target: { kind: "server", upstream: devServer },
      upstreams: [5174, 5175, 5176, 5177].map((port) => `http://localhost:${port}`),
      identities: [],
      owner: null,
      cwd: projectRoot,
    })
    expect(crowded.status).toBe(409)
    expect(t.opened).toEqual([])
    expect(t.db.query("SELECT COUNT(*) AS count FROM pages").get()).toEqual({ count: 0 })
  })

  test("a malformed agent route body is 400", async () => {
    const t = setup()
    const session = await t.startSession(4821, "larkspur-session")
    const { page } = await t.openServer(session)
    const caller = { identities: session.identities, owner: null }
    const bodies: Array<[string, unknown]> = [
      ["/open", {}],
      [
        "/open",
        {
          ...caller,
          target: { kind: "folder", root: "/tmp", file: "a/b" },
          upstreams: [],
          cwd: projectRoot,
        },
      ],
      [
        "/open",
        {
          ...caller,
          target: { kind: "server", upstream: "ftp://x" },
          upstreams: [],
          cwd: projectRoot,
        },
      ],
      ["/attach", {}],
      ["/attach", { ...caller }],
      ["/rounds", {}],
      ["/rounds", { identities: "nope", owner: null }],
      ["/show", {}],
      ["/show", { ...caller }],
      ["/done", {}],
      ["/done", { ...caller, note: "N1", reply: "" }],
      ["/done", { ...caller, note: "N1" }],
      ["/note", {}],
      ["/note", { ...caller, page: page.id, intent: "fix", body: "x", at: [] }],
      ["/note", { ...caller, page: page.id, intent: "shout", body: "x", at: ["main"] }],
      ["/status", {}],
    ]
    for (const [path, body] of bodies) {
      const response = await t.post(path, body)
      expect({ path, status: response.status }).toEqual({ path, status: 400 })
    }
  })
})

describe("done across owners", () => {
  async function twoOwners() {
    const t = setup()
    const a = await t.startSession(4821, "session-a")
    const b = await t.startSession(5133, "session-b")
    const pageA = (await t.openServer(a)).page
    const pageB = (await t.openServer(b, "http://localhost:4000")).page
    const firstRound = t.sendRound(pageB.id, "B's earlier round")
    const secondRound = t.sendNotes(pageA.id, ["A's first note", "A's second note"])
    const target = secondRound.notes[1]
    if (!target) throw new Error("The seeded round has no second note")
    const resolutions = () => t.inbox.round(secondRound.id)?.notes.map((note) => note.resolution)
    return { t, a, b, firstRound, secondRound, target, resolutions }
  }

  test("done on a note in another owner's later round is refused and changes nothing, while its owner succeeds", async () => {
    const { t, a, b, firstRound, secondRound, target, resolutions } = await twoOwners()
    const open = [{ status: "open" }, { status: "open" }]

    const refused = await t.post("/done", {
      note: target.id,
      reply: null,
      identities: b.identities,
      owner: null,
    })
    expect(refused.status).toBe(409)
    expect<unknown>(resolutions()).toEqual(open)
    const viaFlag = await t.post("/done", {
      note: target.id,
      reply: null,
      identities: [],
      owner: b.ownerId,
    })
    expect(viaFlag.status).toBe(409)
    expect<unknown>(resolutions()).toEqual(open)

    const accepted = await t.post("/done", {
      note: target.id,
      reply: null,
      identities: a.identities,
      owner: null,
    })
    expect(accepted.status).toBe(200)
    expect<unknown>(DoneResult.parse(await accepted.json()).roundId).toBe(secondRound.id)
    expect(resolutions()?.map((resolution) => resolution.status)).toEqual(["open", "done"])
    expect(t.inbox.round(firstRound.id)?.notes[0]?.resolution).toEqual({ status: "open" })
  })

  test("done with a reply by the wrong owner is refused exactly like one without, and stores no reply", async () => {
    const { t, b, target, resolutions } = await twoOwners()
    const attempt = (reply: string | null) =>
      t.post("/done", { note: target.id, reply, identities: b.identities, owner: null })

    const withoutReply = await attempt(null)
    const withReply = await attempt("B answering for A")
    expect(withReply.status).toBe(409)
    expect(withReply.status).toBe(withoutReply.status)
    expect(await withReply.text()).toBe(await withoutReply.text())
    expect<unknown>(resolutions()).toEqual([{ status: "open" }, { status: "open" }])
    expect(
      t.db
        .query("SELECT COUNT(*) AS count FROM notes WHERE resolution_json LIKE '%B answering%'")
        .get(),
    ).toEqual({ count: 0 })
  })
})
