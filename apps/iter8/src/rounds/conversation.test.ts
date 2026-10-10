import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import {
  DraftBody,
  formatPageMessage,
  formatPointer,
  IdempotencyKey,
  MessageId,
  Page,
  PageToken,
  PairingGeneration,
  RoundId,
  TranscriptRow,
} from "@iter8/protocol"
import fc from "fast-check"
import { createPages } from "../pages/pages"
import { createOwners } from "../pairing/owners"
import { openStore } from "../store/db"
import { createInbox } from "./inbox"

const databases: Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

const at = "2026-10-09T18:00:00.000Z"
const row = (
  key = "row-one",
  role: "user" | "assistant" = "assistant",
  text = "Finished the change",
) => TranscriptRow.parse({ key, role, text, at })

function setup() {
  const db = openStore(":memory:")
  databases.push(db)
  const owners = createOwners(db, {
    now: () => new Date(at),
    processStart: (pid) => `started-${pid}`,
  })
  const owner = owners.register({
    pid: 101,
    label: "first session",
    source: "startup",
    agent: "claude",
    cwd: process.cwd(),
  }).owner
  const other = owners.register({
    pid: 102,
    label: "second session",
    source: "startup",
    agent: "claude",
    cwd: process.cwd(),
  }).owner
  const pages = createPages(db, { randomToken: () => PageToken.parse("a".repeat(40)) })
  const page = pages.open({
    target: { kind: "server", upstream: "http://localhost:3000", extras: [] },
    projectRoot: process.cwd(),
    poolPorts: [3990],
  }).page
  const second = pages.open({
    target: { kind: "server", upstream: "http://localhost:3001", extras: [] },
    projectRoot: process.cwd(),
    poolPorts: [3990],
  }).page
  const inbox = createInbox(db, {
    now: () => new Date(at),
    ownerState: owners.state,
    pairing: (pageId) => {
      const link = pages.get(pageId)?.page.pairing
      return link ? owners.pairing(link.owner, link.generation, "none") : null
    },
  })
  const conversation = inbox.conversation
  function pair(pageId = page.id, ownerId = owner) {
    owners.pairPage(pageId, ownerId)
    inbox.requeuePage(pageId, ownerId)
  }
  function post(key = "chat-key-one", pageId = page.id, ownerId = owner) {
    return conversation.post(pageId, ownerId, {
      idempotencyKey: IdempotencyKey.parse(key),
      generation: PairingGeneration.parse(1),
      text: `Message ${key}`,
    })
  }
  function send() {
    const note = inbox.createDraft(
      page.id,
      DraftBody.parse({
        intent: "fix",
        body: "Heading",
        anchorStatus: "anchored",
        target: {
          kind: "region",
          box: { x: 0, y: 0, width: 20, height: 20 },
          viewport: { width: 800, height: 600, devicePixelRatio: 1 },
        },
      }),
    )
    const result = inbox.send(page.id, {
      idempotencyKey: IdempotencyKey.parse(`send-key-${note.id}`),
      generation: pages.get(page.id)?.page.pairing?.generation ?? PairingGeneration.parse(0),
      noteIds: [note.id],
    })
    if (result.outcome !== "accepted") throw new Error(result.reason)
    return result.round
  }
  return { db, owners, pages, page, second, owner, other, inbox, conversation, pair, post, send }
}

describe("message paging", () => {
  test.each([0, 1, 3, 4])("newest three of %s messages with and without a cursor", (count) => {
    const { conversation, page, post } = setup()
    for (let i = 1; i <= count; i++) post(`chat-key-${i}`)
    for (const before of [null, MessageId.parse("M999"), MessageId.parse("M3")]) {
      const available = before === "M3" ? Math.min(count, 2) : count
      const expected = Array.from({ length: Math.min(available, 3) }, (_, i) =>
        MessageId.parse(`M${Math.max(1, available - 2) + i}`),
      )
      const result = conversation.list(page.id, { before, limit: 3 })
      expect(result.messages.map((message) => message.id)).toEqual(expected)
      expect(result.hasOlder).toBe(available > 3)
    }
  })

  test("numeric cursors page older messages and exclude messages on other pages", () => {
    const { conversation, page, second, post } = setup()
    for (let i = 1; i <= 12; i++) post(`chat-key-${i}`)
    post("another-page", second.id)
    expect(
      conversation.list(page.id, { before: null, limit: 3 }).messages.map((message) => message.id),
    ).toEqual(["M10", "M11", "M12"].map((id) => MessageId.parse(id)))
    expect(conversation.list(page.id, { before: MessageId.parse("M10"), limit: 3 })).toMatchObject({
      messages: [{ id: "M7" }, { id: "M8" }, { id: "M9" }],
      hasOlder: true,
    })
    expect(conversation.list(page.id, { before: MessageId.parse("M1"), limit: 3 })).toEqual({
      messages: [],
      hasOlder: false,
    })
  })
})

test("posting is idempotent per page and uses the highest numeric round or null", () => {
  const s = setup()
  s.pair()
  const first = s.post()
  expect(first).toMatchObject({
    id: "M1",
    pageId: s.page.id,
    roundId: null,
    text: "Message chat-key-one",
    at,
    author: { kind: "page", idempotencyKey: "chat-key-one", delivery: { status: "queued" } },
  })
  expect(s.conversation.byKey(s.page.id, IdempotencyKey.parse("unknown-key"))).toBeNull()
  expect(s.post()).toEqual(first)
  expect(s.conversation.byKey(s.page.id, IdempotencyKey.parse("chat-key-one"))).toEqual(first)
  for (let i = 0; i < 12; i++) s.send()
  expect(s.post("after-rounds").roundId).toBe(RoundId.parse("R12"))
  expect(s.post("chat-key-one", s.second.id).id).toBe(MessageId.parse("M3"))
})

test("transcripts require a focus whose page still pairs with the owner, including after a claim", () => {
  const s = setup()
  expect(s.conversation.focus(s.owner)).toBeNull()
  expect(s.conversation.appendTranscript(s.owner, [row()])).toEqual({ pageId: null, stored: [] })
  s.pair()
  expect(s.conversation.focus(s.owner)).toEqual({ pageId: s.page.id, roundId: null })
  expect(s.conversation.appendTranscript(s.owner, [row()])).toMatchObject({
    pageId: s.page.id,
    stored: [
      {
        roundId: null,
        at,
        author: { kind: "agent", owner: s.owner, name: "first session", agent: "claude" },
      },
    ],
  })
  const round = s.send()
  s.inbox.claim(round.id)
  expect(s.conversation.focus(s.owner)).toEqual({ pageId: s.page.id, roundId: round.id })
  expect(
    s.conversation.appendTranscript(s.owner, [row("user-row", "user", "Please continue")]),
  ).toMatchObject({
    stored: [
      { roundId: round.id, author: { kind: "user", owner: s.owner }, text: "Please continue" },
    ],
  })
  s.pair(s.page.id, s.other)
  expect(s.conversation.appendTranscript(s.owner, [row("after-repair")])).toEqual({
    pageId: null,
    stored: [],
  })
  expect(s.conversation.appendTranscript(s.other, [row("after-repair")])).toMatchObject({
    pageId: s.page.id,
    stored: [{ roundId: null, author: { owner: s.other } }],
  })
  s.db.query("UPDATE pages SET owner_id = NULL WHERE id = ?").run(s.page.id)
  expect(s.conversation.appendTranscript(s.other, [row("unpaired")])).toEqual({
    pageId: null,
    stored: [],
  })
})

test("taking page messages updates focus, keeps the round on the same page, and follows current pairing", () => {
  const s = setup()
  s.pair()
  const round = s.send()
  s.inbox.claim(round.id)
  const first = s.post()
  expect(s.conversation.takeQueued(s.owner)).toMatchObject([
    { id: first.id, author: { delivery: { status: "delivered", at } } },
  ])
  expect(s.conversation.focus(s.owner)).toEqual({ pageId: s.page.id, roundId: round.id })
  expect(s.conversation.takeQueued(s.owner)).toEqual([])
  s.owners.pairPage(s.second.id, s.owner)
  const second = s.post("second-message", s.second.id)
  expect(s.conversation.takeQueued(s.other)).toEqual([])
  expect(s.conversation.takeQueued(s.owner).map((message) => message.id)).toEqual([second.id])
  expect(s.conversation.focus(s.owner)).toEqual({ pageId: s.second.id, roundId: null })
  s.post("reassigned-message")
  s.owners.pairPage(s.page.id, s.other)
  expect(s.conversation.takeQueued(s.owner)).toEqual([])
  expect(s.conversation.takeQueued(s.other)).toHaveLength(1)
  expect(s.conversation.focus(s.other)).toEqual({ pageId: s.page.id, roundId: null })
})

test("takeQueued and failQueued finish all queued page messages and leave terminal and transcript rows alone", () => {
  const s = setup()
  s.pair()
  s.pair(s.second.id)
  s.conversation.appendTranscript(s.owner, [row()])
  const first = s.post("first-message")
  const second = s.post("second-message", s.second.id)
  expect(s.conversation.takeQueued(s.owner).map((message) => message.id)).toEqual([
    first.id,
    second.id,
  ])
  const third = s.post("third-message")
  const fourth = s.post("fourth-message", s.second.id)
  expect(s.conversation.failQueued(s.other)).toEqual([])
  expect(s.conversation.failQueued(s.owner)).toMatchObject([
    { id: third.id, author: { delivery: { status: "failed", reason: "session-gone" } } },
    { id: fourth.id, author: { delivery: { status: "failed", reason: "session-gone" } } },
  ])
  expect(s.conversation.takeQueued(s.owner)).toEqual([])
  expect(s.conversation.failQueued(s.owner)).toEqual([])
  expect(s.conversation.focus(s.owner)).toEqual({ pageId: s.second.id, roundId: null })
})

test("page message delivery only moves from queued to delivered or failed and never back", () => {
  fc.assert(
    fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 30 }), (deliveries) => {
      const s = setup()
      try {
        s.pair()
        const first = s.post()
        expect(first.author).toMatchObject({ delivery: { status: "queued" } })
        const terminal = deliveries[0] ? "delivered" : "failed"
        for (const [index, deliver] of deliveries.entries()) {
          const changed = deliver
            ? s.conversation.takeQueued(s.owner)
            : s.conversation.failQueued(s.owner)
          expect(changed).toHaveLength(index === 0 ? 1 : 0)
          expect(s.post().author).toMatchObject({ delivery: { status: terminal } })
          expect(
            s.conversation.byKey(s.page.id, IdempotencyKey.parse("chat-key-one"))?.author,
          ).toMatchObject({ delivery: { status: terminal } })
        }
      } finally {
        s.db.close()
      }
    }),
  )
})

test("forwarded user text containing a pointer line or page-message block is never stored", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 100 }),
      fc.string({ maxLength: 100 }),
      fc.boolean(),
      (prefix, suffix, pointer) => {
        const s = setup()
        try {
          s.pair()
          const delivery = pointer
            ? formatPointer({ roundId: RoundId.parse("R7"), pageId: s.page.id, noteCount: 3 })
            : formatPageMessage({
                id: MessageId.parse("M7"),
                pageId: s.page.id,
                text: "Page request",
              })
          const text = `${prefix}\n${delivery}\r\n${suffix}`
          expect(
            s.conversation.appendTranscript(s.owner, [row("forwarded", "user", text)]),
          ).toEqual({ pageId: s.page.id, stored: [] })
          expect(s.conversation.list(s.page.id, { before: null, limit: 100 }).messages).toEqual([])
          expect(
            s.conversation.appendTranscript(s.owner, [row("assistant", "assistant", text)]).stored,
          ).toHaveLength(1)
        } finally {
          s.db.close()
        }
      },
    ),
  )
})

test("random transcript batches store each owner and key once with strictly ascending ids", () => {
  fc.assert(
    fc.property(
      fc.array(fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 10 }), { maxLength: 10 }),
      (batches) => {
        const s = setup()
        try {
          s.pair()
          s.pair(s.second.id, s.other)
          const seen = new Map<string, string>()
          let last = 0
          for (const batch of batches) {
            for (const owner of [s.owner, s.other]) {
              const expected = batch.filter((key) => {
                const scoped = `${owner}:${key}`
                if (seen.has(scoped)) return false
                seen.set(scoped, `Text ${key}`)
                return true
              })
              const result = s.conversation.appendTranscript(
                owner,
                batch.map((key) => row(`key-${key}`, "assistant", `Text ${key}`)),
              )
              expect(result.stored.map((message) => message.text)).toEqual(
                expected.map((key) => `Text ${key}`),
              )
              for (const message of result.stored) {
                const ordinal = Number(message.id.slice(1))
                expect(ordinal).toBeGreaterThan(last)
                last = ordinal
              }
            }
          }
          expect(s.db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: seen.size })
        } finally {
          s.db.close()
        }
      },
    ),
  )
})

test("transcript keys remain deduplicated when an owner moves to another focus page", () => {
  const s = setup()
  s.pair()
  expect(s.conversation.appendTranscript(s.owner, [row()]).stored).toHaveLength(1)
  s.pair(s.second.id)
  expect(s.conversation.appendTranscript(s.owner, [row()])).toEqual({
    pageId: s.second.id,
    stored: [],
  })
  expect(s.conversation.list(s.second.id, { before: null, limit: 100 })).toEqual({
    messages: [],
    hasOlder: false,
  })
})

test("a transcript batch rolls back messages and sequence allocation if a row cannot be stored", () => {
  const s = setup()
  s.pair()
  expect(() =>
    s.conversation.appendTranscript(s.owner, [row(), { ...row("invalid"), text: "" }]),
  ).toThrow()
  expect(s.conversation.list(s.page.id, { before: null, limit: 100 })).toEqual({
    messages: [],
    hasOlder: false,
  })
  expect(s.conversation.appendTranscript(s.owner, [row()]).stored[0]?.id).toBe(
    MessageId.parse("M1"),
  )
})

describe("chat settings", () => {
  test.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.2:3000", true],
    ["http://[::1]:3000", true],
    ["http://app.localhost:3000", true],
    ["http://192.168.1.20:3000", false],
    ["http://localhost.example.com", false],
    ["http://example.com/localhost", false],
    ["http://128.0.0.1", false],
  ])("%s defaults chat to %s", (upstream, enabled) => {
    const { conversation, page } = setup()
    const target = Page.parse({ ...page, target: { kind: "server", upstream, extraUpstreams: [] } })
    expect(conversation.chatSetting(target, false)).toEqual({
      enabled,
      defaultEnabled: enabled,
      reachable: false,
    })
    conversation.setChat(page.id, !enabled)
    expect(conversation.chatSetting(target, true)).toEqual({
      enabled: !enabled,
      defaultEnabled: enabled,
      reachable: true,
    })
    conversation.setChat(page.id, enabled)
    expect(conversation.chatSetting(target, false).enabled).toBe(enabled)
  })

  test("folder pages default to enabled", () => {
    const { conversation, page } = setup()
    expect(
      conversation.chatSetting(
        Page.parse({ ...page, target: { kind: "folder", root: process.cwd() } }),
        true,
      ),
    ).toEqual({ enabled: true, defaultEnabled: true, reachable: true })
  })
})
