import type { Database } from "bun:sqlite"
import { type Intent, Note, type NoteAuthor, type PageId } from "@iter8/protocol"
import { nextSequence } from "../store/db"

export type AgentNoteInput = {
  author: NoteAuthor
  intent: Intent
  body: string
  at: string[]
  role?: string
  name?: string
  text?: string
}
export type AgentNotes = {
  add(pageId: PageId, input: AgentNoteInput): Note
  forPage(pageId: PageId): Note[]
}

export function createAgentNotes(db: Database, deps: { now: () => Date }): AgentNotes {
  const add = db.transaction((pageId: PageId, input: AgentNoteInput): Note => {
    if (input.author.kind !== "agent") throw new Error("An agent note requires an agent author")
    const note = Note.parse({
      id: `N${nextSequence(db, "note_seq")}`,
      pageId,
      author: input.author,
      intent: input.intent,
      body: input.body,
      target: {
        kind: "element",
        anchor: {
          selector: input.at,
          role: input.role,
          name: input.name,
          text: input.text,
          box: { x: 0, y: 0, width: 0, height: 0 },
          renderGeneration: 0,
        },
      },
      anchorStatus: "unanchored",
      resolution: { status: "open" },
      createdAt: deps.now().toISOString(),
    })
    const ordinal = db
      .query<{ ordinal: number }, [string]>(
        "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM notes WHERE page_id = ? AND kind = 'agent'",
      )
      .get(pageId)?.ordinal
    db.query(
      `INSERT INTO notes
       (id, page_id, round_id, kind, ordinal, author_json, intent, body, target_json,
        anchor_status, capture_json, resolution_json, created_at)
       VALUES (?, ?, NULL, 'agent', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(
      note.id,
      note.pageId,
      ordinal ?? 1,
      JSON.stringify(note.author),
      note.intent,
      note.body,
      JSON.stringify(note.target),
      note.anchorStatus,
      JSON.stringify(note.resolution),
      note.createdAt,
    )
    return note
  })

  return {
    add: (pageId, input) => add.immediate(pageId, input),
    forPage(pageId) {
      return db
        .query<
          {
            id: string
            page_id: string
            author_json: string
            intent: string
            body: string
            target_json: string
            anchor_status: string
            resolution_json: string
            created_at: string
          },
          [string]
        >(
          `SELECT id, page_id, author_json, intent, body, target_json, anchor_status,
                  resolution_json, created_at
           FROM notes WHERE page_id = ? AND kind = 'agent' ORDER BY ordinal, rowid`,
        )
        .all(pageId)
        .map((row) =>
          Note.parse({
            id: row.id,
            pageId: row.page_id,
            author: JSON.parse(row.author_json),
            intent: row.intent,
            body: row.body,
            target: JSON.parse(row.target_json),
            anchorStatus: row.anchor_status,
            resolution: JSON.parse(row.resolution_json),
            createdAt: row.created_at,
          }),
        )
    },
  }
}
