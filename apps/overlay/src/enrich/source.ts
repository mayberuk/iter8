import { SourceLead } from "@iter8/protocol"

type Lookup = (el: Element, signal: AbortSignal) => Promise<SourceLead>

/**
 * Imports the page's source bundle, or answers null when it cannot be loaded or does not export a
 * `lookupSource` function. The browser's module map makes a repeat call for the same URL reuse the
 * first import rather than fetch again.
 */
export async function loadSourceLookup(url: string): Promise<Lookup | null> {
  let bundle: unknown
  try {
    bundle = await import(url)
  } catch {
    return null
  }
  const lookup: unknown =
    typeof bundle === "object" && bundle !== null ? Reflect.get(bundle, "lookupSource") : undefined
  if (typeof lookup !== "function") return null
  return async (el, signal) => SourceLead.parse(await lookup(el, signal))
}
