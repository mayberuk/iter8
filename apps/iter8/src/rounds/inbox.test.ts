import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DraftBody,
  IdempotencyKey,
  NoteId,
  OwnerId,
  PageId,
  Pairing,
  PairingGeneration,
  type PairingState,
  RoundId,
  type SendRequest,
} from "@iter8/protocol"
import fc from "fast-check"
import { openStore } from "../store/db"
import { createInbox } from "./inbox"

const databases: Database[] = []
const directories: string[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

const ownerA = OwnerId.parse("own_a")

describe("Send now", () => {
  function queuedRound(state: ReturnType<typeof setup>) {
    const note = state.inbox.createDraft(larkspur, draftBody("Heading"))
    return accepted(state.inbox.send(larkspur, sendRequest([note.id])))
  }

  test("only a round of the calling page can be nudged", () => {
    const s = setup()
    const round = queuedRound(s)
    expect(s.inbox.sendNow(meadow, round.id)).toBeNull()
    expect(s.inbox.sendNow(larkspur, RoundId.parse("R999"))).toBeNull()
    expect(s.inbox.round(round.id)?.state).not.toHaveProperty("sendNowAt")
  })

  test("queued rounds keep their first nudge time and pending can select just those rounds", () => {
    const s = setup()
    const first = queuedRound(s)
    const second = queuedRound(s)
    expect(s.inbox.pending(ownerA, "session-label", "send-now")).toEqual([])
    s.clock.set(at(5))
    const acceptedNow = s.inbox.sendNow(larkspur, second.id)
    expect(acceptedNow).toMatchObject({
      outcome: "accepted",
      round: { id: second.id, state: { stage: "queued", sendNowAt: iso(5) } },
    })
    s.clock.set(at(10))
    expect(s.inbox.sendNow(larkspur, second.id)).toEqual(acceptedNow)
    expect(s.inbox.pending(ownerA, "session-label").map((pointer) => pointer.roundId)).toEqual([
      first.id,
      second.id,
    ])
    expect(
      s.inbox.pending(ownerA, "session-label", "send-now").map((pointer) => pointer.roundId),
    ).toEqual([second.id])
    s.inbox.announce(ownerA, "session-label", [second.id])
    expect(s.inbox.pending(ownerA, "session-label", "send-now")).toEqual([])
  })

  test("an unpaired page refuses before the orphan or announcement checks", () => {
    const s = setup()
    const orphan = queuedRound(s)
    s.inbox.orphanFor(ownerA)
    const queued = queuedRound(s)
    const announced = queuedRound(s)
    s.inbox.announce(ownerA, "session-label", [announced.id])
    s.pairings.delete(larkspur)
    s.ownerStates.set(ownerA, { status: "gone", reason: "ended" })
    for (const round of [queued, announced, orphan]) {
      expect(s.inbox.sendNow(larkspur, round.id)).toMatchObject({
        outcome: "refused",
        reason: "no-pairing",
        round: { id: round.id },
      })
    }
  })

  test("orphaned rounds and rounds whose owner is gone refuse session-gone before not-waiting", () => {
    const s = setup()
    const orphan = queuedRound(s)
    s.inbox.orphanFor(ownerA)
    expect(s.inbox.sendNow(larkspur, orphan.id)).toMatchObject({
      outcome: "refused",
      reason: "session-gone",
    })
    const queued = queuedRound(s)
    const announced = queuedRound(s)
    s.inbox.announce(ownerA, "session-label", [announced.id])
    const claimed = queuedRound(s)
    s.inbox.claim(claimed.id)
    s.ownerStates.set(ownerA, { status: "gone", reason: "ended" })
    s.pairings.set(larkspur, pairingFor(ownerB, 3))
    for (const round of [queued, announced, claimed]) {
      expect(s.inbox.sendNow(larkspur, round.id)).toMatchObject({
        outcome: "refused",
        reason: "session-gone",
        round: { id: round.id },
      })
    }
  })

  test("announced and claimed rounds refuse not-waiting and keep their state", () => {
    const s = setup()
    const announced = queuedRound(s)
    const claimed = queuedRound(s)
    s.inbox.announce(ownerA, "session-label", [announced.id])
    s.inbox.claim(claimed.id)
    for (const round of [announced, claimed]) {
      const before = s.inbox.round(round.id)
      if (!before) throw new Error("Seeded round is missing")
      expect(s.inbox.sendNow(larkspur, round.id)).toEqual({
        outcome: "refused",
        reason: "not-waiting",
        round: before,
      })
      expect(s.inbox.round(round.id)).toEqual(before)
    }
  })

  test("a nudge survives announcement and claim and is dropped by every requeue", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("queued", "announced", "orphaned"),
        fc.boolean(),
        (stage, sameOwner) => {
          const s = setup()
          try {
            const round = queuedRound(s)
            s.clock.set(at(5))
            s.inbox.sendNow(larkspur, round.id)
            if (stage !== "queued") s.inbox.announce(ownerA, "session-label", [round.id])
            if (stage === "announced")
              expect(s.inbox.round(round.id)?.state).toHaveProperty("sendNowAt", iso(5))
            if (stage === "orphaned") s.inbox.orphanFor(ownerA)
            const owner = sameOwner ? ownerA : ownerB
            s.inbox.requeuePage(larkspur, owner)
            expect(s.inbox.round(round.id)).toMatchObject({ owner, state: { stage: "queued" } })
            expect(s.inbox.round(round.id)?.state).not.toHaveProperty("sendNowAt")
            expect(s.inbox.pending(owner, "session-label", "send-now")).toEqual([])
            s.inbox.sendNow(larkspur, round.id)
            s.inbox.announce(owner, "session-label", [round.id])
            expect(s.inbox.claim(round.id)?.state).toHaveProperty("sendNowAt", iso(5))
          } finally {
            s.db.close()
          }
        },
      ),
    )
  })
})
const ownerB = OwnerId.parse("own_b")
const larkspur = PageId.parse("larkspur")
const meadow = PageId.parse("meadow")
const start = Date.UTC(2026, 9, 9, 18, 0, 0)

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

function pairingFor(owner: OwnerId, generation: number) {
  return Pairing.parse({
    owner,
    agent: "claude",
    process: { pid: 4821, startedAt: "Fri Oct  9 17:58:02 2026", label: "session-label" },
    cwd: "/home/biruk/dev/larkspur",
    generation,
    state: { status: "live" },
    relabelPending: false,
    listener: "armed",
  })
}

function setup(path = ":memory:") {
  const db = openStore(path)
  databases.push(db)
  const addOwner = db.query(
    `INSERT INTO owners (id, agent, pid, started_at, label, cwd, created_at, relabel_pending, busy)
     VALUES (?, 'claude', ?, 'started', 'label', '/project', 'created', 0, 0)`,
  )
  addOwner.run(ownerA, 101)
  addOwner.run(ownerB, 102)
  const addPage = db.query(
    `INSERT INTO pages (id, token, project_root, target_kind, target, port, owner_id, generation, created_at)
     VALUES (?, 'token', '/project', 'server', ?, 3990, ?, ?, 'created')`,
  )
  addPage.run(larkspur, "http://localhost:3000", ownerA, 2)
  addPage.run(meadow, "http://localhost:4000", ownerB, 0)
  const ownerStates = new Map<OwnerId, PairingState>()
  const pairings = new Map<PageId, Pairing>([
    [larkspur, pairingFor(ownerA, 2)],
    [meadow, pairingFor(ownerB, 0)],
  ])
  let tick = 0
  let fixed: number | null = null
  const clock = {
    set(ms: number | null) {
      fixed = ms
    },
  }
  const inbox = createInbox(db, {
    now: () => new Date(fixed ?? start + 1000 * tick++),
    ownerState: (owner) => ownerStates.get(owner) ?? { status: "live" },
    pairing: (page) => pairings.get(page) ?? null,
  })
  return { db, inbox, ownerStates, pairings, clock }
}

let keyCounter = 0
function sendRequest(noteIds: string[], generation = 2): SendRequest {
  keyCounter += 1
  return {
    idempotencyKey: IdempotencyKey.parse(`send-key-${keyCounter}`),
    noteIds: noteIds.map((id) => NoteId.parse(id)),
    generation: PairingGeneration.parse(generation),
  }
}

const at = (minute: number) => Date.UTC(2027, 0, 1, 0, minute, 0)
const iso = (minute: number) => new Date(at(minute)).toISOString()

function roundCount(db: Database) {
  return db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rounds").get()?.count
}

function accepted(result: ReturnType<ReturnType<typeof setup>["inbox"]["send"]>) {
  if (result.outcome !== "accepted") throw new Error(`Send refused with ${result.reason}`)
  return result.round
}

describe("drafts", () => {
  test("creating drafts assigns service-wide note ids, a user author, an open resolution and now", () => {
    const { inbox } = setup()
    const first = inbox.createDraft(larkspur, draftBody("first"))
    const second = inbox.createDraft(meadow, draftBody("second"))
    const third = inbox.createDraft(larkspur, draftBody("third"))

    expect([first.id, second.id, third.id].map(String)).toEqual(["N1", "N2", "N3"])
    expect(first).toMatchObject({
      pageId: larkspur,
      author: { kind: "user" },
      resolution: { status: "open" },
      createdAt: "2026-10-09T18:00:00.000Z",
      body: "first",
    })
    expect(inbox.drafts(larkspur).map((note) => note.body)).toEqual(["first", "third"])
    expect(inbox.drafts(meadow).map((note) => note.body)).toEqual(["second"])
  })

  test("a draft keeps its capture through a read back", () => {
    const { inbox } = setup()
    const body = DraftBody.parse({
      ...draftBody("captured"),
      capture: {
        completeness: "partial",
        omittedParts: ["screenshot"],
        url: "http://larkspur.localhost:3990/pricing",
        viewport: { width: 1280, height: 800, devicePixelRatio: 1 },
        theme: "dark",
      },
    })
    const note = inbox.createDraft(larkspur, body)
    expect(inbox.drafts(larkspur)).toEqual([note])
    expect(note.capture?.theme).toBe("dark")
  })

  test("putting a draft replaces its body and keeps its id, author, resolution and creation time", () => {
    const { inbox } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("before"))
    const updated = inbox.putDraft(larkspur, draft.id, {
      ...draftBody("after"),
      intent: "question",
    })

    expect(updated).toEqual({ ...draft, body: "after", intent: "question" })
    expect(inbox.drafts(larkspur)).toEqual(updated ? [updated] : [])
  })

  test("put and delete act only on drafts of the named page", () => {
    const { inbox } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("mine"))
    expect(inbox.putDraft(meadow, draft.id, draftBody("theirs"))).toBeNull()
    expect(inbox.deleteDraft(meadow, draft.id)).toBe(false)
    expect(inbox.putDraft(larkspur, NoteId.parse("N99"), draftBody("missing"))).toBeNull()

    expect(inbox.deleteDraft(larkspur, draft.id)).toBe(true)
    expect(inbox.drafts(larkspur)).toEqual([])
    expect(inbox.deleteDraft(larkspur, draft.id)).toBe(false)
  })

  test("a sent note is no longer a draft, so put and delete leave it alone", () => {
    const { inbox } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("sent"))
    const round = accepted(inbox.send(larkspur, sendRequest([draft.id])))
    expect(inbox.putDraft(larkspur, draft.id, draftBody("edited"))).toBeNull()
    expect(inbox.deleteDraft(larkspur, draft.id)).toBe(false)
    expect(inbox.round(round.id)?.notes.map((note) => note.body)).toEqual(["sent"])
  })
})

describe("send", () => {
  test("an accepted round is committed before send returns, so a second connection reads it queued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iter8-"))
    directories.push(directory)
    const path = join(directory, "iter8.db")
    const { inbox } = setup(path)
    const draft = inbox.createDraft(larkspur, draftBody("durable"))

    const round = accepted(inbox.send(larkspur, sendRequest([draft.id])))

    const second = new Database(path, { readonly: true })
    databases.push(second)
    expect(
      second
        .query(
          "SELECT id, page_id, owner_id, json_extract(state_json, '$.stage') AS stage FROM rounds",
        )
        .all(),
    ).toEqual([{ id: round.id, page_id: larkspur, owner_id: ownerA, stage: "queued" }])
    expect(second.query("SELECT id, kind, round_id FROM notes").all()).toEqual([
      { id: draft.id, kind: "sent", round_id: round.id },
    ])
  })

  test("an accepted send queues the named drafts as one round in request order, owned by the page's owner", () => {
    const { inbox } = setup()
    const first = inbox.createDraft(larkspur, draftBody("first"))
    const second = inbox.createDraft(larkspur, draftBody("second"))
    const kept = inbox.createDraft(larkspur, draftBody("kept"))
    const request = sendRequest([second.id, first.id])

    const round = accepted(inbox.send(larkspur, request))

    expect(round).toMatchObject({
      id: "R1",
      pageId: larkspur,
      owner: ownerA,
      state: { stage: "queued", idempotencyKey: request.idempotencyKey },
    })
    expect(round.state).not.toHaveProperty("requeuedAt")
    expect(round.notes.map((note) => note.id)).toEqual([second.id, first.id])
    expect(inbox.drafts(larkspur)).toEqual([kept])
    expect(inbox.round(round.id)).toEqual(round)
  })

  test("a retry with the same idempotency key returns the same round and creates no second one", () => {
    const { db, inbox, pairings } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("once"))
    const request = sendRequest([draft.id])

    const first = accepted(inbox.send(larkspur, request))
    pairings.delete(larkspur)
    const retry = inbox.send(larkspur, request)

    expect(retry).toEqual({ outcome: "accepted", round: first })
    expect(roundCount(db)).toBe(1)

    pairings.set(larkspur, pairingFor(ownerA, 2))
    const another = inbox.createDraft(larkspur, draftBody("another"))
    expect(accepted(inbox.send(larkspur, sendRequest([another.id]))).id).toBe(RoundId.parse("R2"))
  })

  test("an unpaired page refuses with no-pairing and keeps its drafts", () => {
    const { db, inbox, pairings } = setup()
    pairings.delete(larkspur)
    const drafts = [
      inbox.createDraft(larkspur, draftBody("a")),
      inbox.createDraft(larkspur, draftBody("b")),
    ]

    const result = inbox.send(larkspur, sendRequest(drafts.map((note) => note.id)))

    expect(result).toEqual({ outcome: "refused", reason: "no-pairing", pairing: null })
    expect(inbox.drafts(larkspur)).toEqual(drafts)
    expect(roundCount(db)).toBe(0)
  })

  test("a generation other than the page's refuses with stale-generation and the current pairing", () => {
    const { db, inbox, pairings } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("stale"))

    const result = inbox.send(larkspur, sendRequest([draft.id], 1))

    expect(result).toEqual({
      outcome: "refused",
      reason: "stale-generation",
      pairing: pairings.get(larkspur) ?? null,
    })
    expect(inbox.drafts(larkspur)).toEqual([draft])
    expect(roundCount(db)).toBe(0)
  })

  test("a gone owner refuses with session-gone and keeps the drafts", () => {
    const { db, inbox, ownerStates, pairings } = setup()
    ownerStates.set(ownerA, { status: "gone", reason: "crashed" })
    const draft = inbox.createDraft(larkspur, draftBody("gone"))

    const result = inbox.send(larkspur, sendRequest([draft.id]))

    expect(result).toEqual({
      outcome: "refused",
      reason: "session-gone",
      pairing: pairings.get(larkspur) ?? null,
    })
    expect(inbox.drafts(larkspur)).toEqual([draft])
    expect(roundCount(db)).toBe(0)
  })

  test("a stale generation is reported before a gone owner", () => {
    const { inbox, ownerStates } = setup()
    ownerStates.set(ownerA, { status: "gone", reason: "ended" })
    const draft = inbox.createDraft(larkspur, draftBody("both"))
    expect(inbox.send(larkspur, sendRequest([draft.id], 0))).toMatchObject({
      reason: "stale-generation",
    })
  })

  test.each([0, 1, 3, 4, 100, 2 ** 31])(
    "generation %d is refused as stale, exactly as a lower one is, and keeps the drafts",
    (generation) => {
      const { db, inbox, pairings } = setup()
      const draft = inbox.createDraft(larkspur, draftBody("stale"))
      expect(inbox.send(larkspur, sendRequest([draft.id], generation))).toEqual({
        outcome: "refused",
        reason: "stale-generation",
        pairing: pairings.get(larkspur) ?? null,
      })
      expect(inbox.drafts(larkspur)).toEqual([draft])
      expect(roundCount(db)).toBe(0)
      expect(inbox.send(larkspur, sendRequest([draft.id], 2)).outcome).toBe("accepted")
    },
  )

  test("a retry is answered from the key alone, through another connection, whatever the request now says", async () => {
    const directory = await mkdtemp(join(tmpdir(), "iter8-"))
    directories.push(directory)
    const path = join(directory, "iter8.db")
    const { inbox } = setup(path)
    const draft = inbox.createDraft(larkspur, draftBody("once"))
    const request = sendRequest([draft.id])
    const first = accepted(inbox.send(larkspur, request))

    const second = openStore(path)
    databases.push(second)
    const reopened = createInbox(second, {
      now: () => new Date(start),
      ownerState: () => ({ status: "gone", reason: "crashed" }),
      pairing: () => null,
    })
    for (const changed of [
      request,
      { ...request, generation: PairingGeneration.parse(9) },
      { ...request, noteIds: [NoteId.parse("N99")] },
      { ...request, noteIds: [] },
    ]) {
      expect(reopened.send(larkspur, changed)).toEqual({ outcome: "accepted", round: first })
    }
    expect(roundCount(second)).toBe(1)
  })

  test("the same idempotency key from another page is a new send, and each page's retry finds its own round", () => {
    const { db, inbox } = setup()
    const mine = inbox.createDraft(larkspur, draftBody("mine"))
    const theirs = inbox.createDraft(meadow, draftBody("theirs"))
    const request = sendRequest([mine.id])

    const first = accepted(inbox.send(larkspur, request))
    const other = accepted(
      inbox.send(meadow, {
        ...request,
        noteIds: [theirs.id],
        generation: PairingGeneration.parse(0),
      }),
    )

    expect(other.id).not.toBe(first.id)
    expect(other.pageId).toBe(meadow)
    expect(other.notes.map((note) => note.id)).toEqual([theirs.id])
    expect(inbox.drafts(meadow)).toEqual([])
    expect(roundCount(db)).toBe(2)

    expect(inbox.send(larkspur, request)).toEqual({ outcome: "accepted", round: first })
    expect(
      inbox.send(meadow, { ...request, noteIds: [], generation: PairingGeneration.parse(0) }),
    ).toEqual({ outcome: "accepted", round: other })
    expect(roundCount(db)).toBe(2)
  })

  test("a key from another page does not hide a refusal on this page", () => {
    const { inbox, pairings } = setup()
    const mine = inbox.createDraft(larkspur, draftBody("mine"))
    const request = sendRequest([mine.id])
    accepted(inbox.send(larkspur, request))
    const theirs = inbox.createDraft(meadow, draftBody("theirs"))
    pairings.delete(meadow)
    expect(inbox.send(meadow, { ...request, noteIds: [theirs.id] })).toEqual({
      outcome: "refused",
      reason: "no-pairing",
      pairing: null,
    })
  })

  test("a note already sent from the same page cannot be sent again", () => {
    const { db, inbox } = setup()
    const sent = inbox.createDraft(larkspur, draftBody("sent"))
    const fresh = inbox.createDraft(larkspur, draftBody("fresh"))
    const first = accepted(inbox.send(larkspur, sendRequest([sent.id])))

    let thrown: unknown
    try {
      inbox.send(larkspur, sendRequest([fresh.id, sent.id]))
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).cause).toBe("not-found")
    expect(roundCount(db)).toBe(1)
    expect(inbox.drafts(larkspur)).toEqual([fresh])
    expect(inbox.round(first.id)?.notes.map((note) => note.id)).toEqual([sent.id])
  })

  test("busy and unknown owners still accept", () => {
    const { inbox, ownerStates } = setup()
    for (const state of [{ status: "busy" }, { status: "unknown" }] as const) {
      ownerStates.set(ownerA, state)
      const draft = inbox.createDraft(larkspur, draftBody(state.status))
      expect(inbox.send(larkspur, sendRequest([draft.id])).outcome).toBe("accepted")
    }
  })

  test("a note that is not a draft of the page throws not-found and changes nothing", () => {
    const { db, inbox } = setup()
    const mine = inbox.createDraft(larkspur, draftBody("mine"))
    const theirs = inbox.createDraft(meadow, draftBody("theirs"))

    for (const ids of [
      [mine.id, "N99"],
      [mine.id, theirs.id],
    ]) {
      let thrown: unknown
      try {
        inbox.send(larkspur, sendRequest(ids))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).cause).toBe("not-found")
    }

    expect(inbox.drafts(larkspur)).toEqual([mine])
    expect(roundCount(db)).toBe(0)
    expect(accepted(inbox.send(larkspur, sendRequest([mine.id]))).id).toBe(RoundId.parse("R1"))
  })
})

describe("announce, claim and resolve", () => {
  function sentRound(inbox: ReturnType<typeof setup>["inbox"], page = larkspur, generation = 2) {
    const notes = [
      inbox.createDraft(page, draftBody("one")),
      inbox.createDraft(page, draftBody("two")),
    ]
    return accepted(
      inbox.send(
        page,
        sendRequest(
          notes.map((note) => note.id),
          generation,
        ),
      ),
    )
  }

  test("a round announced under a label is not pending again for that owner and label", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    expect(inbox.pending(ownerA, "first-label")).toEqual([
      { roundId: round.id, pageId: larkspur, noteCount: 2 },
    ])
    expect(inbox.pending(ownerB, "first-label")).toEqual([])

    inbox.announce(ownerA, "first-label", [round.id])

    expect(inbox.pending(ownerA, "first-label")).toEqual([])
    expect(inbox.round(round.id)?.state).toMatchObject({
      stage: "announced",
      generation: 2,
      queuedAt: round.state.stage === "queued" ? round.state.queuedAt : "",
    })
  })

  test("a new label re-announces a still unclaimed round exactly once", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    inbox.announce(ownerA, "first-label", [round.id])
    const announcedState = inbox.round(round.id)?.state

    expect(inbox.pending(ownerA, "after-clear")).toEqual([
      { roundId: round.id, pageId: larkspur, noteCount: 2 },
    ])
    inbox.announce(ownerA, "after-clear", [round.id])

    expect(inbox.pending(ownerA, "after-clear")).toEqual([])
    expect(inbox.pending(ownerA, "first-label")).toEqual([])
    expect(inbox.round(round.id)?.state).toEqual(announcedState)
  })

  test("announcing one of several rounds leaves the others pending for the same owner and label", () => {
    const { inbox } = setup()
    const first = sentRound(inbox)
    const second = sentRound(inbox)
    const third = sentRound(inbox)

    inbox.announce(ownerA, "label", [second.id])

    expect(inbox.pending(ownerA, "label").map((pointer) => pointer.roundId)).toEqual([
      first.id,
      third.id,
    ])
    expect(inbox.pending(ownerA, "other-label").map((pointer) => pointer.roundId)).toEqual([
      first.id,
      second.id,
      third.id,
    ])
  })

  test("announcing the same round again, or naming it twice, neither throws nor changes anything", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    inbox.announce(ownerA, "label", [round.id, round.id])
    const announced = inbox.round(round.id)
    expect(() => inbox.announce(ownerA, "label", [round.id])).not.toThrow()
    expect(() => inbox.announce(ownerA, "label", [round.id, round.id])).not.toThrow()
    expect(inbox.round(round.id)).toEqual(announced)
    expect(inbox.pending(ownerA, "label")).toEqual([])
  })

  test("each state change stamps the clock's time and keeps the earlier stamps", () => {
    const { inbox, clock } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("timed"))
    const request = sendRequest([draft.id])

    clock.set(at(1))
    const sent = accepted(inbox.send(larkspur, request))
    expect(sent.state).toEqual({
      stage: "queued",
      queuedAt: iso(1),
      idempotencyKey: request.idempotencyKey,
    })

    clock.set(at(2))
    inbox.requeuePage(larkspur, ownerA)
    expect(inbox.round(sent.id)?.state).toEqual({
      stage: "queued",
      queuedAt: iso(1),
      idempotencyKey: request.idempotencyKey,
      requeuedAt: iso(2),
    })

    clock.set(at(3))
    inbox.announce(ownerA, "label", [sent.id])
    expect(inbox.round(sent.id)?.state).toEqual({
      stage: "announced",
      queuedAt: iso(1),
      idempotencyKey: request.idempotencyKey,
      requeuedAt: iso(2),
      announcedAt: iso(3),
      generation: PairingGeneration.parse(2),
    })

    clock.set(at(4))
    expect(inbox.claim(sent.id)?.state).toEqual({
      stage: "claimed",
      queuedAt: iso(1),
      idempotencyKey: request.idempotencyKey,
      requeuedAt: iso(2),
      announcedAt: iso(3),
      generation: PairingGeneration.parse(2),
      claimedAt: iso(4),
    })
  })

  test("orphaning keeps the announcement time, and requeuing an orphan restarts from its queue time", () => {
    const { inbox, clock } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("orphan"))
    const request = sendRequest([draft.id])
    clock.set(at(1))
    const sent = accepted(inbox.send(larkspur, request))
    clock.set(at(2))
    inbox.announce(ownerA, "label", [sent.id])

    clock.set(at(3))
    inbox.orphanFor(ownerA)
    expect(inbox.round(sent.id)?.state).toEqual({
      stage: "orphaned",
      queuedAt: iso(1),
      idempotencyKey: request.idempotencyKey,
      announcedAt: iso(2),
      orphanedAt: iso(3),
    })

    clock.set(at(4))
    inbox.requeuePage(larkspur, ownerB)
    expect(inbox.round(sent.id)).toMatchObject({
      owner: ownerB,
      state: {
        stage: "queued",
        queuedAt: iso(1),
        idempotencyKey: request.idempotencyKey,
        requeuedAt: iso(4),
      },
    })
  })

  test("a resolution is stamped with the clock's time and can be replaced by a later one", () => {
    const { inbox, clock } = setup()
    const round = sentRound(inbox)
    const [note] = round.notes
    if (!note) throw new Error("round has notes")

    clock.set(at(5))
    expect(inbox.resolveNote(note.id, null)?.resolution).toEqual({ status: "done", at: iso(5) })

    clock.set(at(6))
    expect(inbox.resolveNote(note.id, "Actually, it wraps.")?.resolution).toEqual({
      status: "answered",
      reply: "Actually, it wraps.",
      at: iso(6),
    })
    expect(inbox.round(round.id)?.notes[0]?.resolution).toEqual({
      status: "answered",
      reply: "Actually, it wraps.",
      at: iso(6),
    })

    clock.set(at(7))
    expect(inbox.resolveNote(note.id, "Second answer")?.resolution).toEqual({
      status: "answered",
      reply: "Second answer",
      at: iso(7),
    })
    clock.set(at(8))
    expect(inbox.resolveNote(note.id, null)?.resolution).toEqual({ status: "done", at: iso(8) })
  })

  test("summaries count only closed notes, so open notes add to neither count", () => {
    const { inbox } = setup()
    const notes = ["a", "b", "c", "d"].map((body) => inbox.createDraft(larkspur, draftBody(body)))
    const round = accepted(inbox.send(larkspur, sendRequest(notes.map((note) => note.id))))
    const summary = () => inbox.summaries({ pageId: larkspur })[0]
    expect(summary()).toMatchObject({ noteCount: 4, doneCount: 0, answeredCount: 0 })
    inbox.resolveNote(round.notes[0]?.id ?? NoteId.parse("N0"), null)
    expect(summary()).toMatchObject({ noteCount: 4, doneCount: 1, answeredCount: 0 })
    inbox.resolveNote(round.notes[1]?.id ?? NoteId.parse("N0"), "yes")
    expect(summary()).toMatchObject({ noteCount: 4, doneCount: 1, answeredCount: 1 })
  })

  test("announce ignores rounds the owner does not hold", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    inbox.announce(ownerB, "label", [round.id, RoundId.parse("R99")])
    expect(inbox.round(round.id)?.state.stage).toBe("queued")
    expect(inbox.pending(ownerA, "label")).toHaveLength(1)
  })

  test("claim moves a queued or announced round to claimed, after which nothing is pending", () => {
    const { inbox } = setup()
    const queued = sentRound(inbox)
    const announced = sentRound(inbox)
    inbox.announce(ownerA, "label", [announced.id])

    const claimedQueued = inbox.claim(queued.id)
    const claimedAnnounced = inbox.claim(announced.id)

    expect(claimedQueued?.state).toMatchObject({ stage: "claimed" })
    expect(claimedQueued?.state).not.toHaveProperty("announcedAt")
    expect(claimedAnnounced?.state).toMatchObject({ stage: "claimed", generation: 2 })
    expect(claimedAnnounced?.state).toHaveProperty("announcedAt")
    expect(inbox.pending(ownerA, "another-label")).toEqual([])
    expect(inbox.claim(queued.id)).toEqual(claimedQueued)
    expect(inbox.claim(RoundId.parse("R99"))).toBeNull()
  })

  test("resolving with reply text marks the note answered, and with none marks it done", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    const [first, second] = round.notes
    if (!first || !second) throw new Error("round has two notes")

    const answered = inbox.resolveNote(first.id, "It stacks below 640px.")
    const done = inbox.resolveNote(second.id, null)

    expect(answered?.resolution).toEqual({
      status: "answered",
      reply: "It stacks below 640px.",
      at: expect.any(String),
    })
    expect(done?.resolution).toEqual({ status: "done", at: expect.any(String) })
    expect(done?.round.notes.map((note) => note.resolution.status)).toEqual(["answered", "done"])
    expect(inbox.summaries({ pageId: larkspur })).toEqual([
      {
        id: round.id,
        pageId: larkspur,
        owner: ownerA,
        stage: "queued",
        noteCount: 2,
        doneCount: 1,
        answeredCount: 1,
      },
    ])
  })

  test("resolving a draft or an unknown note finds nothing", () => {
    const { inbox } = setup()
    const draft = inbox.createDraft(larkspur, draftBody("draft"))
    expect(inbox.resolveNote(draft.id, null)).toBeNull()
    expect(inbox.resolveNote(NoteId.parse("N99"), "reply")).toBeNull()
  })

  test("summaries filter by owner and page", () => {
    const { inbox } = setup()
    const mine = sentRound(inbox)
    const theirs = sentRound(inbox, meadow, 0)
    expect(inbox.summaries({}).map((summary) => summary.id)).toEqual([mine.id, theirs.id])
    expect(inbox.summaries({ ownerId: ownerB }).map((summary) => summary.id)).toEqual([theirs.id])
    expect(inbox.summaries({ ownerId: ownerB, pageId: larkspur })).toEqual([])
  })

  test("orphaning a gone owner marks only its queued and announced rounds orphaned", () => {
    const { inbox } = setup()
    const queued = sentRound(inbox)
    const announced = sentRound(inbox)
    const claimed = sentRound(inbox)
    const othersRound = sentRound(inbox, meadow, 0)
    inbox.announce(ownerA, "label", [announced.id])
    inbox.claim(claimed.id)

    const orphaned = inbox.orphanFor(ownerA)

    expect(orphaned.map((round) => round.id)).toEqual([queued.id, announced.id])
    for (const id of [queued.id, announced.id]) {
      expect(inbox.round(id)?.state).toMatchObject({
        stage: "orphaned",
        orphanedAt: expect.any(String),
      })
    }
    expect(inbox.round(claimed.id)?.state.stage).toBe("claimed")
    expect(inbox.round(othersRound.id)?.state.stage).toBe("queued")
    expect(inbox.pending(ownerA, "fresh-label")).toEqual([])
    expect(inbox.unclaimedCount()).toBe(1)
  })

  test("requeuing a reattached page moves its queued, announced and orphaned rounds to the new owner as queued", () => {
    const { inbox } = setup()
    const orphan = sentRound(inbox)
    inbox.orphanFor(ownerA)
    const queued = sentRound(inbox)
    const announced = sentRound(inbox)
    const claimed = sentRound(inbox)
    const othersRound = sentRound(inbox, meadow, 0)
    inbox.announce(ownerA, "label", [announced.id])
    inbox.claim(claimed.id)

    const requeued = inbox.requeuePage(larkspur, ownerB)

    expect(requeued.map((round) => round.id)).toEqual([orphan.id, queued.id, announced.id])
    for (const round of requeued) {
      expect(round.owner).toBe(ownerB)
      expect(round.state).toMatchObject({ stage: "queued", requeuedAt: expect.any(String) })
      expect(round.state).not.toHaveProperty("announcedAt")
    }
    expect(inbox.round(claimed.id)).toMatchObject({ owner: ownerA, state: { stage: "claimed" } })
    expect(inbox.round(othersRound.id)?.state).not.toHaveProperty("requeuedAt")
    expect(inbox.pending(ownerB, "label").map((pointer) => pointer.roundId)).toEqual([
      orphan.id,
      queued.id,
      announced.id,
      othersRound.id,
    ])
  })

  test("a round requeued to its own owner is announced again under the same label", () => {
    const { inbox } = setup()
    const round = sentRound(inbox)
    inbox.announce(ownerA, "label", [round.id])
    expect(inbox.pending(ownerA, "label")).toEqual([])

    inbox.requeuePage(larkspur, ownerA)

    expect(inbox.pending(ownerA, "label").map((pointer) => pointer.roundId)).toEqual([round.id])
  })

  test("the unclaimed count covers queued and announced rounds only", () => {
    const { inbox } = setup()
    expect(inbox.unclaimedCount()).toBe(0)
    const queued = sentRound(inbox)
    const announced = sentRound(inbox)
    const claimed = sentRound(inbox)
    inbox.announce(ownerA, "label", [announced.id])
    inbox.claim(claimed.id)
    expect(inbox.unclaimedCount()).toBe(2)
    inbox.claim(queued.id)
    expect(inbox.unclaimedCount()).toBe(1)
  })
})
