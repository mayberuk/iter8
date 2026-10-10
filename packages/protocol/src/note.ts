import { z } from "zod"
import { AnchorStatus, NoteTarget } from "./anchor"
import { Capture } from "./capture"
import { NoteId, OwnerId, PageId } from "./ids"
import { Pairing } from "./pairing"

export const Intent = z.enum(["fix", "change", "question", "keep"])
export type Intent = z.infer<typeof Intent>

export const AgentAuthor = z.object({
  kind: z.literal("agent"),
  owner: OwnerId,
  name: z.string().min(1),
  agent: Pairing.shape.agent,
})
export type AgentAuthor = z.infer<typeof AgentAuthor>

export const NoteAuthor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  AgentAuthor,
])
export type NoteAuthor = z.infer<typeof NoteAuthor>

const Done = z.object({ status: z.literal("done"), at: z.iso.datetime() })
const Answered = z.object({
  status: z.literal("answered"),
  reply: z.string().min(1),
  at: z.iso.datetime(),
})

export const NoteResolution = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open") }),
  Done,
  Answered,
])
export type NoteResolution = z.infer<typeof NoteResolution>

export const ClosedResolution = z.discriminatedUnion("status", [Done, Answered])
export type ClosedResolution = z.infer<typeof ClosedResolution>

/** Authored fields and the {@link Capture} subtree share no key, so the two cannot be mixed. */
export const Note = z.object({
  id: NoteId,
  pageId: PageId,
  author: NoteAuthor,
  intent: Intent,
  body: z.string(),
  target: NoteTarget,
  anchorStatus: AnchorStatus,
  createdAt: z.iso.datetime(),
  /** Absent on an agent's note. */
  capture: Capture.optional(),
  resolution: NoteResolution,
})
export type Note = z.infer<typeof Note>
