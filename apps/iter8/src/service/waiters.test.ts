import { afterEach, expect, test } from "bun:test"
import { OwnerId } from "@iter8/protocol"
import fc from "fast-check"
import { createWaiters, MOD_GRACE_MS, type Waiters, type WaitOutcome } from "./waiters"

const owner = OwnerId.parse("owner-one")
const otherOwner = OwnerId.parse("owner-two")
const clockOwner = OwnerId.parse("clock-owner")
const instances: Waiters[] = []

afterEach(() => {
  for (const waiters of instances.splice(0)) waiters.cancelAll()
})

function freshWaiters(now?: () => number) {
  const waiters = createWaiters(now)
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

test.each(["hook", "mod"] as const)("a %s wait is replaced by the other kind", async (kind) => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const first = kind === "hook" ? waiters.arm(owner, 60_000) : waiters.armMod(owner, 60_000)
  const other = waiters.arm(otherOwner, 60_000)
  now = 1000
  const replacement = kind === "hook" ? waiters.armMod(owner, 60_000) : waiters.arm(owner, 60_000)

  expect(await first).toBe("replaced")
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.modAttached(otherOwner)).toBe(false)
  expect(waiters.isArmed(otherOwner)).toBe(true)
  waiters.wake(owner)
  expect(await replacement).toBe("woken")
  waiters.wake(otherOwner)
  expect(await other).toBe("woken")
})

test("mod presence holds while pending and for less than 5000 ms after settlement", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  expect(MOD_GRACE_MS).toBe(5000)
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.lapsedMods()).toEqual([])
  const outcome = waiters.armMod(owner, 60_000)

  now = 10_000
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.isArmed(owner)).toBe(true)
  expect(waiters.lapsedMods()).toEqual([])
  waiters.wake(owner)
  expect(await outcome).toBe("woken")
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.isArmed(owner)).toBe(true)

  now = 14_999
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.isArmed(owner)).toBe(true)
  expect(waiters.lapsedMods()).toEqual([])
  now = 15_000
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.isArmed(owner)).toBe(false)
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
})

test("mod timeout starts grace at settlement rather than at arm", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const outcome = waiters.armMod(owner, 20)
  now = 10_000

  expect(await outcome).toBe("timeout")
  now = 14_999
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.isArmed(owner)).toBe(true)
  now = 15_001
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.isArmed(owner)).toBe(false)
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
})

test("cancelAll settles mods and keeps their grace without attaching hook owners", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const mod = waiters.armMod(owner, 60_000)
  const hook = waiters.arm(otherOwner, 60_000)
  now = 1000
  waiters.cancelAll()
  waiters.cancelAll()

  expect(await mod).toBe("cancelled")
  expect(await hook).toBe("cancelled")
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.isArmed(owner)).toBe(true)
  expect(waiters.modAttached(otherOwner)).toBe(false)
  expect(waiters.isArmed(otherOwner)).toBe(false)
  now = 6000
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
})

test("a hook stays armed after the mod it replaced lapses", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const mod = waiters.armMod(owner, 60_000)
  now = 1000
  const hook = waiters.arm(owner, 60_000)
  expect(await mod).toBe("replaced")

  now = 6000
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.isArmed(owner)).toBe(true)
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
  waiters.wake(owner)
  expect(await hook).toBe("woken")
  expect(waiters.isArmed(owner)).toBe(false)
})

test("re-polling keeps attachment and each owner's new lapse is reported once", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const first = waiters.armMod(owner, 60_000)
  const other = waiters.armMod(otherOwner, 60_000)
  waiters.wake(owner)
  waiters.wake(otherOwner)
  expect(await first).toBe("woken")
  expect(await other).toBe("woken")

  now = 4999
  const next = waiters.armMod(owner, 60_000)
  now = 5000
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.lapsedMods()).toEqual([otherOwner])
  expect(waiters.lapsedMods()).toEqual([])
  waiters.wake(owner)
  expect(await next).toBe("woken")

  now = 10_000
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
  const reattached = waiters.armMod(owner, 60_000)
  waiters.wake(owner)
  expect(await reattached).toBe("woken")
  now = 15_000
  expect(waiters.lapsedMods()).toEqual([owner])
  expect(waiters.lapsedMods()).toEqual([])
})

test("aborting an armed mod wait's signal settles it as cancelled and starts the grace at the abort", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const stopping = new AbortController()
  const outcome = waiters.armMod(owner, 60_000, stopping.signal)
  now = 10_000
  expect(waiters.modAttached(owner)).toBe(true)

  stopping.abort()

  expect(await outcome).toBe("cancelled")
  now = 10_000 + MOD_GRACE_MS - 1
  expect(waiters.modAttached(owner)).toBe(true)
  expect(waiters.lapsedMods()).toEqual([])
  now = 10_000 + MOD_GRACE_MS
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.isArmed(owner)).toBe(false)
  expect(waiters.lapsedMods()).toEqual([owner])
})

test("a late abort of a settled wait neither settles nor removes a newer wait for the same owner", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const stale = new AbortController()
  const first = waiters.armMod(owner, 60_000, stale.signal)
  waiters.wake(owner)
  expect(await first).toBe("woken")
  const second = waiters.armMod(owner, 60_000)
  let settled: WaitOutcome | undefined
  void second.then((outcome) => {
    settled = outcome
  })

  stale.abort()
  await Promise.resolve()

  expect(settled).toBeUndefined()
  now = 2 * MOD_GRACE_MS
  expect(waiters.modAttached(owner)).toBe(true)
  waiters.wake(owner)
  expect(await second).toBe("woken")
})

test("a signal that is already aborted settles the mod wait as cancelled at once and leaves nothing pending", async () => {
  let now = 0
  const waiters = freshWaiters(() => now)
  const outcome = waiters.armMod(owner, 60_000, AbortSignal.abort())

  expect(await outcome).toBe("cancelled")
  now = MOD_GRACE_MS - 1
  expect(waiters.modAttached(owner)).toBe(true)
  now = MOD_GRACE_MS
  expect(waiters.modAttached(owner)).toBe(false)
  expect(waiters.isArmed(owner)).toBe(false)
})

test("random waiter sequences keep one pending wait per owner and settle each once", async () => {
  const operation = fc.record({
    kind: fc.constantFrom("arm", "armMod", "wake", "advance"),
    ownerId: fc.constantFrom(owner, otherOwner, clockOwner),
    elapsedMs: fc.integer({ min: 0, max: 10_000 }),
  })

  await fc.assert(
    fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 100 }), async (operations) => {
      let now = 0
      const waiters = freshWaiters(() => now)
      type Armed = {
        ownerId: OwnerId
        expected: WaitOutcome | undefined
        actual: WaitOutcome | undefined
        settlements: number
      }
      const armed: Armed[] = []
      const pending = new Map<OwnerId, Armed>()
      try {
        for (const { kind, ownerId, elapsedMs } of operations) {
          if (kind === "advance") {
            now += elapsedMs
          } else if (kind === "wake") {
            const previous = pending.get(ownerId)
            if (previous) previous.expected = "woken"
            pending.delete(ownerId)
            waiters.wake(ownerId)
          } else {
            const previous = pending.get(ownerId)
            if (previous) previous.expected = "replaced"
            const entry: Armed = {
              ownerId,
              expected: undefined,
              actual: undefined,
              settlements: 0,
            }
            armed.push(entry)
            pending.set(ownerId, entry)
            const promise =
              kind === "arm" ? waiters.arm(ownerId, 60_000) : waiters.armMod(ownerId, 60_000)
            void promise.then((outcome) => {
              entry.actual = outcome
              entry.settlements++
            })
          }
          await Promise.resolve()
          for (const entry of armed) {
            expect(entry.actual).toBe(entry.expected)
            expect(entry.settlements).toBe(entry.expected === undefined ? 0 : 1)
          }
          for (const id of [owner, otherOwner, clockOwner]) {
            const unsettled = armed.filter(
              (entry) => entry.ownerId === id && entry.actual === undefined,
            )
            expect(unsettled.length).toBe(pending.has(id) ? 1 : 0)
            expect(waiters.isArmed(id)).toBe(pending.has(id) || waiters.modAttached(id))
          }
        }
      } finally {
        for (const entry of pending.values()) entry.expected = "cancelled"
        waiters.cancelAll()
        waiters.cancelAll()
      }
      await Promise.resolve()
      for (const entry of armed) {
        expect(entry.actual).toBe(entry.expected)
        expect(entry.settlements).toBe(1)
      }
    }),
  )
})
