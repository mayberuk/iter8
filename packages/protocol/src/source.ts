import { z } from "zod"

export const SourceConfidence = z.enum(["exact", "approximate", "file-only", "none"])
export type SourceConfidence = z.infer<typeof SourceConfidence>

export const SourceFramework = z.enum(["react", "svelte", "vue", "astro"])
export type SourceFramework = z.infer<typeof SourceFramework>

export const SourceBuild = z.enum(["vite", "next-turbopack", "next-webpack", "unknown"])
export type SourceBuild = z.infer<typeof SourceBuild>

const OneBased = z.number().int().min(1)

export const SourceFrame = z.object({
  kind: z.enum(["generated", "source"]),
  /** A generated frame keeps the URL exactly as the page saw it; the service maps it back. */
  file: z.string().min(1),
  line: OneBased.optional(),
  column: OneBased.optional(),
  component: z.string().optional(),
})
export type SourceFrame = z.infer<typeof SourceFrame>

/** What the page bundle finds; the service symbolicates it into a {@link ResolvedSourceLead}. */
export const SourceLead = z.discriminatedUnion("confidence", [
  z.object({ confidence: z.literal("none") }),
  z.object({
    confidence: SourceConfidence.exclude(["none"]),
    framework: SourceFramework,
    build: SourceBuild,
    component: z.string().nullable(),
    frames: z.array(SourceFrame).min(1).max(8),
  }),
])
export type SourceLead = z.infer<typeof SourceLead>

/** Relative to the project root and never escaping it, or the lead resolves to none. */
const ProjectPath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."))

export const ResolvedSourceLead = z.discriminatedUnion("confidence", [
  z.object({
    confidence: z.literal("none"),
    reason: z.enum(["no-framework", "no-frames-resolved", "outside-project", "not-loaded"]),
  }),
  z.object({
    confidence: SourceConfidence.extract(["exact", "approximate"]),
    framework: SourceFramework,
    component: z.string().nullable(),
    file: ProjectPath,
    line: OneBased.optional(),
    column: OneBased.optional(),
  }),
  z.object({
    confidence: z.literal("file-only"),
    framework: SourceFramework,
    component: z.string().nullable(),
    file: ProjectPath,
    line: z.never().optional(),
    column: z.never().optional(),
  }),
])
export type ResolvedSourceLead = z.infer<typeof ResolvedSourceLead>
