import { z } from "zod"
import { NoteId } from "./ids"
import { Note } from "./note"
import { HttpUrl, Port } from "./page"
import { Pairing } from "./pairing"
import { Round } from "./round"

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pairing"), pairing: Pairing.nullable() }),
  /** The full round, which also carries every note's done or answered change. */
  z.object({ type: z.literal("round"), round: Round }),
  /** An agent's note, added or updated. */
  z.object({ type: z.literal("agent-note"), note: Note }),
  z.object({ type: z.literal("agent-note-removed"), noteId: NoteId }),
  /** Folder mode: the page's files changed. */
  z.object({ type: z.literal("reload") }),
  z.object({ type: z.literal("upstream-failure"), port: Port, url: HttpUrl }),
  /** The service is restarting for a version change; reconnect. */
  z.object({ type: z.literal("draining") }),
])
export type ServerMessage = z.infer<typeof ServerMessage>

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping"), at: z.iso.datetime() }),
])
export type ClientMessage = z.infer<typeof ClientMessage>
