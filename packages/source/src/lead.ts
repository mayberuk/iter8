import type {
  SourceBuild,
  SourceConfidence,
  SourceFrame,
  SourceFramework,
  SourceLead,
} from "@iter8/protocol"

export type Evidence = {
  framework: SourceFramework
  major: number | null
  component: string | null
  frames: SourceFrame[]
  onPickedElement: boolean
}

export type Adapter = (
  element: Element,
  context: { signal: AbortSignal; depth: number },
) => Evidence | null | Promise<Evidence | null>

/** The most frames a `SourceLead` may carry. */
const MAX_FRAMES = 8

function listedConfidence(
  { framework, major }: Evidence,
  build: SourceBuild,
): Exclude<SourceConfidence, "none"> {
  switch (framework) {
    case "react":
      return build === "vite" || build === "next-turbopack" ? "exact" : "approximate"
    case "svelte":
      return major === 5 && build === "vite" ? "exact" : "approximate"
    case "vue":
      return "file-only"
    case "astro":
      return build === "vite" ? "exact" : "approximate"
  }
}

/**
 * Labels evidence by its framework and the page's build. Evidence from an ancestor of the picked
 * element is capped at approximate; approximate and file-only are never raised.
 */
export function toLead(evidence: Evidence | null, build: SourceBuild): SourceLead {
  if (evidence === null || evidence.frames.length === 0) return { confidence: "none" }
  const listed = listedConfidence(evidence, build)
  return {
    confidence: listed === "exact" && !evidence.onPickedElement ? "approximate" : listed,
    framework: evidence.framework,
    build,
    component: evidence.component,
    frames: evidence.frames.slice(0, MAX_FRAMES),
  }
}
