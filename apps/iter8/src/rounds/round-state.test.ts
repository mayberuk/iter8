import { describe, expect, test } from "bun:test"
import {
  IdempotencyKey,
  PairingGeneration,
  ROUND_TRANSITIONS,
  type RoundStage,
  RoundState,
} from "@iter8/protocol"
import fc from "fast-check"
import { nextRoundState, type RoundEvent } from "./round-state"

const queuedAt = "2026-10-09T18:00:00.000Z"
const later = "2026-10-09T18:05:00.000Z"
const idempotencyKey = IdempotencyKey.parse("send-7c1e9b2a40d3")
const generation = PairingGeneration.parse(3)
const queued = RoundState.parse({ stage: "queued", queuedAt, idempotencyKey })
const announced = RoundState.parse({
  stage: "announced",
  queuedAt,
  idempotencyKey,
  announcedAt: "2026-10-09T18:01:00.000Z",
  generation,
})

function edgeListed(from: RoundStage, to: RoundStage): boolean {
  const targets: readonly RoundStage[] = ROUND_TRANSITIONS[from]
  return targets.includes(to)
}

describe("the next state carries the fields each stage records", () => {
  test("announcing adds the announcement time and the page's generation", () => {
    expect(nextRoundState(queued, { to: "announced", generation }, later)).toEqual({
      stage: "announced",
      queuedAt,
      idempotencyKey,
      announcedAt: later,
      generation,
    })
  })

  test("claiming an announced round keeps its announcement and adds the claim time", () => {
    expect(nextRoundState(announced, { to: "claimed" }, later)).toEqual({
      stage: "claimed",
      queuedAt,
      idempotencyKey,
      announcedAt: "2026-10-09T18:01:00.000Z",
      generation,
      claimedAt: later,
    })
  })

  test("claiming a round never announced records no announcement", () => {
    expect(nextRoundState(queued, { to: "claimed" }, later)).toEqual({
      stage: "claimed",
      queuedAt,
      idempotencyKey,
      claimedAt: later,
    })
  })

  test("orphaning adds the orphan time and keeps the queue time and key", () => {
    expect(nextRoundState(queued, { to: "orphaned" }, later)).toEqual({
      stage: "orphaned",
      queuedAt,
      idempotencyKey,
      orphanedAt: later,
    })
  })

  test("requeuing an orphan keeps the queue time and key and adds the requeue time", () => {
    const orphan = RoundState.parse({
      stage: "orphaned",
      queuedAt,
      idempotencyKey,
      orphanedAt: later,
    })
    const requeueAt = "2026-10-09T18:09:00.000Z"
    expect(nextRoundState(orphan, { to: "queued" }, requeueAt)).toEqual({
      stage: "queued",
      queuedAt,
      idempotencyKey,
      requeuedAt: requeueAt,
    })
  })

  test("requeuing an announced round drops its announcement so it is announced afresh", () => {
    expect(nextRoundState(announced, { to: "queued" }, later)).toEqual({
      stage: "queued",
      queuedAt,
      idempotencyKey,
      requeuedAt: later,
    })
  })

  test("a requeued round keeps its requeue time through announcement and claim", () => {
    const requeued = RoundState.parse({ ...queued, requeuedAt: later })
    const claimAt = "2026-10-09T18:20:00.000Z"
    expect(nextRoundState(requeued, { to: "claimed" }, claimAt)).toEqual({
      stage: "claimed",
      queuedAt,
      idempotencyKey,
      requeuedAt: later,
      claimedAt: claimAt,
    })
  })

  test("a draft round is refused even on its listed edge, since send queues rounds directly", () => {
    expect(nextRoundState({ stage: "draft" }, { to: "queued" }, later)).toHaveProperty("refused")
  })
})

const eventArbitrary: fc.Arbitrary<RoundEvent> = fc.oneof(
  fc
    .nat({ max: 50 })
    .map((value) => ({ to: "announced" as const, generation: PairingGeneration.parse(value) })),
  fc.constant({ to: "claimed" as const }),
  fc.constant({ to: "orphaned" as const }),
  fc.constant({ to: "queued" as const }),
)

test("a round only moves forward through its states", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<RoundState>(queued, announced),
      fc.array(eventArbitrary, { maxLength: 30 }),
      fc.array(
        fc.date({
          min: new Date("2000-01-01T00:00:00.000Z"),
          max: new Date("2099-12-31T23:59:59.999Z"),
          noInvalidDate: true,
        }),
        { minLength: 30, maxLength: 30 },
      ),
      (start, events, dates) => {
        let state = start
        let claimed = false
        for (const [index, event] of events.entries()) {
          const next = nextRoundState(state, event, (dates[index] ?? new Date(0)).toISOString())
          if (claimed) expect(next).toHaveProperty("refused")
          if ("refused" in next) {
            expect(edgeListed(state.stage, event.to)).toBe(false)
            continue
          }
          expect(edgeListed(state.stage, next.stage)).toBe(true)
          expect(next.stage).toBe(event.to)
          expect(RoundState.parse(next)).toEqual(next)
          expect(next).toMatchObject({ queuedAt, idempotencyKey })
          state = next
          claimed = next.stage === "claimed"
        }
      },
    ),
  )
})
