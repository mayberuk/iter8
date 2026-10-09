import { z } from "zod"

/** The page's `*.localhost` hostname label, so its URL, its pointer and its history share one id. */
export const PageId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/)
  .brand<"PageId">()
export type PageId = z.infer<typeof PageId>

export const RoundId = z
  .string()
  .regex(/^R[1-9][0-9]*$/)
  .brand<"RoundId">()
export type RoundId = z.infer<typeof RoundId>

/** Unique per service, so a note is addressable without its round. */
export const NoteId = z
  .string()
  .regex(/^N[1-9][0-9]*$/)
  .brand<"NoteId">()
export type NoteId = z.infer<typeof NoteId>

/** Assigned by the service when a process pairs. */
export const OwnerId = z.string().min(1).max(200).regex(/^\S+$/).brand<"OwnerId">()
export type OwnerId = z.infer<typeof OwnerId>

export const PairingGeneration = z.number().int().nonnegative().brand<"PairingGeneration">()
export type PairingGeneration = z.infer<typeof PairingGeneration>

export const MachineId = z.string().min(1).brand<"MachineId">()
export type MachineId = z.infer<typeof MachineId>

/** Unpadded base64url: the token rides in a WebSocket subprotocol, where `=` is not allowed. */
export const PageToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,}$/)
  .brand<"PageToken">()
export type PageToken = z.infer<typeof PageToken>

/** Travels as a URL path segment. */
export const ScreenshotRef = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,128}$/)
  .brand<"ScreenshotRef">()
export type ScreenshotRef = z.infer<typeof ScreenshotRef>

export const IdempotencyKey = z.string().min(8).max(100).brand<"IdempotencyKey">()
export type IdempotencyKey = z.infer<typeof IdempotencyKey>
