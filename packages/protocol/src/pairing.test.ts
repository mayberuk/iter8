import { expect, test } from "bun:test"
import { PairingState } from "./pairing"

test("background work is a pairing state carrying its counts", () => {
  const state = { status: "background", agents: 2, tasks: 0 } as const
  expect(PairingState.parse(state)).toEqual(state)
})

test.each([
  [0, 0],
  [-1, 2],
  [1, -2],
  [1.5, 0],
])("background work with %p agents and %p tasks is refused", (agents, tasks) => {
  expect(PairingState.safeParse({ status: "background", agents, tasks }).success).toBe(false)
})

test("background work without counts is refused", () => {
  expect(PairingState.safeParse({ status: "background" }).success).toBe(false)
})
