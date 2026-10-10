import type { OwnerId } from "@iter8/protocol"

export type WaitOutcome = "woken" | "replaced" | "cancelled" | "timeout"

/** A mod re-polls at once, so 5 s covers a slow hop between answers. */
export const MOD_GRACE_MS = 5000

export type Waiters = {
  arm(ownerId: OwnerId, timeoutMs: number): Promise<WaitOutcome>
  armMod(ownerId: OwnerId, timeoutMs: number): Promise<WaitOutcome>
  wake(ownerId: OwnerId): void
  isArmed(ownerId: OwnerId): boolean
  modAttached(ownerId: OwnerId): boolean
  lapsedMods(): OwnerId[]
  cancelAll(): void
}

export function createWaiters(now: () => number = Date.now): Waiters {
  const pending = new Map<OwnerId, { mod: boolean; settle: (outcome: WaitOutcome) => void }>()
  const lastModSettled = new Map<OwnerId, number>()

  const arm = (ownerId: OwnerId, timeoutMs: number, mod: boolean): Promise<WaitOutcome> => {
    pending.get(ownerId)?.settle("replaced")
    return new Promise<WaitOutcome>((resolve) => {
      const timer = setTimeout(() => settle("timeout"), timeoutMs)
      const settle = (outcome: WaitOutcome): void => {
        clearTimeout(timer)
        pending.delete(ownerId)
        if (mod) lastModSettled.set(ownerId, now())
        resolve(outcome)
      }
      pending.set(ownerId, { mod, settle })
    })
  }

  const modAttached = (ownerId: OwnerId): boolean => {
    if (pending.get(ownerId)?.mod) return true
    const settledAt = lastModSettled.get(ownerId)
    return settledAt !== undefined && now() - settledAt < MOD_GRACE_MS
  }

  return {
    arm(ownerId, timeoutMs) {
      return arm(ownerId, timeoutMs, false)
    },
    armMod(ownerId, timeoutMs) {
      return arm(ownerId, timeoutMs, true)
    },
    wake(ownerId) {
      pending.get(ownerId)?.settle("woken")
    },
    isArmed(ownerId) {
      return pending.has(ownerId) || modAttached(ownerId)
    },
    modAttached,
    lapsedMods() {
      const lapsed: OwnerId[] = []
      for (const ownerId of lastModSettled.keys()) {
        if (modAttached(ownerId)) continue
        lastModSettled.delete(ownerId)
        lapsed.push(ownerId)
      }
      return lapsed
    },
    cancelAll() {
      for (const { settle } of pending.values()) settle("cancelled")
    },
  }
}
