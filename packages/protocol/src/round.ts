import { z } from "zod"
import { IdempotencyKey, OwnerId, PageId, PairingGeneration, RoundId } from "./ids"
import { Note } from "./note"

export const RoundStage = z.enum(["draft", "queued", "announced", "claimed", "orphaned"])
export type RoundStage = z.infer<typeof RoundStage>

export const ROUND_STAGE_ORDER = [
  "draft",
  "queued",
  "announced",
  "claimed",
] as const satisfies readonly RoundStage[]

/**
 * The only edges a round may take. A round never returns to draft. Orphaned means the owning
 * process died after the round was queued and before it was claimed, which the overlay shows as a
 * delivery failure. Reattaching the page requeues its queued, announced and orphaned rounds to
 * the new owner as queued. Claimed is terminal; per-note progress lives on each note.
 */
export const ROUND_TRANSITIONS = {
  draft: ["queued"],
  queued: ["announced", "claimed", "orphaned"],
  announced: ["claimed", "orphaned", "queued"],
  orphaned: ["queued"],
  claimed: [],
} as const satisfies Record<RoundStage, readonly RoundStage[]>

const Queued = {
  queuedAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKey,
  requeuedAt: z.iso.datetime().optional(),
}

export const RoundState = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("draft") }),
  z.object({ stage: z.literal("queued"), ...Queued }),
  z.object({
    stage: z.literal("announced"),
    ...Queued,
    announcedAt: z.iso.datetime(),
    generation: PairingGeneration,
  }),
  z.object({
    stage: z.literal("claimed"),
    ...Queued,
    /** Absent when `show` claimed the round before any announcement reached it. */
    announcedAt: z.iso.datetime().optional(),
    generation: PairingGeneration.optional(),
    claimedAt: z.iso.datetime(),
  }),
  z.object({
    stage: z.literal("orphaned"),
    queuedAt: z.iso.datetime(),
    idempotencyKey: IdempotencyKey,
    announcedAt: z.iso.datetime().optional(),
    orphanedAt: z.iso.datetime(),
  }),
])
export type RoundState = z.infer<typeof RoundState>

export const Round = z.object({
  id: RoundId,
  pageId: PageId,
  owner: OwnerId.nullable(),
  state: RoundState,
  notes: z.array(Note),
})
export type Round = z.infer<typeof Round>

export const RoundSummary = Round.pick({ id: true, pageId: true, owner: true }).extend({
  stage: RoundStage,
  noteCount: z.number().int().nonnegative(),
  doneCount: z.number().int().nonnegative(),
  answeredCount: z.number().int().nonnegative(),
})
export type RoundSummary = z.infer<typeof RoundSummary>
