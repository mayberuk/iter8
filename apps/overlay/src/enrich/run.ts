import type {
  Capture,
  ElementAnchor,
  ResolvedSourceLead,
  Screenshot,
  SourceLead,
  Theme,
} from "@iter8/protocol"
import { parentAcrossShadow, resolveSelector } from "../pick/anchor"
import { describeContext } from "./context"
import { captureCrop, capturePart, captureRegion } from "./crop"
import { diffStyles, VISUAL_PROPERTIES } from "./styles"

type Lookup = (el: Element, signal: AbortSignal) => Promise<SourceLead>

const LOOKUP_TIMEOUT_MS = 1500
const SHOT_AFTER_IDLE_MS = 400
const NOT_LOADED: ResolvedSourceLead = { confidence: "none", reason: "not-loaded" }

async function nextStep(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await scheduler.yield()
  signal.throwIfAborted()
}

async function untilQuiet(idleSinceInput: () => number, signal: AbortSignal): Promise<void> {
  await nextStep(signal)
  for (let idle = idleSinceInput(); idle < SHOT_AFTER_IDLE_MS; idle = idleSinceInput()) {
    // Sleeps out the rest of the quiet period rather than spinning on yields through typing.
    await new Promise((resolve) => setTimeout(resolve, SHOT_AFTER_IDLE_MS - idle))
    await nextStep(signal)
  }
}

function readStyles(el: Element | null): Record<string, string> {
  if (el === null) return {}
  const computed = getComputedStyle(el)
  return Object.fromEntries(
    VISUAL_PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]),
  )
}

function pageTheme(): Theme {
  const scheme = getComputedStyle(document.documentElement).colorScheme.split(/\s+/)
  const dark = scheme.includes("dark")
  if (dark !== scheme.includes("light")) return dark ? "dark" : "light"
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function abandoned(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

/** Null when the lead failed for a reason other than cancellation or the timeout. */
async function leadFor(
  el: Element,
  lookup: Lookup | null,
  symbolicate: (lead: SourceLead) => Promise<ResolvedSourceLead>,
  signal: AbortSignal,
): Promise<ResolvedSourceLead | null> {
  if (lookup === null) return NOT_LOADED
  const timeout = AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
  const either = AbortSignal.any([signal, timeout])
  let lead: SourceLead
  try {
    // Raced against the signal so a bundle that ignores it still cannot outlast the timeout.
    lead = await Promise.race([lookup(el, either), abandoned(either)])
  } catch {
    if (signal.aborted) throw signal.reason
    return timeout.aborted ? NOT_LOADED : null
  }
  signal.throwIfAborted()
  try {
    return await symbolicate(lead)
  } catch {
    if (signal.aborted) throw signal.reason
    return null
  }
}

/**
 * Gathers everything captured after the pick, yielding between steps. Rejects with the signal's
 * reason once it aborts, so a cancelled run never produces a capture.
 */
export async function enrich(
  target: { el: Element; anchor: ElementAnchor },
  deps: {
    signal: AbortSignal
    lookupSource: Lookup | null
    symbolicate: (lead: SourceLead) => Promise<ResolvedSourceLead>
    uploadScreenshot: (png: Blob) => Promise<Screenshot>
    errors: () => NonNullable<Capture["consoleErrors"]>
    shot: boolean
    clip?: DOMRectReadOnly
    idleSinceInput: () => number
    exclude: Element
  },
): Promise<Capture> {
  const { el, anchor } = target
  const { signal } = deps
  const omittedParts: Capture["omittedParts"] = []
  const isStale = () => !el.isConnected || !resolveSelector(anchor.selector).includes(el)

  signal.throwIfAborted()
  const url = location.href
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }
  const theme = pageTheme()
  const context = describeContext(el)

  await nextStep(signal)
  const computedStyles = diffStyles(readStyles(el), readStyles(parentAcrossShadow(el)))

  await nextStep(signal)
  const consoleErrors = deps.errors()

  await nextStep(signal)
  const sourceLead = await leadFor(el, deps.lookupSource, deps.symbolicate, signal)
  if (sourceLead === null) omittedParts.push("sourceLead")

  let screenshot: Screenshot | undefined
  if (deps.shot) {
    await untilQuiet(deps.idleSinceInput, signal)
    if (!isStale()) {
      const opts = { signal, exclude: deps.exclude }
      const shot =
        deps.clip === undefined ? await captureCrop(el, opts) : await captureRegion(deps.clip, opts)
      signal.throwIfAborted()
      if ("omitted" in shot) omittedParts.push("screenshot")
      else if (!isStale()) {
        try {
          screenshot = await deps.uploadScreenshot(shot.png)
        } catch {
          if (signal.aborted) throw signal.reason
          omittedParts.push("screenshot")
        }
      }
    }
  }

  signal.throwIfAborted()
  const stale = isStale()
  return {
    completeness: stale ? "stale" : omittedParts.length > 0 ? "partial" : "complete",
    omittedParts,
    url,
    viewport,
    theme,
    ...context,
    ...(Object.keys(computedStyles).length > 0 ? { computedStyles } : {}),
    ...(consoleErrors.length > 0 ? { consoleErrors } : {}),
    ...(screenshot !== undefined && !stale ? { screenshot } : {}),
    ...(sourceLead !== null ? { sourceLead } : {}),
  }
}

/**
 * Captures an overlay part for a note about iter8 itself: the page's styles, console errors and
 * source lead say nothing about it, so only where and how it was seen is recorded.
 */
export async function enrichPart(
  part: Element,
  deps: {
    signal: AbortSignal
    uploadScreenshot: (png: Blob) => Promise<Screenshot>
    idleSinceInput: () => number
  },
): Promise<Capture> {
  const { signal } = deps
  signal.throwIfAborted()
  const url = location.href
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
  }
  const theme = pageTheme()
  const omittedParts: Capture["omittedParts"] = []

  await untilQuiet(deps.idleSinceInput, signal)
  let screenshot: Screenshot | undefined
  if (part.isConnected) {
    const shot = await capturePart(part, signal)
    signal.throwIfAborted()
    if ("omitted" in shot) omittedParts.push("screenshot")
    else if (part.isConnected) {
      try {
        screenshot = await deps.uploadScreenshot(shot.png)
      } catch {
        if (signal.aborted) throw signal.reason
        omittedParts.push("screenshot")
      }
    }
  }

  signal.throwIfAborted()
  const stale = !part.isConnected
  return {
    completeness: stale ? "stale" : omittedParts.length > 0 ? "partial" : "complete",
    omittedParts,
    url,
    viewport,
    theme,
    ...(screenshot !== undefined && !stale ? { screenshot } : {}),
  }
}
