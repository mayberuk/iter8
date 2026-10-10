import type { OwnerId } from "@iter8/protocol"

export type WaitOutcome = "woken" | "replaced" | "cancelled" | "timeout"

export type Waiters = {
  arm(ownerId: OwnerId, timeoutMs: number): Promise<WaitOutcome>
  wake(ownerId: OwnerId): void
  isArmed(ownerId: OwnerId): boolean
  cancelAll(): void
}

export function createWaiters(): Waiters {
  const pending = new Map<OwnerId, (outcome: WaitOutcome) => void>()

  return {
    arm(ownerId, timeoutMs) {
      pending.get(ownerId)?.("replaced")
      return new Promise<WaitOutcome>((resolve) => {
        const timer = setTimeout(() => settle("timeout"), timeoutMs)
        const settle = (outcome: WaitOutcome): void => {
          clearTimeout(timer)
          pending.delete(ownerId)
          resolve(outcome)
        }
        pending.set(ownerId, settle)
      })
    },
    wake(ownerId) {
      pending.get(ownerId)?.("woken")
    },
    isArmed(ownerId) {
      return pending.has(ownerId)
    },
    cancelAll() {
      for (const settle of pending.values()) settle("cancelled")
    },
  }
}
