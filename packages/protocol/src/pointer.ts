import { z } from "zod"
import { CLI_NAME } from "./cli"
import { PageId, RoundId } from "./ids"

/** All a hook may tell a session about a round: it never carries note content. */
export const RoundPointer = z.object({
  roundId: RoundId,
  pageId: PageId,
  noteCount: z.number().int().positive(),
})
export type RoundPointer = z.infer<typeof RoundPointer>

export function formatPointer(pointer: RoundPointer): string {
  const notes = pointer.noteCount === 1 ? "1 note" : `${pointer.noteCount} notes`
  return `Review round ${pointer.roundId} from ${pointer.pageId} · ${notes} — run \`${CLI_NAME} show ${pointer.roundId}\``
}

/** Matches a whole line {@link formatPointer} can produce, capturing `id`, `page` and `count`. */
export const POINTER_LINE =
  /^Review round (?<id>R[1-9][0-9]*) from (?<page>[a-z][a-z0-9-]{1,30}) · (?<count>[1-9][0-9]*) (?:(?<= 1 )note|(?<! 1 )notes) — run `iter8 show \k<id>`$/
