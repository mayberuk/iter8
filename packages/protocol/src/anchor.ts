import { z } from "zod"

/** CSS pixels in page coordinates. */
export const Box = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})
export type Box = z.infer<typeof Box>

export const Viewport = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  devicePixelRatio: z.number().positive(),
})
export type Viewport = z.infer<typeof Viewport>

export const Theme = z.enum(["light", "dark"])
export type Theme = z.infer<typeof Theme>

export const ElementAnchor = z.object({
  /** One CSS selector per shadow-root hop, outermost first. */
  selector: z.array(z.string().min(1)).min(1),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  box: Box,
  renderGeneration: z.number().int().nonnegative(),
})
export type ElementAnchor = z.infer<typeof ElementAnchor>

const NoControl = /^[^\p{Cc}]+$/u

/** One plain line each: `iter8 show` prints them outside the untrusted fence. */
export const Iter8Part = z.object({
  key: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  name: z.string().max(80).regex(NoControl),
  source: z
    .string()
    .max(200)
    .regex(/^[\w.@/-]+$/),
})
export type Iter8Part = z.infer<typeof Iter8Part>

export const NoteTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element"), anchor: ElementAnchor }),
  z.object({ kind: z.literal("elements"), anchors: z.array(ElementAnchor).min(2) }),
  z.object({ kind: z.literal("region"), box: Box, viewport: Viewport }),
  z.object({
    kind: z.literal("iter8"),
    part: Iter8Part,
    iter8Version: z.string().regex(/^[\w.+-]{1,32}$/),
    /** Viewport coordinates: the overlay is fixed to the viewport, so a page offset would move it. */
    box: Box,
    viewport: Viewport,
  }),
])
export type NoteTarget = z.infer<typeof NoteTarget>

export const AnchorStatus = z.enum(["anchored", "moved", "unanchored"])
export type AnchorStatus = z.infer<typeof AnchorStatus>
