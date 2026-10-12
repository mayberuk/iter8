import { describe, expect, test } from "bun:test"
import {
  AgentAuthor,
  ConversationMessage,
  IdempotencyKey,
  type MessageDelivery,
  MessageId,
  OwnerId,
  Pairing,
  RoundId,
} from "@iter8/protocol"
import fc from "fast-check"
import messageJson from "../../../packages/protocol/fixtures/ConversationMessage.page.json"
import pairingJson from "../../../packages/protocol/fixtures/Pairing.json"
import {
  authorIdentity,
  chatBlockedReason,
  GROUP_WINDOW_MS,
  groupRuns,
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
  test("a settled page message is not replaced by a late queued copy", () => {
    const withDelivery = (delivery: MessageDelivery): ConversationMessage => ({
      ...base,
      author: { kind: "page", idempotencyKey: IdempotencyKey.parse("chat-key-0001"), delivery },
    })
    const queued = withDelivery({ status: "queued" })
    const delivered = withDelivery({ status: "delivered", at: base.at })
    const failed = withDelivery({ status: "failed", reason: "session-gone" })
    expect(mergeMessages([delivered], [queued])).toEqual([delivered])
    expect(mergeMessages([failed], [queued])).toEqual([failed])
    expect(mergeMessages([queued], [failed])).toEqual([failed])
  })
  test("property: a page message's delivery ends at the furthest state, whatever the arrival order", () => {
    const settled = fc.constantFrom<MessageDelivery>(
      { status: "delivered", at: base.at },
      { status: "failed", reason: "session-gone" },
    )
    fc.assert(
      fc.property(settled, fc.array(fc.boolean(), { minLength: 1 }), (final, arrivals) => {
        const queued: MessageDelivery = { status: "queued" }
        const copy = (delivery: MessageDelivery): ConversationMessage => ({
          ...base,
          author: { kind: "page", idempotencyKey: IdempotencyKey.parse("chat-key-0001"), delivery },
        })
        const merged = arrivals.reduce<ConversationMessage[]>(
          (held, isFinal) => mergeMessages(held, [copy(isFinal ? final : queued)]),
          [],
        )
        const author = merged[0]?.author
        expect(author?.kind === "page" ? author.delivery : null).toEqual(
          arrivals.includes(true) ? final : queued,
        )
      }),
    )
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

describe("groupRuns", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 9, 10, 0, 0) + ms).toISOString()
  const row = (identity: string, ms: number, round: string | null = null) => ({
    identity,
    roundId: round === null ? null : RoundId.parse(round),
    at: at(ms),
  })
  const shape = (rows: ReturnType<typeof row>[]) =>
    groupRuns(rows).map(({ head, last }) => `${head ? "H" : "-"}${last ? "L" : "-"}`)

  test("a row continues the one above from the same speaker up to the window and not past it", () => {
    expect(GROUP_WINDOW_MS).toBe(5 * 60 * 1000)
    expect(shape([row("a", 0), row("a", GROUP_WINDOW_MS)])).toEqual(["H-", "-L"])
    expect(shape([row("a", 0), row("a", GROUP_WINDOW_MS + 1)])).toEqual(["HL", "HL"])
  })

  test("another speaker starts a run", () => {
    expect(shape([row("a", 0), row("b", 1000), row("a", 2000)])).toEqual(["HL", "HL", "HL"])
  })

  test("a round divider between two rows splits them, but a row with no round does not", () => {
    expect(shape([row("a", 0, "R1"), row("a", 1000, "R2")])).toEqual(["HL", "HL"])
    expect(shape([row("a", 0, "R1"), row("a", 1000, "R1")])).toEqual(["H-", "-L"])
    expect(shape([row("a", 0, "R1"), row("a", 1000)])).toEqual(["H-", "-L"])
  })

  test("nothing at all, and one row", () => {
    expect(groupRuns([])).toEqual([])
    expect(shape([row("a", 0)])).toEqual(["HL"])
  })

  const rows = fc.array(
    fc.record({
      identity: fc.constantFrom("a", "b", "c"),
      round: fc.constantFrom(null, "R1", "R2", "R3"),
      gap: fc.integer({ min: 0, max: GROUP_WINDOW_MS * 2 }),
    }),
    { maxLength: 40 },
  )
  const timed = (specs: { identity: string; round: string | null; gap: number }[]) => {
    let clock = 0
    return specs.map(({ identity, round, gap }) => {
      clock += gap
      return row(identity, clock, round)
    })
  }

  test("property: the first row is always a head and the last row always last", () => {
    fc.assert(
      fc.property(rows, (specs) => {
        const runs = groupRuns(timed(specs))
        expect(runs[0]?.head ?? true).toBe(true)
        expect(runs[runs.length - 1]?.last ?? true).toBe(true)
      }),
    )
  })

  test("property: a row is last exactly when the next one is a head", () => {
    fc.assert(
      fc.property(rows, (specs) => {
        const runs = groupRuns(timed(specs))
        runs.forEach((run, index) => {
          const next = runs[index + 1]
          if (next) expect(run.last).toBe(next.head)
        })
      }),
    )
  })

  test("property: a run never spans a divider, a change of speaker or a gap over the window", () => {
    fc.assert(
      fc.property(rows, (specs) => {
        const items = timed(specs)
        const runs = groupRuns(items)
        items.forEach((item, index) => {
          const before = items[index - 1]
          if (!before) return
          const divided = item.roundId !== null && item.roundId !== before.roundId
          const gap = Date.parse(item.at) - Date.parse(before.at)
          if (divided || item.identity !== before.identity || gap > GROUP_WINDOW_MS) {
            expect(runs[index]?.head).toBe(true)
          }
        })
      }),
    )
  })

  test("property: rows of one speaker, one round and short gaps form a single run", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: GROUP_WINDOW_MS }), { minLength: 1 }),
        (gaps) => {
          let clock = 0
          const items = gaps.map((gap) => {
            clock += gap
            return row("a", clock, "R1")
          })
          const runs = groupRuns(items)
          expect(runs.filter((run) => run.head)).toHaveLength(1)
          expect(runs.filter((run) => run.last)).toHaveLength(1)
        },
      ),
    )
  })
})

describe("authorIdentity", () => {
  const agent = AgentAuthor.parse({
    kind: "agent",
    agent: "claude",
    name: "larkspur",
    owner: "o1",
  })
  test("two agent sessions differ by name or owner, and every page message is one speaker", () => {
    expect(authorIdentity(agent)).not.toBe(authorIdentity({ ...agent, name: "heron" }))
    expect(authorIdentity(agent)).not.toBe(authorIdentity({ ...agent, owner: OwnerId.parse("o2") }))
    expect(authorIdentity(agent)).toBe(authorIdentity({ ...agent }))
    expect(authorIdentity(base.author)).toBe("page")
  })
})
