import {
  type PairingGeneration,
  ROUND_TRANSITIONS,
  type RoundStage,
  type RoundState,
} from "@iter8/protocol"

export type RoundEvent =
  | { to: "announced"; generation: PairingGeneration }
  | { to: "claimed" }
  | { to: "orphaned" }
  | { to: "queued" }

export function nextRoundState(
  state: RoundState,
  event: RoundEvent,
  at: string,
): RoundState | { refused: string } {
  const allowed: readonly RoundStage[] = ROUND_TRANSITIONS[state.stage]
  if (!allowed.includes(event.to)) {
    return { refused: `A ${state.stage} round cannot become ${event.to}` }
  }
  // The table allows draft to queued, but send creates rounds already queued, so a draft round
  // never exists and the event carries no idempotency key to queue one with.
  if (state.stage === "draft") return { refused: "A draft round cannot be queued by an event" }
  const { queuedAt, idempotencyKey } = state
  const requeued =
    state.stage !== "orphaned" && state.requeuedAt !== undefined
      ? { requeuedAt: state.requeuedAt }
      : {}
  const announced =
    state.stage === "announced"
      ? { announcedAt: state.announcedAt, generation: state.generation }
      : {}
  switch (event.to) {
    case "announced":
      return {
        stage: "announced",
        queuedAt,
        idempotencyKey,
        ...requeued,
        announcedAt: at,
        generation: event.generation,
      }
    case "claimed":
      return {
        stage: "claimed",
        queuedAt,
        idempotencyKey,
        ...requeued,
        ...announced,
        claimedAt: at,
      }
    case "orphaned":
      return {
        stage: "orphaned",
        queuedAt,
        idempotencyKey,
        ...(state.stage === "announced" ? { announcedAt: state.announcedAt } : {}),
        orphanedAt: at,
      }
    case "queued":
      return { stage: "queued", queuedAt, idempotencyKey, requeuedAt: at }
  }
}
