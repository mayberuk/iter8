import { z } from "zod"
import { Note } from "./note"
import { LiveSession, Pairing } from "./pairing"
import { Round } from "./round"

export const OverlayPrefs = z.object({
  theme: z.enum(["auto", "light", "dark"]),
  dock: z.enum(["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"]),
  collapsed: z.boolean(),
  pinsVisible: z.boolean(),
  coachDone: z.boolean(),
})
export type OverlayPrefs = z.infer<typeof OverlayPrefs>

/** Everything the overlay needs to draw a page, returned by the hello handshake. */
export const PageState = z.object({
  drafts: z.array(Note),
  rounds: z.array(Round),
  agentNotes: z.array(Note),
  pairing: Pairing.nullable(),
  liveSessions: z.array(LiveSession),
  prefs: OverlayPrefs,
})
export type PageState = z.infer<typeof PageState>
