import type { Database } from "bun:sqlite"
import {
  ClosedResolution,
  type DraftBody,
  Note,
  type NoteId,
  type OwnerId,
  type PageId,
  type Pairing,
  PairingGeneration,
  type PairingState,
  Round,
  type RoundId,
  RoundPointer,
  type RoundStage,
  RoundState,
  RoundSummary,
  type SendRequest,
  type SendResult,
} from "@iter8/protocol"
import { nextSequence } from "../store/db"
import { nextRoundState, type RoundEvent } from "./round-state"

export type InboxDeps = {
  now: () => Date
  ownerState: (ownerId: OwnerId) => PairingState
  pairing: (pageId: PageId) => Pairing | null
}

export type Inbox = {
  drafts(pageId: PageId): Note[]
  createDraft(pageId: PageId, body: DraftBody): Note
  putDraft(pageId: PageId, noteId: NoteId, body: DraftBody): Note | null
  deleteDraft(pageId: PageId, noteId: NoteId): boolean
  /** Throws an error whose `cause` is `"not-found"` when a note id is not a draft of the page. */
  send(pageId: PageId, request: SendRequest): SendResult
  pending(ownerId: OwnerId, label: string): RoundPointer[]
  announce(ownerId: OwnerId, label: string, roundIds: RoundId[]): void
  /** Null only for an unknown round; a round that cannot be claimed comes back unchanged. */
  claim(roundId: RoundId): Round | null
  resolveNote(
    noteId: NoteId,
    reply: string | null,
  ): { round: Round; resolution: ClosedResolution } | null
  round(roundId: RoundId): Round | null
  summaries(filter: { ownerId?: OwnerId; pageId?: PageId }): RoundSummary[]
  orphanFor(ownerId: OwnerId): Round[]
  requeuePage(pageId: PageId, ownerId: OwnerId): Round[]
  /** Rounds still waiting for their owner to take them: queued or announced. */
  unclaimedCount(): number
}

type NoteRow = {
  id: string
  page_id: string
  author_json: string
  intent: string
  body: string
  target_json: string
  anchor_status: string
  capture_json: string | null
  resolution_json: string
  created_at: string
}

type RoundRow = { id: string; page_id: string; owner_id: string | null; state_json: string }

const NOTE_COLUMNS =
  "id, page_id, author_json, intent, body, target_json, anchor_status, capture_json, resolution_json, created_at"
const ROUND_ORDER = "CAST(substr(id, 2) AS INTEGER)"

function noteFromRow(row: NoteRow): Note {
  return Note.parse({
    id: row.id,
    pageId: row.page_id,
    author: JSON.parse(row.author_json),
    intent: row.intent,
    body: row.body,
    target: JSON.parse(row.target_json),
    anchorStatus: row.anchor_status,
    createdAt: row.created_at,
    ...(row.capture_json === null ? {} : { capture: JSON.parse(row.capture_json) }),
    resolution: JSON.parse(row.resolution_json),
  })
}

export function createInbox(db: Database, deps: InboxDeps): Inbox {
  const at = () => deps.now().toISOString()

  const draftRows = db.query<NoteRow, [string]>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE page_id = ? AND kind = 'draft' ORDER BY ordinal`,
  )
  const draftRow = db.query<NoteRow, [string, string]>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ? AND page_id = ? AND kind = 'draft'`,
  )
  const roundNoteRows = db.query<NoteRow, [string]>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE round_id = ? ORDER BY ordinal`,
  )
  const roundRow = db.query<RoundRow, [string]>(
    "SELECT id, page_id, owner_id, state_json FROM rounds WHERE id = ?",
  )
  const writeState = db.query<null, [string, string | null, string]>(
    "UPDATE rounds SET state_json = ?, owner_id = ? WHERE id = ?",
  )

  function roundFromRow(row: RoundRow): Round {
    return Round.parse({
      id: row.id,
      pageId: row.page_id,
      owner: row.owner_id,
      state: JSON.parse(row.state_json),
      notes: roundNoteRows.all(row.id).map(noteFromRow),
    })
  }

  function readRound(roundId: string): Round | null {
    const row = roundRow.get(roundId)
    return row ? roundFromRow(row) : null
  }

  function stateOf(row: RoundRow): RoundState {
    return RoundState.parse(JSON.parse(row.state_json))
  }

  function move(row: RoundRow, event: RoundEvent, ownerId: string | null): Round | null {
    const next = nextRoundState(stateOf(row), event, at())
    if ("refused" in next) return null
    writeState.run(JSON.stringify(next), ownerId, row.id)
    return readRound(row.id)
  }

  function roundsWhere(where: string, ...params: string[]): RoundRow[] {
    return db
      .query<RoundRow, string[]>(
        `SELECT id, page_id, owner_id, state_json FROM rounds WHERE ${where} ORDER BY ${ROUND_ORDER}`,
      )
      .all(...params)
  }

  const captureJson = (note: Note) =>
    note.capture === undefined ? null : JSON.stringify(note.capture)

  const stageIn = (...stages: RoundStage[]) =>
    `json_extract(state_json, '$.stage') IN (${stages.map((stage) => `'${stage}'`).join(", ")})`

  return {
    drafts(pageId) {
      return draftRows.all(pageId).map(noteFromRow)
    },

    createDraft: db.transaction((pageId: PageId, body: DraftBody): Note => {
      const note = Note.parse({
        ...body,
        id: `N${nextSequence(db, "note_seq")}`,
        pageId,
        author: { kind: "user" },
        resolution: { status: "open" },
        createdAt: at(),
      })
      db.query(
        `INSERT INTO notes (id, page_id, round_id, kind, ordinal, author_json, intent, body,
           target_json, anchor_status, capture_json, resolution_json, created_at)
         VALUES (?1, ?2, NULL, 'draft',
           (SELECT COALESCE(MAX(ordinal), 0) + 1 FROM notes WHERE page_id = ?2 AND kind = 'draft'),
           ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).run(
        note.id,
        pageId,
        JSON.stringify(note.author),
        note.intent,
        note.body,
        JSON.stringify(note.target),
        note.anchorStatus,
        captureJson(note),
        JSON.stringify(note.resolution),
        note.createdAt,
      )
      return note
    }),

    putDraft: db.transaction((pageId: PageId, noteId: NoteId, body: DraftBody): Note | null => {
      const existing = draftRow.get(noteId, pageId)
      if (!existing) return null
      const { id, pageId: page, author, resolution, createdAt } = noteFromRow(existing)
      const note = Note.parse({ ...body, id, pageId: page, author, resolution, createdAt })
      db.query(
        `UPDATE notes SET intent = ?, body = ?, target_json = ?, anchor_status = ?, capture_json = ?
         WHERE id = ?`,
      ).run(
        note.intent,
        note.body,
        JSON.stringify(note.target),
        note.anchorStatus,
        captureJson(note),
        note.id,
      )
      return note
    }),

    deleteDraft(pageId, noteId) {
      return (
        db
          .query("DELETE FROM notes WHERE id = ? AND page_id = ? AND kind = 'draft'")
          .run(noteId, pageId).changes > 0
      )
    },

    send: db.transaction((pageId: PageId, request: SendRequest): SendResult => {
      const scopedKey = `${pageId}:${request.idempotencyKey}`
      const known = db
        .query<{ round_id: string }, [string]>(
          "SELECT round_id FROM round_keys WHERE idempotency_key = ?",
        )
        .get(scopedKey)
      const existing = known ? readRound(known.round_id) : null
      if (existing) return { outcome: "accepted", round: existing }

      const pairing = deps.pairing(pageId)
      if (!pairing) return { outcome: "refused", reason: "no-pairing", pairing: null }
      if (request.generation !== pairing.generation) {
        return { outcome: "refused", reason: "stale-generation", pairing }
      }
      if (deps.ownerState(pairing.owner).status === "gone") {
        return { outcome: "refused", reason: "session-gone", pairing }
      }

      const noteIds = [...new Set(request.noteIds)]
      for (const noteId of noteIds) {
        if (!draftRow.get(noteId, pageId)) {
          throw new Error(`Note ${noteId} is not a draft of page ${pageId}`, { cause: "not-found" })
        }
      }

      const roundId = `R${nextSequence(db, "round_seq")}`
      const queuedAt = at()
      const state = RoundState.parse({
        stage: "queued",
        queuedAt,
        idempotencyKey: request.idempotencyKey,
      })
      db.query(
        "INSERT INTO rounds (id, page_id, owner_id, state_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(roundId, pageId, pairing.owner, JSON.stringify(state), queuedAt)
      db.query("INSERT INTO round_keys (idempotency_key, round_id) VALUES (?, ?)").run(
        scopedKey,
        roundId,
      )
      const toSent = db.query(
        "UPDATE notes SET kind = 'sent', round_id = ?, ordinal = ? WHERE id = ?",
      )
      for (const [index, noteId] of noteIds.entries()) toSent.run(roundId, index + 1, noteId)

      const round = readRound(roundId)
      if (!round) throw new Error(`Round ${roundId} vanished inside its own transaction`)
      return { outcome: "accepted", round }
    }),

    pending(ownerId, label) {
      return db
        .query<{ id: string; page_id: string; note_count: number }, [string, string, string]>(
          `SELECT rounds.id, rounds.page_id,
             (SELECT COUNT(*) FROM notes WHERE notes.round_id = rounds.id) AS note_count
           FROM rounds
           WHERE owner_id = ? AND ${stageIn("queued", "announced")}
             AND NOT EXISTS (
               SELECT 1 FROM announcements
               WHERE announcements.owner_id = ? AND announcements.label = ?
                 AND announcements.round_id = rounds.id
             )
           ORDER BY CAST(substr(rounds.id, 2) AS INTEGER)`,
        )
        .all(ownerId, ownerId, label)
        .map((row) =>
          RoundPointer.parse({ roundId: row.id, pageId: row.page_id, noteCount: row.note_count }),
        )
    },

    announce: db.transaction((ownerId: OwnerId, label: string, roundIds: RoundId[]): void => {
      const record = db.query(
        `INSERT INTO announcements (owner_id, label, round_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      const pageGeneration = db.query<{ generation: number }, [string]>(
        "SELECT generation FROM pages WHERE id = ?",
      )
      for (const roundId of roundIds) {
        const row = roundRow.get(roundId)
        if (!row || row.owner_id !== ownerId) continue
        record.run(ownerId, label, roundId, at())
        const page = pageGeneration.get(row.page_id)
        if (stateOf(row).stage !== "queued" || !page) continue
        move(
          row,
          { to: "announced", generation: PairingGeneration.parse(page.generation) },
          ownerId,
        )
      }
    }),

    claim: db.transaction((roundId: RoundId): Round | null => {
      const row = roundRow.get(roundId)
      if (!row) return null
      return move(row, { to: "claimed" }, row.owner_id) ?? roundFromRow(row)
    }),

    resolveNote: db.transaction(
      (
        noteId: NoteId,
        reply: string | null,
      ): { round: Round; resolution: ClosedResolution } | null => {
        const row = db
          .query<{ round_id: string }, [string]>(
            "SELECT round_id FROM notes WHERE id = ? AND kind = 'sent'",
          )
          .get(noteId)
        if (!row) return null
        const resolution = ClosedResolution.parse(
          reply === null ? { status: "done", at: at() } : { status: "answered", reply, at: at() },
        )
        db.query("UPDATE notes SET resolution_json = ? WHERE id = ?").run(
          JSON.stringify(resolution),
          noteId,
        )
        const round = readRound(row.round_id)
        return round ? { round, resolution } : null
      },
    ),

    round(roundId) {
      return readRound(roundId)
    },

    summaries(filter) {
      const conditions = ["1 = 1"]
      const params: string[] = []
      if (filter.ownerId !== undefined) {
        conditions.push("owner_id = ?")
        params.push(filter.ownerId)
      }
      if (filter.pageId !== undefined) {
        conditions.push("page_id = ?")
        params.push(filter.pageId)
      }
      return roundsWhere(conditions.join(" AND "), ...params).map((row) => {
        const round = roundFromRow(row)
        const count = (status: string) =>
          round.notes.filter((note) => note.resolution.status === status).length
        return RoundSummary.parse({
          id: round.id,
          pageId: round.pageId,
          owner: round.owner,
          stage: round.state.stage,
          noteCount: round.notes.length,
          doneCount: count("done"),
          answeredCount: count("answered"),
        })
      })
    },

    orphanFor: db.transaction((ownerId: OwnerId): Round[] =>
      roundsWhere(`owner_id = ? AND ${stageIn("queued", "announced")}`, ownerId).flatMap(
        (row) => move(row, { to: "orphaned" }, ownerId) ?? [],
      ),
    ),

    requeuePage: db.transaction((pageId: PageId, ownerId: OwnerId): Round[] => {
      // A requeued round is delivered afresh, so an earlier announcement must not hide it from
      // pending, even when the new owner is the old one under the same label.
      const forget = db.query("DELETE FROM announcements WHERE round_id = ?")
      return roundsWhere(
        `page_id = ? AND ${stageIn("queued", "announced", "orphaned")}`,
        pageId,
      ).flatMap((row) => {
        forget.run(row.id)
        const state = stateOf(row)
        // Queued to queued is not an edge: a round still queued only changes hands.
        if (state.stage === "queued") {
          writeState.run(JSON.stringify({ ...state, requeuedAt: at() }), ownerId, row.id)
          return readRound(row.id) ?? []
        }
        return move(row, { to: "queued" }, ownerId) ?? []
      })
    }),

    unclaimedCount() {
      return (
        db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count FROM rounds WHERE ${stageIn("queued", "announced")}`,
          )
          .get()?.count ?? 0
      )
    },
  }
}
