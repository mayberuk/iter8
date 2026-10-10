import { expect, test } from "bun:test"
import { ROUND_STAGE_ORDER, ROUND_TRANSITIONS, RoundStage, RoundState } from "./round"

const edges = Object.entries(ROUND_TRANSITIONS).flatMap(([from, targets]) =>
  targets.map((to: string) => [from, to] as const),
)

test("the transition table names every stage and only stages", () => {
  expect(Object.keys(ROUND_TRANSITIONS).sort()).toEqual([...RoundStage.options].sort())
  for (const [, to] of edges) expect(RoundStage.options).toContain(to as RoundStage)
})

test("the transitions are exactly the stated edges", () => {
  const stated: (readonly [string, string])[] = [
    ["draft", "queued"],
    ["queued", "announced"],
    ["queued", "claimed"],
    ["queued", "orphaned"],
    ["announced", "claimed"],
    ["announced", "orphaned"],
    ["announced", "queued"],
    ["orphaned", "queued"],
  ]
  expect([...edges].sort()).toEqual([...stated].sort())
  expect([...ROUND_TRANSITIONS.draft]).toEqual(["queued"])
  expect([...ROUND_TRANSITIONS.queued].sort()).toEqual(["announced", "claimed", "orphaned"])
  expect([...ROUND_TRANSITIONS.announced].sort()).toEqual(["claimed", "orphaned", "queued"])
})

test("no edge leads back to draft", () => {
  expect(edges.filter(([, to]) => to === "draft")).toEqual([])
})

test("a claimed round goes nowhere", () => {
  expect(ROUND_TRANSITIONS.claimed).toEqual([])
})

test("an orphaned round can only be requeued", () => {
  expect([...ROUND_TRANSITIONS.orphaned]).toEqual(["queued"])
})

test("the forward order is draft, queued, announced, claimed", () => {
  expect([...ROUND_STAGE_ORDER]).toEqual(["draft", "queued", "announced", "claimed"])
})

const at = "2026-10-09T18:35:00.000Z"
const queued = { queuedAt: at, idempotencyKey: "send-now-test", sendNowAt: at }

for (const state of [
  { stage: "queued", ...queued },
  { stage: "announced", ...queued, announcedAt: at, generation: 1 },
  { stage: "claimed", ...queued, announcedAt: at, generation: 1, claimedAt: at },
])
  test(`a ${state.stage} round retains sendNowAt`, () => {
    expect<unknown>(RoundState.parse(state)).toEqual(state)
  })

test("an orphaned round drops sendNowAt", () => {
  expect<unknown>(RoundState.parse({ stage: "orphaned", ...queued, orphanedAt: at })).toEqual({
    stage: "orphaned",
    queuedAt: at,
    idempotencyKey: "send-now-test",
    orphanedAt: at,
  })
})
