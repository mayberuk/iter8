import type { Database } from "bun:sqlite"
import {
  type ChatSetting,
  ConversationMessage,
  type IdempotencyKey,
  type MessageAuthor,
  type MessageDelivery,
  type MessageId,
  type MessagePage,
  type OwnerId,
  PAGE_MESSAGE_OPEN,
  type Page,
  PageId,
  type Pairing,
  POINTER_LINE,
  type PostMessageRequest,
  RoundId,
  type TranscriptRow,
} from "@iter8/protocol"
import { nextSequence } from "../store/db"

type Focus = Pick<ConversationMessage, "pageId" | "roundId">

export type Conversation = {
  list(pageId: PageId, query: { before: MessageId | null; limit: number }): MessagePage
  byKey(pageId: PageId, key: IdempotencyKey): ConversationMessage | null
  post(pageId: PageId, ownerId: OwnerId, request: PostMessageRequest): ConversationMessage
  appendTranscript(
    ownerId: OwnerId,
    rows: TranscriptRow[],
  ): {
    pageId: PageId | null
    stored: ConversationMessage[]
  }
  takeQueued(ownerId: OwnerId): ConversationMessage[]
  failQueued(ownerId: OwnerId): ConversationMessage[]
  setFocus(ownerId: OwnerId, pageId: PageId, roundId: RoundId | null): void
  focus(ownerId: OwnerId): Focus | null
  chatSetting(page: Page, reachable: boolean): ChatSetting
  setChat(pageId: PageId, enabled: boolean): void
}

type MessageRow = {
  id: string
  page_id: string
  round_id: string | null
  author_json: string
  text: string
  at: string
}

const MESSAGE_COLUMNS = "id, page_id, round_id, author_json, text, at"

function messageFromRow(row: MessageRow): ConversationMessage {
  return ConversationMessage.parse({
    id: row.id,
    pageId: row.page_id,
    roundId: row.round_id,
    author: JSON.parse(row.author_json),
    text: row.text,
    at: row.at,
  })
}

export function createConversation(
  db: Database,
  deps: { now: () => Date; pairing: (pageId: PageId) => Pairing | null },
): Conversation {
  const byDedupeKey = db.query<MessageRow, [string]>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE dedupe_key = ?`,
  )
  const insert = db.query<
    MessageRow,
    [string, string, string | null, string, string, string, string, string, number]
  >(
    `INSERT INTO messages (id, page_id, round_id, owner_id, author_json, text, dedupe_key, at, ordinal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING ${MESSAGE_COLUMNS}`,
  )
  const queued = db.query<MessageRow, [string]>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE page_id IN (SELECT id FROM pages WHERE owner_id = ?)
       AND json_extract(author_json, '$.kind') = 'page'
       AND json_extract(author_json, '$.delivery.status') = 'queued'
     ORDER BY ordinal`,
  )

  function focus(ownerId: OwnerId): Focus | null {
    const row = db
      .query<{ page_id: string; round_id: string | null }, [string]>(
        "SELECT page_id, round_id FROM owner_focus WHERE owner_id = ?",
      )
      .get(ownerId)
    return row
      ? {
          pageId: PageId.parse(row.page_id),
          roundId: row.round_id === null ? null : RoundId.parse(row.round_id),
        }
      : null
  }

  function setFocus(ownerId: OwnerId, pageId: PageId, roundId: RoundId | null): void {
    db.query(
      `INSERT INTO owner_focus (owner_id, page_id, round_id, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_id) DO UPDATE SET page_id = excluded.page_id,
         round_id = excluded.round_id, at = excluded.at`,
    ).run(ownerId, pageId, roundId, deps.now().toISOString())
  }

  function store(
    pageId: PageId,
    roundId: RoundId | null,
    ownerId: OwnerId,
    author: MessageAuthor,
    text: string,
    dedupeKey: string,
    at: string,
  ): ConversationMessage | null {
    const ordinal = nextSequence(db, "message_seq")
    const message = ConversationMessage.parse({
      id: `M${ordinal}`,
      pageId,
      roundId,
      author,
      text,
      at,
    })
    const row = insert.get(
      message.id,
      pageId,
      roundId,
      ownerId,
      JSON.stringify(message.author),
      message.text,
      dedupeKey,
      message.at,
      ordinal,
    )
    return row ? messageFromRow(row) : null
  }

  const finishQueued = db.transaction(
    (ownerId: OwnerId, delivery: MessageDelivery): ConversationMessage[] => {
      return queued.all(ownerId).map((row) => {
        const message = messageFromRow(row)
        if (message.author.kind !== "page")
          throw new Error(`Queued message ${message.id} is not from a page`)
        const author = { ...message.author, delivery }
        const updated = db
          .query<MessageRow, [string, string]>(
            `UPDATE messages SET author_json = ? WHERE id = ? RETURNING ${MESSAGE_COLUMNS}`,
          )
          .get(JSON.stringify(author), message.id)
        if (!updated)
          throw new Error(`Queued message ${message.id} vanished inside its transaction`)
        if (delivery.status === "delivered") {
          const previous = focus(ownerId)
          setFocus(
            ownerId,
            message.pageId,
            previous?.pageId === message.pageId ? previous.roundId : null,
          )
        }
        return messageFromRow(updated)
      })
    },
  )

  return {
    list(pageId, { before, limit }) {
      const rows = db
        .query<MessageRow, [string, number | null, number | null, number]>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE page_id = ? AND (? IS NULL OR ordinal < ?)
           ORDER BY ordinal DESC LIMIT ?`,
        )
        .all(
          pageId,
          before === null ? null : Number(before.slice(1)),
          before === null ? null : Number(before.slice(1)),
          limit + 1,
        )
      return {
        messages: rows.slice(0, limit).reverse().map(messageFromRow),
        hasOlder: rows.length > limit,
      }
    },
    byKey(pageId, key) {
      const row = byDedupeKey.get(`chat:${pageId}:${key}`)
      return row ? messageFromRow(row) : null
    },
    post: db.transaction(
      (pageId: PageId, ownerId: OwnerId, request: PostMessageRequest): ConversationMessage => {
        const dedupeKey = `chat:${pageId}:${request.idempotencyKey}`
        const existing = byDedupeKey.get(dedupeKey)
        if (existing) return messageFromRow(existing)
        const round = db
          .query<{ id: string }, [string]>(
            "SELECT id FROM rounds WHERE page_id = ? ORDER BY CAST(substr(id, 2) AS INTEGER) DESC LIMIT 1",
          )
          .get(pageId)
        const message = store(
          pageId,
          round ? RoundId.parse(round.id) : null,
          ownerId,
          { kind: "page", idempotencyKey: request.idempotencyKey, delivery: { status: "queued" } },
          request.text,
          dedupeKey,
          deps.now().toISOString(),
        )
        if (!message) throw new Error(`Message key ${dedupeKey} conflicted inside its transaction`)
        return message
      },
    ),
    appendTranscript: db.transaction((ownerId: OwnerId, rows: TranscriptRow[]) => {
      const current = focus(ownerId)
      const pairing = current && deps.pairing(current.pageId)
      if (!current || !pairing || pairing.owner !== ownerId) return { pageId: null, stored: [] }
      const stored: ConversationMessage[] = []
      for (const row of rows) {
        if (
          row.role === "user" &&
          (row.text.split(/\r?\n/).some((line) => POINTER_LINE.test(line)) ||
            PAGE_MESSAGE_OPEN.test(row.text))
        )
          continue
        const message = store(
          current.pageId,
          current.roundId,
          ownerId,
          row.role === "assistant"
            ? { kind: "agent", owner: ownerId, name: pairing.process.label, agent: pairing.agent }
            : { kind: "user", owner: ownerId },
          row.text,
          `transcript:${ownerId}:${row.key}`,
          row.at,
        )
        if (message) stored.push(message)
      }
      return { pageId: current.pageId, stored }
    }),
    takeQueued: (ownerId) =>
      finishQueued(ownerId, { status: "delivered", at: deps.now().toISOString() }),
    failQueued: (ownerId) => finishQueued(ownerId, { status: "failed", reason: "session-gone" }),
    setFocus,
    focus,
    chatSetting(page, reachable) {
      const hostname = page.target.kind === "server" ? new URL(page.target.upstream).hostname : null
      const defaultEnabled =
        hostname === null ||
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/.test(hostname) ||
        hostname === "::1" ||
        hostname === "[::1]"
      const row = db
        .query<{ enabled: number }, [string]>("SELECT enabled FROM page_chat WHERE page_id = ?")
        .get(page.id)
      return { enabled: row ? row.enabled === 1 : defaultEnabled, defaultEnabled, reachable }
    },
    setChat(pageId, enabled) {
      db.query(
        `INSERT INTO page_chat (page_id, enabled) VALUES (?, ?)
         ON CONFLICT (page_id) DO UPDATE SET enabled = excluded.enabled`,
      ).run(pageId, enabled ? 1 : 0)
    },
  }
}
