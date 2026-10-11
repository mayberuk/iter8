import { describe, expect, test } from "bun:test"
import { ConversationMessage, IdempotencyKey, MessageId, Pairing } from "@iter8/protocol"
import fc from "fast-check"
import messageJson from "../../../packages/protocol/fixtures/ConversationMessage.page.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import {
  chatBlockedReason,
  mergeMessages,
  type PendingMessage,
  settlePending,
} from "./conversation"

const base = ConversationMessage.parse(messageJson)
const pairing = Pairing.parse(pairingJson)
const chat = { enabled: true, defaultEnabled: true, reachable: true }
const message = (id: number): ConversationMessage => ({ ...base, id: MessageId.parse(`M${id}`) })
const ids = fc.array(fc.integer({ min: 1, max: 100_000 }))

describe("mergeMessages", () => {
  test("property: merging is idempotent", () => {
    fc.assert(
      fc.property(ids, ids, (a, b) => {
        const incoming = b.map(message)
        const merged = mergeMessages(a.map(message), incoming)
        expect(mergeMessages(merged, incoming)).toEqual(merged)
      }),
    )
  })
  test("property: message order is independent of arrival order", () => {
    fc.assert(
      fc.property(ids, ids, (a, b) => {
        expect(mergeMessages(a.map(message), b.map(message))).toEqual(
          mergeMessages(b.map(message), a.map(message)),
        )
      }),
    )
  })
  test("property: results have unique strictly ascending numeric ids", () => {
    fc.assert(
      fc.property(ids, ids, (a, b) => {
        const result = mergeMessages(a.map(message), b.map(message))
        expect(result.map((row) => row.id)).toEqual(
          [...new Set([...a, ...b])].sort((x, y) => x - y).map((id) => MessageId.parse(`M${id}`)),
        )
      }),
    )
  })
  test("empty inputs and incoming delivery updates", () => {
    expect(mergeMessages([], [])).toEqual([])
    const delivered: ConversationMessage = {
      ...base,
      author: {
        kind: "page",
        idempotencyKey: IdempotencyKey.parse("chat-key-0001"),
        delivery: { status: "delivered", at: base.at },
      },
    }
    expect(mergeMessages([base], [delivered, delivered])).toEqual([delivered])
  })
  test("message ids keep numeric order beyond safe integer precision", () => {
    const lower = { ...base, id: MessageId.parse("M9007199254740992") }
    const upper = { ...base, id: MessageId.parse("M9007199254740993") }
    expect(mergeMessages([upper], [lower])).toEqual([lower, upper])
  })
})

describe("settlePending", () => {
  test("property: pending is removed iff a page author carries its key, in either reply/event order", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 20 })), ids, (keys, numbers) => {
        const pending: PendingMessage[] = keys.map(
          (n): PendingMessage => ({
            key: IdempotencyKey.parse(`chat-key-${n}`),
            text: "hello",
            at: base.at,
            ...(n % 2 === 0
              ? { status: "sending" as const }
              : { status: "failed" as const, reason: "invalid" as const }),
          }),
        )
        const rows = numbers.map(
          (n, i): ConversationMessage => ({
            ...message(i + 1),
            author:
              n % 3 !== 0
                ? n % 3 === 1
                  ? { kind: "user", owner: pairing.owner }
                  : { kind: "agent", owner: pairing.owner, name: "Claude", agent: "claude" }
                : {
                    kind: "page",
                    idempotencyKey: IdempotencyKey.parse(`chat-key-${(n % 20) + 1}`),
                    delivery: { status: "queued" },
                  },
          }),
        )
        const present = new Set(
          numbers.filter((n) => n % 3 === 0).map((n) => `chat-key-${(n % 20) + 1}`),
        )
        const expected = pending.filter((row) => !present.has(row.key))
        expect(settlePending(pending, rows)).toEqual(expected)
        expect(settlePending(settlePending(pending, rows), [...rows].reverse())).toEqual(expected)
        expect(settlePending(settlePending(pending, [...rows].reverse()), rows)).toEqual(expected)
      }),
    )
  })
  test("empty messages keep failed and sending entries in order", () => {
    const entries: PendingMessage[] = [
      {
        key: IdempotencyKey.parse("chat-key-0001"),
        text: "one",
        at: base.at,
        status: "failed",
        reason: "invalid",
      },
      { key: IdempotencyKey.parse("chat-key-0002"), text: "two", at: base.at, status: "sending" },
    ]
    expect(settlePending(entries, [])).toEqual(entries)
    expect(settlePending([], [base])).toEqual([])
  })
})

describe("chatBlockedReason", () => {
  for (const enabled of [false, true])
    for (const reachable of [false, true]) {
      const setting = { ...chat, enabled, reachable }
      test(`precedence with enabled=${enabled} reachable=${reachable}`, () => {
        expect(chatBlockedReason(null, setting)).toBe("no-pairing")
        expect(
          chatBlockedReason({ ...pairing, state: { status: "gone", reason: "ended" } }, setting),
        ).toBe("gone")
        expect(chatBlockedReason(pairing, setting)).toBe(
          !enabled ? "chat-off" : !reachable ? "unreachable" : null,
        )
      })
    }
  test("absent pairing and gone beat checking", () => {
    expect(chatBlockedReason(null, null)).toBe("no-pairing")
    expect(
      chatBlockedReason({ ...pairing, state: { status: "gone", reason: "ended" } }, null),
    ).toBe("gone")
    expect(chatBlockedReason(pairing, null)).toBe("checking")
  })
  for (const status of ["live", "busy", "unknown"] as const)
    test(`${status} permits reachable enabled chat`, () => {
      expect(chatBlockedReason({ ...pairing, state: { status } }, chat)).toBeNull()
    })
})
