import { afterEach, expect, test } from "bun:test"
import { OwnerId } from "@iter8/protocol"
import { createWaiters, type Waiters } from "./waiters"

const owner = OwnerId.parse("owner-one")
const otherOwner = OwnerId.parse("owner-two")
const clockOwner = OwnerId.parse("clock-owner")
const instances: Waiters[] = []

afterEach(() => {
  for (const waiters of instances.splice(0)) waiters.cancelAll()
})

function freshWaiters() {
  const waiters = createWaiters()
  instances.push(waiters)
  return waiters
}

test("wake resolves an armed wait and removes it immediately", async () => {
  const waiters = freshWaiters()
  const outcome = waiters.arm(owner, 50)
  expect(waiters.isArmed(owner)).toBe(true)

  waiters.wake(owner)

  expect(waiters.isArmed(owner)).toBe(false)
  expect(await outcome).toBe("woken")
})

test("a new arm replaces only the same owner's earlier wait", async () => {
  const waiters = freshWaiters()
  const first = waiters.arm(owner, 50)
  const other = waiters.arm(otherOwner, 50)
  const replacement = waiters.arm(owner, 50)

  expect(await first).toBe("replaced")
  expect(waiters.isArmed(owner)).toBe(true)
  expect(waiters.isArmed(otherOwner)).toBe(true)
  waiters.wake(owner)
  expect(await replacement).toBe("woken")
  expect(waiters.isArmed(otherOwner)).toBe(true)
  waiters.wake(otherOwner)
  expect(await other).toBe("woken")
})

test("wake of an unarmed owner leaves other waits and future arms unchanged", async () => {
  const waiters = freshWaiters()
  const other = waiters.arm(otherOwner, 50)

  waiters.wake(owner)

  expect(waiters.isArmed(owner)).toBe(false)
  expect(waiters.isArmed(otherOwner)).toBe(true)
  const future = waiters.arm(owner, 20)
  expect(await future).toBe("timeout")
  waiters.wake(otherOwner)
  expect(await other).toBe("woken")
})

test("timeout resolves the wait and removes the owner", async () => {
  const waiters = freshWaiters()
  const outcome = waiters.arm(owner, 20)
  expect(waiters.isArmed(owner)).toBe(true)

  expect(await outcome).toBe("timeout")
  expect(waiters.isArmed(owner)).toBe(false)
  waiters.wake(owner)
  expect(waiters.isArmed(owner)).toBe(false)
})

test("a replaced wait's old deadline cannot settle its replacement", async () => {
  const waiters = freshWaiters()
  const first = waiters.arm(owner, 20)
  const replacement = waiters.arm(owner, 100)
  expect(await first).toBe("replaced")

  expect(await waiters.arm(clockOwner, 40)).toBe("timeout")

  expect(waiters.isArmed(owner)).toBe(true)
  waiters.wake(owner)
  expect(await replacement).toBe("woken")
})

test("cancelAll resolves every wait, clears armed state, and is idempotent", async () => {
  const waiters = freshWaiters()
  const first = waiters.arm(owner, 50)
  const second = waiters.arm(otherOwner, 50)

  waiters.cancelAll()
  waiters.cancelAll()

  expect(waiters.isArmed(owner)).toBe(false)
  expect(waiters.isArmed(otherOwner)).toBe(false)
  expect(await first).toBe("cancelled")
  expect(await second).toBe("cancelled")
})

test.each(["wake", "cancelAll"] as const)("%s clears the old timer", async (method) => {
  const waiters = freshWaiters()
  const first = waiters.arm(owner, 20)
  if (method === "wake") waiters.wake(owner)
  else waiters.cancelAll()
  expect(await first).toBe(method === "wake" ? "woken" : "cancelled")
  const next = waiters.arm(owner, 100)

  expect(await waiters.arm(clockOwner, 40)).toBe("timeout")

  expect(waiters.isArmed(owner)).toBe(true)
  waiters.wake(owner)
  expect(await next).toBe("woken")
})

test("an owner can arm again after timing out", async () => {
  const waiters = freshWaiters()
  expect(await waiters.arm(owner, 20)).toBe("timeout")

  const next = waiters.arm(owner, 50)
  expect(waiters.isArmed(owner)).toBe(true)
  waiters.wake(owner)
  expect(await next).toBe("woken")
})

test("waiter factories have independent owner state", async () => {
  const first = freshWaiters()
  const second = freshWaiters()
  const outcome = first.arm(owner, 50)

  second.wake(owner)
  second.cancelAll()

  expect(first.isArmed(owner)).toBe(true)
  expect(second.isArmed(owner)).toBe(false)
  first.wake(owner)
  expect(await outcome).toBe("woken")
})
