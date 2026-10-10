import { describe, expect, test } from "bun:test"
import {
  AttachResult,
  Capture,
  HelloResult,
  IdempotencyKey,
  Note,
  NoteId,
  type NoteTarget,
  OwnerId,
  PageId,
  Pairing,
  ROUND_TRANSITIONS,
  Round,
  type RoundStage,
  SendResult,
  ServerMessage,
} from "@iter8/protocol"
import fc from "fast-check"
import attachJson from "../../../packages/protocol/fixtures/AttachResult.json"
import attachRefusedJson from "../../../packages/protocol/fixtures/AttachResult.refused.json"
import captureJson from "../../../packages/protocol/fixtures/Capture.json"
import helloJson from "../../../packages/protocol/fixtures/HelloResult.json"
import noteJson from "../../../packages/protocol/fixtures/Note.json"
import pairingGoneJson from "../../../packages/protocol/fixtures/Pairing.gone.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import roundJson from "../../../packages/protocol/fixtures/Round.json"
import roundOrphanedJson from "../../../packages/protocol/fixtures/Round.orphaned.json"
import roundQueuedJson from "../../../packages/protocol/fixtures/Round.queued.json"
import sendJson from "../../../packages/protocol/fixtures/SendResult.json"
import sendRefusedJson from "../../../packages/protocol/fixtures/SendResult.refused.json"
import agentNoteMessageJson from "../../../packages/protocol/fixtures/ServerMessage.agent-note.json"
import agentNoteRemovedJson from "../../../packages/protocol/fixtures/ServerMessage.agent-note-removed.json"
import drainingJson from "../../../packages/protocol/fixtures/ServerMessage.draining.json"
import reloadJson from "../../../packages/protocol/fixtures/ServerMessage.reload.json"
import roundMessageJson from "../../../packages/protocol/fixtures/ServerMessage.round.json"
import upstreamJson from "../../../packages/protocol/fixtures/ServerMessage.upstream-failure.json"
import {
  applyRound,
  buildSendRequest,
  createOverlayModel,
  displayNoteState,
  dockState,
  roundOutcome,
  sendBlockedReason,
  sessionName,
  toDraftBody,
} from "./model"

const parsedHello = HelloResult.parse(helloJson)
if (parsedHello.outcome !== "accepted") throw new Error("HelloResult.json must be accepted")
const hello = parsedHello
const pairing = Pairing.parse(pairingJson)
const gonePairing = Pairing.parse(pairingGoneJson)
const note = Note.parse(noteJson)
const capture = Capture.parse(captureJson)
const round = Round.parse(roundJson)
const orphanedRound = Round.parse(roundOrphanedJson)
const queuedRound = Round.parse(roundQueuedJson)
const elementTarget = note.target
const regionTarget: NoteTarget = {
  kind: "region",
  box: { x: 10, y: 20, width: 300, height: 200 },
  viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
}
const T0 = Date.parse("2026-10-09T18:40:00.000Z")

function model(at: { now: number } = { now: T0 }) {
  return createOverlayModel({ hello, now: () => at.now })
}

function draft(n: number, overrides: Partial<Note> = {}): Note {
  return { ...note, id: NoteId.parse(`N${n}`), ...overrides }
}

function withNotes(base: Round, notes: Note[]): Round {
  return { ...base, notes }
}

const open = { status: "open" } as const
const done = { status: "done", at: "2026-10-09T18:50:00.000Z" } as const
const answered = {
  status: "answered",
  reply: "It is on purpose.",
  at: "2026-10-09T18:50:00.000Z",
} as const

const announcedState = {
  stage: "announced",
  queuedAt: "2026-10-09T18:34:00.000Z",
  idempotencyKey: IdempotencyKey.parse("send-7c1e9b2a40d3"),
  announcedAt: "2026-10-09T18:35:00.000Z",
  generation: pairing.generation,
} as const satisfies Round["state"]

describe("displayNoteState", () => {
  test("each round stage maps to its displayed state while the note is open", () => {
    const openNote = draft(1, { resolution: open })
    expect(displayNoteState(queuedRound, openNote)).toBe("queued")
    expect(displayNoteState({ ...round, state: announcedState }, openNote)).toBe("delivered")
    expect(displayNoteState(round, openNote)).toBe("working")
    expect(displayNoteState(orphanedRound, openNote)).toBe("failed")
  })

  test("an orphaned round displays its open notes as failed", () => {
    for (const roundNote of orphanedRound.notes) {
      expect(roundNote.resolution.status).toBe("open")
      expect(displayNoteState(orphanedRound, roundNote)).toBe("failed")
    }
  })

  test("a note's resolution beats the round stage", () => {
    expect(displayNoteState(orphanedRound, draft(1, { resolution: answered }))).toBe("answered")
    expect(displayNoteState(queuedRound, draft(1, { resolution: done }))).toBe("done")
    expect(displayNoteState(round, draft(1, { resolution: answered }))).toBe("answered")
  })
})

describe("dockState", () => {
  test("a null pairing is unattached", () => {
    expect(dockState(null, null, T0)).toBe("unattached")
    expect(dockState(null, T0 + 1000, T0)).toBe("unattached")
  })

  test("a live pairing stays live whether or not a relabel is pending", () => {
    expect(dockState({ ...pairing, relabelPending: true }, null, T0)).toBe("live")
    expect(dockState({ ...pairing, relabelPending: false }, null, T0)).toBe("live")
  })

  test("busy, unknown and gone map to busy, checking and gone", () => {
    expect(dockState({ ...pairing, state: { status: "busy" } }, null, T0)).toBe("busy")
    expect(dockState({ ...pairing, state: { status: "unknown" } }, null, T0)).toBe("checking")
    expect(dockState(gonePairing, null, T0)).toBe("gone")
  })

  test("delivered holds only inside its window, and never over a gone session", () => {
    expect(dockState(pairing, T0 + 2500, T0)).toBe("delivered")
    expect(dockState(pairing, T0 + 2500, T0 + 2500)).toBe("live")
    expect(dockState(gonePairing, T0 + 2500, T0)).toBe("gone")
  })
})

describe("sendBlockedReason", () => {
  test("absent, gone and empty each name their reason, and a live round with drafts is open", () => {
    expect(sendBlockedReason(null, 3)).toBe("no-pairing")
    expect(sendBlockedReason(gonePairing, 3)).toBe("gone")
    expect(sendBlockedReason(pairing, 0)).toBe("empty")
    expect(sendBlockedReason(pairing, 1)).toBeNull()
    expect(sendBlockedReason({ ...pairing, state: { status: "unknown" } }, 1)).toBeNull()
  })

  const pairingStates = fc.constantFrom<Pairing["state"]>(
    { status: "live" },
    { status: "busy" },
    { status: "unknown" },
    { status: "gone", reason: "exited" },
    { status: "gone", reason: "crashed" },
    { status: "gone", reason: "replaced" },
    { status: "gone", reason: "ended" },
  )
  const step = fc.oneof(
    fc.record({ kind: fc.constant("pairing" as const), state: fc.option(pairingStates) }),
    fc.record({ kind: fc.constant("add" as const) }),
    fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }),
    fc.record({
      kind: fc.constant("refused" as const),
      state: fc.option(pairingStates),
      reason: fc.constantFrom("session-gone", "stale-generation", "no-pairing"),
    }),
  )

  test("property: Send is never enabled while the pairing is gone or absent", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const m = model()
        let next = 100
        for (const s of steps) {
          if (s.kind === "pairing")
            m.applyServerMessage({
              type: "pairing",
              pairing: s.state ? { ...pairing, state: s.state } : null,
            })
          else if (s.kind === "add") m.noteSaved(draft(next++))
          else if (s.kind === "delete") {
            const id = m.draftOrder.value[s.at % Math.max(m.draftOrder.value.length, 1)]
            if (id) m.noteDeleted(id)
          } else
            m.applySendResult({
              outcome: "refused",
              reason: s.reason,
              pairing: s.state ? { ...pairing, state: s.state } : null,
            })
          const current = m.pairing.value
          if (current === null) expect(m.sendBlocked.value).toBe("no-pairing")
          else if (current.state.status === "gone") expect(m.sendBlocked.value).toBe("gone")
          if (current === null || current.state.status === "gone")
            expect(sendBlockedReason(current, m.drafts.value.length)).not.toBeNull()
        }
      }),
    )
  })
})

describe("roundOutcome", () => {
  test("one resolved note reads Resolved", () => {
    expect(roundOutcome(withNotes(round, [draft(1, { resolution: done })]))).toEqual({
      label: "Resolved",
      tone: "done",
    })
  })

  test("every note resolved reads All n resolved", () => {
    const message = ServerMessage.parse(roundMessageJson)
    if (message.type !== "round") throw new Error("ServerMessage.round.json must be a round")
    expect(roundOutcome(message.round)).toEqual({ label: "All 2 resolved", tone: "done" })
  })

  test("a queued round reads Queued", () => {
    expect(roundOutcome(queuedRound)).toEqual({ label: "Queued", tone: "open" })
  })

  test("an announced round with every note open reads Delivered", () => {
    const announced = withNotes({ ...round, state: announcedState }, [draft(1), draft(2)])
    expect(roundOutcome(announced)).toEqual({ label: "Delivered", tone: "sent" })
  })

  test("a claimed round with some notes resolved reads k of n resolved", () => {
    const partly = withNotes(round, [draft(1, { resolution: done }), draft(2), draft(3)])
    expect(roundOutcome(partly)).toEqual({ label: "1 of 3 resolved", tone: "open" })
  })

  test("a claimed round with nothing resolved reads n in progress", () => {
    const working = withNotes(round, [draft(1), draft(2), draft(3)])
    expect(roundOutcome(working)).toEqual({ label: "3 in progress", tone: "open" })
  })

  test("an orphaned round reads Not delivered with the failed tone", () => {
    expect(roundOutcome(orphanedRound)).toEqual({ label: "Not delivered", tone: "failed" })
  })
})

describe("toDraftBody", () => {
  test("without a capture the body carries no capture key", () => {
    const body = toDraftBody(
      { intent: "fix", body: "Tighten this.", target: elementTarget, anchorStatus: "anchored" },
      undefined,
    )
    expect(body).toEqual({
      intent: "fix",
      body: "Tighten this.",
      target: elementTarget,
      anchorStatus: "anchored",
    })
    expect("capture" in body).toBe(false)
  })

  const marker = "\u0001captured:"
  const captured = fc.string().map((s) => `${marker}${s}`)
  const captureArb = fc.record({
    landmark: captured,
    surroundingText: captured,
    style: captured,
    consoleMessage: captured,
  })

  test("property: a note's authored text and its captured page data never mix", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("\u0001")),
        fc.constantFrom("fix", "change", "question", "keep"),
        fc.constantFrom("anchored", "moved", "unanchored"),
        captureArb,
        (text, intent, anchorStatus, page) => {
          const pageCapture = Capture.parse({
            ...capture,
            landmark: page.landmark,
            surroundingText: page.surroundingText,
            computedStyles: { color: page.style },
            consoleErrors: [{ message: page.consoleMessage, at: "2026-10-09T18:29:00.000Z" }],
          })
          const authored = { intent, body: text, target: elementTarget, anchorStatus }
          const body = toDraftBody(authored, pageCapture)
          expect(body.body).toBe(text)
          expect(body.capture).toEqual(pageCapture)
          const { capture: _, ...authoredFields } = body
          expect(authoredFields).toEqual(authored)
          expect(JSON.stringify(authoredFields)).not.toContain("\\u0001captured:")
        },
      ),
    )
  })
})

describe("applyRound", () => {
  test("an unknown round is appended and a known one is replaced by id", () => {
    expect(applyRound([], queuedRound)).toEqual([queuedRound])
    const announced = { ...queuedRound, state: announcedState }
    expect(applyRound([orphanedRound, queuedRound], announced)).toEqual([orphanedRound, announced])
  })

  test("a stale earlier stage never replaces a later one", () => {
    const claimed = { ...queuedRound, state: { ...round.state } }
    expect(applyRound([claimed], queuedRound)).toEqual([claimed])
    expect(applyRound([claimed], { ...queuedRound, state: announcedState })).toEqual([claimed])
  })

  test("an orphaned round requeues once the update carries a requeue time", () => {
    const requeued = Round.parse({
      ...orphanedRound,
      state: {
        stage: "queued",
        queuedAt: "2026-10-09T18:20:00.000Z",
        idempotencyKey: "send-31f0aa8c5e72",
        requeuedAt: "2026-10-09T18:41:00.000Z",
      },
    })
    expect(applyRound([orphanedRound], requeued)).toEqual([requeued])
    const { requeuedAt: _, ...lateOriginal } = requeued.state as Extract<
      Round["state"],
      { stage: "queued" }
    >
    expect(applyRound([orphanedRound], { ...requeued, state: lateOriginal })).toEqual([
      orphanedRound,
    ])
  })

  const stages = ["draft", "queued", "announced", "claimed", "orphaned"] as const
  const update = fc.record({
    stage: fc.constantFrom(...stages),
    requeuedMinute: fc.option(fc.integer({ min: 0, max: 59 })),
  })

  function roundAt(stage: RoundStage, requeuedMinute: number | null): Round {
    const queued = {
      queuedAt: "2026-10-09T18:00:00.000Z",
      idempotencyKey: "send-7c1e9b2a40d3",
      ...(requeuedMinute === null
        ? {}
        : { requeuedAt: `2026-10-09T19:${String(requeuedMinute).padStart(2, "0")}:00.000Z` }),
    }
    const state = {
      draft: { stage: "draft" },
      queued: { stage: "queued", ...queued },
      announced: {
        stage: "announced",
        ...queued,
        announcedAt: "2026-10-09T18:01:00.000Z",
        generation: 2,
      },
      claimed: { stage: "claimed", ...queued, claimedAt: "2026-10-09T18:02:00.000Z" },
      orphaned: {
        stage: "orphaned",
        queuedAt: queued.queuedAt,
        idempotencyKey: queued.idempotencyKey,
        orphanedAt: "2026-10-09T18:03:00.000Z",
      },
    }[stage]
    return Round.parse({ ...queuedRound, state })
  }

  test("property: a round only moves along ROUND_TRANSITIONS", () => {
    fc.assert(
      fc.property(fc.array(update, { minLength: 1, maxLength: 30 }), (updates) => {
        let rounds: Round[] = []
        let held: RoundStage | null = null
        for (const u of updates) {
          rounds = applyRound(rounds, roundAt(u.stage, u.requeuedMinute))
          expect(rounds).toHaveLength(1)
          const stage = rounds[0]?.state.stage ?? null
          if (held !== null && stage !== null && stage !== held) {
            const edges: readonly RoundStage[] = ROUND_TRANSITIONS[held]
            expect(edges).toContain(stage)
          }
          held = stage
        }
      }),
    )
  })

  const legalEdges = (Object.keys(ROUND_TRANSITIONS) as RoundStage[]).flatMap((from) =>
    ROUND_TRANSITIONS[from].map((to): [RoundStage, RoundStage] => [from, to]),
  )

  test.each(legalEdges)("a legal %s to %s update replaces the held round", (from, to) => {
    const requeue = to === "queued" && (from === "announced" || from === "orphaned")
    const held = roundAt(from, null)
    const next = roundAt(to, requeue ? 30 : null)
    expect(applyRound([held], next)).toEqual([next])
  })

  test("a queued update replaces a draft round without a requeue time", () => {
    const next = roundAt("queued", null)
    expect(applyRound([roundAt("draft", null)], next)).toEqual([next])
  })

  test("an announced round requeues only on a newer requeue time", () => {
    const held = roundAt("announced", 30)
    expect(applyRound([held], roundAt("queued", 31))).toEqual([roundAt("queued", 31)])
    expect(applyRound([held], roundAt("queued", 29))).toEqual([held])
    expect(applyRound([roundAt("announced", null)], roundAt("queued", null))).toEqual([
      roundAt("announced", null),
    ])
  })

  test("property: every update along a ROUND_TRANSITIONS edge is accepted", () => {
    const edge = fc.constantFrom(...legalEdges)
    fc.assert(
      fc.property(
        edge,
        fc.integer({ min: 0, max: 29 }),
        fc.integer({ min: 30, max: 59 }),
        (pair, heldMinute, updateMinute) => {
          const [from, to] = pair
          const requeue = to === "queued" && (from === "announced" || from === "orphaned")
          const held = roundAt(from, from === "announced" ? heldMinute : null)
          const next = roundAt(to, requeue ? updateMinute : null)
          expect(applyRound([held], next)).toEqual([next])
        },
      ),
    )
  })

  test("property: an update that is neither the same stage nor an edge is rejected", () => {
    const pair = fc
      .tuple(fc.constantFrom(...stages), fc.constantFrom(...stages))
      .filter(([from, to]) => {
        const edges: readonly RoundStage[] = ROUND_TRANSITIONS[from]
        return from !== to && !edges.includes(to)
      })
    fc.assert(
      fc.property(pair, fc.integer({ min: 0, max: 59 }), ([from, to], minute) => {
        const held = roundAt(from, null)
        expect(applyRound([held], roundAt(to, minute))).toEqual([held])
      }),
    )
  })
})

describe("sessionName and buildSendRequest", () => {
  test("the name is the last segment of the session's directory, else the page id", () => {
    expect(sessionName({ cwd: "/home/biruk/dev/larkspur" }, hello.page.id)).toBe("larkspur")
    expect(sessionName({ cwd: "/home/biruk/dev/larkspur/" }, hello.page.id)).toBe("larkspur")
    expect(sessionName(null, PageId.parse("orchid"))).toBe("orchid")
  })

  test("a send request keeps the display order and the pairing's generation", () => {
    const ids = [NoteId.parse("N3"), NoteId.parse("N1"), NoteId.parse("N2")]
    const key = IdempotencyKey.parse("0b6f3c1e-1f6a-4c8e-9d2b-7a5e4c3b2a10")
    expect(buildSendRequest(ids, pairing, key)).toEqual({
      idempotencyKey: key,
      noteIds: ids,
      generation: pairing.generation,
    })
  })
})

describe("composer", () => {
  test("a new region note defaults to change and anything else to fix", () => {
    const m = model()
    m.openComposer({ target: regionTarget })
    expect(m.composer.value?.intent).toBe("change")
    m.openComposer({ target: elementTarget })
    expect(m.composer.value?.intent).toBe("fix")
    m.openComposer({ target: regionTarget, shot: { shapes: [] } })
    expect(m.composer.value?.intent).toBe("fix")
    expect(m.mode.value).toBe("compose")
  })

  test("an empty body blocks save for every intent but keep", () => {
    const m = model()
    for (const intent of ["fix", "change", "question"] as const) {
      m.openComposer({ target: elementTarget })
      m.setIntent(intent)
      m.setBody("   ")
      expect(m.beginSave()).toBeNull()
      expect(m.composer.value?.bodyError).toBe(true)
      expect(m.composer.value?.saving).toBe(false)
    }
  })

  test("a keep note saved with an empty body stores Leave as is.", () => {
    const m = model()
    m.openComposer({ target: elementTarget })
    m.setIntent("keep")
    expect(m.beginSave()?.body).toBe("Leave as is.")
    expect(m.composer.value?.saving).toBe(true)
  })

  test("a saved note joins the end of the round and closes the composer", () => {
    const m = model()
    m.openComposer({ target: elementTarget })
    m.setBody("Make the price fit on one line.")
    const body = m.beginSave()
    expect(body?.body).toBe("Make the price fit on one line.")
    m.noteSaved(draft(40, { body: "Make the price fit on one line." }))
    expect(m.draftOrder.value).toEqual([NoteId.parse("N14"), NoteId.parse("N40")])
    expect(m.composer.value).toBeNull()
    expect(m.mode.value).toBe("idle")
  })

  test("a capture that arrives while composing rides along with the save", () => {
    const m = model()
    m.openComposer({ target: elementTarget })
    m.setBody("Fix.")
    m.enrichmentDone(capture)
    expect(m.beginSave()?.capture).toEqual(capture)
  })
})

describe("escape", () => {
  test("closes one layer at a time in the sketch's order", () => {
    const m = model()
    m.toggleSheet()
    m.coachStep.value = 0
    m.setMode("markup")
    m.menu.value = "session"
    m.setShortcutsOpen(true)

    expect(m.escape()).toBe(true)
    expect(m.shortcutsOpen.value).toBe(false)
    expect(m.mode.value).toBe("markup")

    expect(m.escape()).toBe(true)
    expect(m.mode.value).toBe("idle")
    expect(m.menu.value).toBe("session")

    expect(m.escape()).toBe(true)
    expect(m.menu.peek()).toBe("none")
    expect(m.sheet.value.open).toBe(true)

    m.menu.value = "more"
    expect(m.escape()).toBe(true)
    expect(m.menu.peek()).toBe("none")
    expect(m.sheet.value.open).toBe(true)

    expect(m.escape()).toBe(true)
    expect(m.sheet.value.open).toBe(false)
    expect(m.coachStep.value).toBe(0)

    expect(m.escape()).toBe(true)
    expect(m.coachStep.value).toBe(-1)
    expect(m.prefs.value.coachDone).toBe(true)

    expect(m.escape()).toBe(false)
  })

  test("a composing mode closes before the sheet", () => {
    const m = model()
    m.toggleSheet()
    m.openComposer({ target: elementTarget })
    m.escape()
    expect(m.mode.value).toBe("idle")
    expect(m.composer.value).toBeNull()
    expect(m.sheet.value.open).toBe(true)
  })
})

describe("draft edits", () => {
  test("deleting a note offers one undo that restores it in place", () => {
    const m = model()
    m.noteSaved(draft(41))
    m.noteSaved(draft(42))
    m.noteDeleted(NoteId.parse("N41"))
    expect(m.draftOrder.value).toEqual([NoteId.parse("N14"), NoteId.parse("N42")])
    expect(m.toasts.value.at(-1)).toMatchObject({ text: "Note 2 deleted", action: "undo" })
    const taken = m.takeUndo()
    expect(taken?.index).toBe(1)
    expect(m.takeUndo()).toBeNull()
    m.noteRestored(draft(43), 1)
    expect(m.draftOrder.value).toEqual(["N14", "N43", "N42"].map((id) => NoteId.parse(id)))
  })

  test("moving a note carries the focus with it", () => {
    const m = model()
    m.noteSaved(draft(41))
    m.noteSaved(draft(42))
    m.focusNext()
    expect(m.focus.value).toBe(0)
    m.moveNote(0, 2)
    expect(m.draftOrder.value).toEqual(["N41", "N42", "N14"].map((id) => NoteId.parse(id)))
    expect(m.focus.value).toBe(2)
    m.focusNext()
    expect(m.focus.value).toBe(2)
    m.focusPrev()
    expect(m.focus.value).toBe(1)
  })

  test("no more than three toasts show at once, newest kept", () => {
    const m = model()
    for (const text of ["one", "two", "three", "four"]) m.pushToast(text)
    expect(m.toasts.value.map((toast) => toast.text)).toEqual(["two", "three", "four"])
  })
})

describe("server messages", () => {
  test("a round toasts the first time it turns orphaned, and only then", () => {
    const m = model()
    const R13 = { ...orphanedRound, id: queuedRound.id }
    m.applyServerMessage({ type: "round", round: queuedRound })
    expect(m.toasts.value).toHaveLength(0)
    m.applyServerMessage({ type: "round", round: R13 })
    expect(m.toasts.value.map((toast) => toast.text)).toEqual([
      "Round 13 not delivered — larkspur ended before picking this up",
    ])
    m.applyServerMessage({ type: "round", round: R13 })
    expect(m.toasts.value).toHaveLength(1)
  })

  test("a round drops its notes from the draft", () => {
    const m = model()
    m.applyServerMessage({ type: "round", round: queuedRound })
    expect(m.draftOrder.value).toEqual([])
  })

  test("agent notes are added, replaced and removed", () => {
    const m = model()
    const added = ServerMessage.parse(agentNoteMessageJson)
    if (added.type !== "agent-note") throw new Error("expected an agent-note fixture")
    m.applyServerMessage({ ...added, note: { ...added.note, body: "Replaced." } })
    expect(m.agentNotes.value.map((n) => n.body)).toEqual(["Replaced."])
    m.applyServerMessage(ServerMessage.parse(agentNoteRemovedJson))
    expect(m.agentNotes.value).toEqual([])
  })

  test("a reload waits while the composer has text and fires once it closes", () => {
    const m = model()
    m.openComposer({ target: elementTarget })
    m.setBody("Half a thought")
    m.applyServerMessage(ServerMessage.parse(reloadJson))
    expect(m.reloadPending.value).toBe(true)
    expect(m.reloadNow.value).toBe(false)
    expect(m.notices.value).toContainEqual({ type: "reload-pending" })
    m.escape()
    expect(m.reloadPending.value).toBe(false)
    expect(m.reloadNow.value).toBe(true)
  })

  test("a reload with no unsaved text fires at once", () => {
    const m = model()
    m.applyServerMessage(ServerMessage.parse(reloadJson))
    expect(m.reloadPending.value).toBe(false)
    expect(m.reloadNow.value).toBe(true)
  })

  test("an upstream failure becomes a notice and draining marks the connection", () => {
    const m = model()
    const failure = ServerMessage.parse(upstreamJson)
    if (failure.type !== "upstream-failure") throw new Error("expected an upstream-failure fixture")
    m.applyServerMessage(failure)
    m.applyServerMessage(failure)
    expect(m.notices.value).toEqual([failure])
    m.applyServerMessage(ServerMessage.parse(drainingJson))
    expect(m.connection.value).toEqual({ status: "draining" })
  })
})

describe("send and attach results", () => {
  test("an accepted send moves its notes into the round and shows delivered for 2.5 s", () => {
    const at = { now: T0 }
    const m = model(at)
    m.applySendResult(SendResult.parse(sendJson))
    expect(m.drafts.value).toEqual([])
    expect(m.lastSentNoteIds.value).toEqual([NoteId.parse("N14")])
    expect(m.rounds.value.map((r) => r.id)).toContain(queuedRound.id)
    expect(m.dock.value).toBe("delivered")
    at.now = T0 + 2500
    m.expireDelivered()
    expect(m.dock.value).toBe("live")
  })

  test("a refused send keeps every draft and adopts the returned pairing", () => {
    const m = model()
    m.applySendResult(SendResult.parse(sendRefusedJson))
    expect(m.draftOrder.value).toEqual([NoteId.parse("N14")])
    expect(m.pairing.value?.state).toEqual({ status: "gone", reason: "crashed" })
    expect(m.sendBlocked.value).toBe("gone")
    expect(m.toasts.value).toHaveLength(1)
  })

  test("an accepted attach adopts the pairing and names the requeued rounds", () => {
    const m = model()
    m.applyAttachResult(AttachResult.parse(attachJson))
    expect(m.pairing.value?.owner).toBe(OwnerId.parse("own_9pz2mr4c"))
    expect(m.toasts.value.map((toast) => toast.text)).toEqual([
      "Attached to larkspur · devbox:3990 · requeued Round 11, Round 13",
    ])
  })

  test("a refused attach replaces the session list", () => {
    const m = model()
    const refused = AttachResult.parse(attachRefusedJson)
    m.applyAttachResult(refused)
    expect(m.liveSessions.value).toEqual(refused.outcome === "refused" ? refused.sessions : [])
    expect(m.pairing.value).toEqual(pairing)
  })
})
