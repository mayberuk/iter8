import type {
  ChatSetting,
  ConversationMessage,
  IdempotencyKey,
  Pairing,
  PostMessageResult,
} from "@iter8/protocol"

export type PostFailure =
  | Extract<PostMessageResult, { outcome: "refused" }>["reason"]
  | "unreachable-service"
  | "invalid"

export type PendingMessage =
  | { key: IdempotencyKey; text: string; at: string; status: "sending" }
  | { key: IdempotencyKey; text: string; at: string; status: "failed"; reason: PostFailure }

export type ConversationLoad =
  | { status: "unloaded" }
  | { status: "loading" }
  | { status: "ready"; hasOlder: boolean; olderLoading: boolean }
  | { status: "failed" }

export type ChatBlock = "checking" | "no-pairing" | "gone" | "chat-off" | "unreachable"

function deliveryRank(message: ConversationMessage): number {
  return message.author.kind === "page" && message.author.delivery.status === "queued" ? 0 : 1
}

/** A page message's delivery only moves queued to delivered or failed, so a queued copy never replaces a settled one. */
export function mergeMessages(
  held: readonly ConversationMessage[],
  incoming: readonly ConversationMessage[],
): ConversationMessage[] {
  const messages = new Map(held.map((message) => [message.id, message]))
  for (const message of incoming) {
    const current = messages.get(message.id)
    const stale =
      current?.author.kind === "page" &&
      message.author.kind === "page" &&
      deliveryRank(message) < deliveryRank(current)
    if (!stale) messages.set(message.id, message)
  }
  return [...messages.values()].sort((a, b) => {
    const left = BigInt(a.id.slice(1))
    const right = BigInt(b.id.slice(1))
    return left < right ? -1 : left > right ? 1 : 0
  })
}

export function settlePending(
  pending: readonly PendingMessage[],
  messages: readonly ConversationMessage[],
): PendingMessage[] {
  const settled = new Set(
    messages.flatMap((message) =>
      message.author.kind === "page" ? [message.author.idempotencyKey] : [],
    ),
  )
  return pending.filter((message) => !settled.has(message.key))
}

export function chatBlockedReason(
  pairing: Pairing | null,
  chat: ChatSetting | null,
): ChatBlock | null {
  if (!pairing) return "no-pairing"
  if (pairing.state.status === "gone") return "gone"
  if (!chat) return "checking"
  if (!chat.enabled) return "chat-off"
  if (!chat.reachable) return "unreachable"
  return null
}
