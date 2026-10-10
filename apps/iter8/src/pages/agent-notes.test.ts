import type { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { NoteAuthor, PageId, PageToken } from "@iter8/protocol"
import { nextSequence, openStore } from "../store/db"
import { type AgentNoteInput, createAgentNotes } from "./agent-notes"
import { createPages } from "./pages"

const databases: Database[] = []
const createdAt = "2026-10-09T12:00:00.000Z"

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  const pages = createPages(db, { randomToken: () => PageToken.parse("a".repeat(43)) })
  const page = pages.open({
    target: { kind: "server", upstream: "http://localhost:5173", extras: [] },
    projectRoot: "/project",
    poolPorts: [3990],
  }).page
  return { db, pages, page, notes: createAgentNotes(db, { now: () => new Date(createdAt) }) }
}

function input(): AgentNoteInput {
  return {
    author: NoteAuthor.parse({
      kind: "agent",
      owner: "owner",
      name: "My session",
      agent: "custom-agent",
    }),
    intent: "question",
    body: "Should this stay?",
    at: ["app-shell", "button"],
    role: "button",
    name: "Continue",
    text: "Continue to checkout",
  }
}

test("agent notes retain their author and intent and return as unanchored element notes", () => {
  const { db, page, notes } = setup()
  const note = notes.add(page.id, input())
  expect<unknown>(note).toEqual({
    id: "N1",
    pageId: page.id,
    author: { kind: "agent", owner: "owner", name: "My session", agent: "custom-agent" },
    intent: "question",
    body: "Should this stay?",
    target: {
      kind: "element",
      anchor: {
        selector: ["app-shell", "button"],
        role: "button",
        name: "Continue",
        text: "Continue to checkout",
        box: { x: 0, y: 0, width: 0, height: 0 },
        renderGeneration: 0,
      },
    },
    anchorStatus: "unanchored",
    resolution: { status: "open" },
    createdAt,
  })
  expect(note.capture).toBeUndefined()
  expect(notes.forPage(page.id)).toEqual([note])
  expect(createAgentNotes(db, { now: () => new Date(0) }).forPage(page.id)).toEqual([note])
  expect(db.query("SELECT kind, round_id, capture_json FROM notes").get()).toEqual({
    kind: "agent",
    round_id: null,
    capture_json: null,
  })
})

test("agent notes use the shared sequence and stay ordered and scoped to their page", () => {
  const { db, pages, page, notes } = setup()
  const other = pages.open({
    target: { kind: "server", upstream: "http://localhost:6000", extras: [] },
    projectRoot: "/project",
    poolPorts: [3990],
  }).page
  expect(nextSequence(db, "note_seq")).toBe(1)
  const first = notes.add(page.id, { ...input(), body: "First" })
  const otherNote = notes.add(other.id, { ...input(), body: "Other page" })
  const last = notes.add(page.id, { ...input(), body: "Last" })
  expect<unknown>([first.id, otherNote.id, last.id]).toEqual(["N2", "N3", "N4"])
  expect(notes.forPage(page.id)).toEqual([first, last])
  expect(notes.forPage(other.id)).toEqual([otherNote])
  expect(notes.forPage(PageId.parse("missing"))).toEqual([])
  db.query("UPDATE notes SET kind = 'draft' WHERE id = ?").run(last.id)
  expect(notes.forPage(page.id)).toEqual([first])
})

test("minimal selectors omit optional anchor details and preserve authored strings", () => {
  const { page, notes } = setup()
  const note = notes.add(page.id, {
    author: input().author,
    intent: "keep",
    body: "<script>\n'string'",
    at: ["#target"],
  })
  expect(note.target).toEqual({
    kind: "element",
    anchor: {
      selector: ["#target"],
      box: { x: 0, y: 0, width: 0, height: 0 },
      renderGeneration: 0,
    },
  })
  expect(notes.forPage(page.id)[0]?.body).toBe("<script>\n'string'")
})

test("invalid authors, selectors and unknown pages leave no note or consumed sequence", () => {
  const { db, page, notes } = setup()
  expect(() => notes.add(page.id, { ...input(), author: { kind: "user" } })).toThrow("agent author")
  expect(() => notes.add(page.id, { ...input(), at: [] })).toThrow()
  expect(() => notes.add(page.id, { ...input(), at: [""] })).toThrow()
  expect(() => notes.add(PageId.parse("missing"), input())).toThrow()
  expect(db.query("SELECT * FROM notes").all()).toEqual([])
  expect<unknown>(notes.add(page.id, input()).id).toBe("N1")
})

test("stored note JSON must still satisfy the protocol when read", () => {
  const { db, page, notes } = setup()
  notes.add(page.id, input())
  db.query("UPDATE notes SET target_json = ?").run(JSON.stringify({ kind: "element", anchor: {} }))
  expect(() => notes.forPage(page.id)).toThrow()
})
