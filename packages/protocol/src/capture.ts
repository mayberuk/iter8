import { z } from "zod"
import { Theme, Viewport } from "./anchor"
import { ScreenshotRef } from "./ids"
import { HttpUrl } from "./page"
import { ResolvedSourceLead } from "./source"

export const Screenshot = z.object({
  ref: ScreenshotRef,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type Screenshot = z.infer<typeof Screenshot>

/**
 * Data read off the page, never written by a person or an agent; it is untrusted and must stay
 * fenced from authored text wherever it is shown.
 */
export const Capture = z.object({
  completeness: z.enum(["complete", "partial", "stale", "omitted"]),
  omittedParts: z.array(
    z.enum([
      "landmark",
      "surroundingText",
      "computedStyles",
      "consoleErrors",
      "screenshot",
      "sourceLead",
    ]),
  ),
  url: HttpUrl,
  viewport: Viewport,
  theme: Theme,
  landmark: z.string().optional(),
  surroundingText: z.string().optional(),
  /** Only the properties that differ from the parent's or the default value. */
  computedStyles: z.record(z.string(), z.string()).optional(),
  consoleErrors: z
    .array(z.object({ message: z.string(), source: z.string().optional(), at: z.iso.datetime() }))
    .optional(),
  screenshot: Screenshot.optional(),
  sourceLead: ResolvedSourceLead.optional(),
})
export type Capture = z.infer<typeof Capture>
