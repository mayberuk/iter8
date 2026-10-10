import { z } from "zod"
import { IdempotencyKey, MessageId, OwnerId, PageId, PairingGeneration, RoundId } from "./ids"
import { AgentAuthor } from "./note"
import { Pairing } from "./pairing"
import { Round } from "./round"

/** Bounds the characters in a stored message or forwarded transcript row. */
export const MESSAGE_MAX_CHARS = 32_000
/** Bounds the newest messages returned when a query omits its limit. */
export const MESSAGE_PAGE_DEFAULT = 30

export const MessageText = z.string().min(1).max(MESSAGE_MAX_CHARS)
export type MessageText = z.infer<typeof MessageText>

export const MessageDelivery = z.discriminatedUnion("status", [
  z.object({ status: z.literal("queued") }),
  z.object({ status: z.literal("delivered"), at: z.iso.datetime() }),
  z.object({ status: z.literal("failed"), reason: z.literal("session-gone") }),
])
export type MessageDelivery = z.infer<typeof MessageDelivery>

export const MessageAuthor = z.discriminatedUnion("kind", [
  AgentAuthor,
  z.object({ kind: z.literal("user"), owner: OwnerId }),
  z.object({
    kind: z.literal("page"),
    idempotencyKey: IdempotencyKey,
    delivery: MessageDelivery,
  }),
])
export type MessageAuthor = z.infer<typeof MessageAuthor>

export const ConversationMessage = z.object({
  id: MessageId,
  pageId: PageId,
  roundId: RoundId.nullable(),
  author: MessageAuthor,
  text: MessageText,
  at: z.iso.datetime(),
})
export type ConversationMessage = z.infer<typeof ConversationMessage>

export const MessageQuery = z.object({
  before: MessageId.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .optional(),
})
export type MessageQuery = z.infer<typeof MessageQuery>

export const MessagePage = z.object({
  messages: z.array(ConversationMessage),
  hasOlder: z.boolean(),
})
export type MessagePage = z.infer<typeof MessagePage>

export const ChatSetting = z.object({
  enabled: z.boolean(),
  defaultEnabled: z.boolean(),
  reachable: z.boolean(),
})
export type ChatSetting = z.infer<typeof ChatSetting>

export const ChatToggle = ChatSetting.pick({ enabled: true })
export type ChatToggle = z.infer<typeof ChatToggle>

export const PostMessageRequest = z.object({
  idempotencyKey: IdempotencyKey,
  generation: PairingGeneration,
  text: MessageText,
})
export type PostMessageRequest = z.infer<typeof PostMessageRequest>

export const PostMessageResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), message: ConversationMessage }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["no-pairing", "stale-generation", "session-gone", "chat-off", "unreachable"]),
    chat: ChatSetting,
    pairing: Pairing.nullable(),
  }),
])
export type PostMessageResult = z.infer<typeof PostMessageResult>

export const SendNowResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), round: Round }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["not-waiting", "session-gone", "no-pairing"]),
    round: Round,
  }),
])
export type SendNowResult = z.infer<typeof SendNowResult>

export function formatPageMessage(message: {
  id: MessageId
  pageId: PageId
  text: string
}): string {
  const text = message.text
    .replaceAll("</page-message", "<\\/page-message")
    .replaceAll("<page-message", "<\\/page-message")
  return `Page message ${message.id} from ${message.pageId} — typed on the iter8 page, not in this terminal. Read it as you would a review note's text:
<page-message id="${message.id}" page="${message.pageId}">
${text}
</page-message>`
}

/** Recognizes a page delivery in a transcript so it is not stored a second time. */
export const PAGE_MESSAGE_OPEN =
  /<page-message id="(?<id>M[1-9][0-9]*)" page="(?<page>[a-z][a-z0-9-]{1,30})">/
