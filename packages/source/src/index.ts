import type { SourceLead } from "@iter8/protocol"
import { type Adapter, type Evidence, toLead } from "./lead"
import { detectBuild } from "./page-build"

const MAX_ANCESTORS = 25

const adapters: Adapter[] = []

function readPage() {
  return {
    globals: {
      TURBOPACK: Reflect.get(window, "TURBOPACK"),
      webpackChunk_N_E: Reflect.get(window, "webpackChunk_N_E"),
    },
    scriptSources: [
      ...Array.from(document.scripts, (script) => script.src),
      // SvelteKit loads the Vite client with import(), which leaves no script element behind.
      ...performance
        .getEntriesByType("resource")
        .filter(
          (entry) => entry instanceof PerformanceResourceTiming && entry.initiatorType === "script",
        )
        .map((entry) => entry.name),
    ],
  }
}

function parentOf(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

// Each element is its own task, so a long walk yields to input and an abort lands between steps.
const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve))

/** Rejects only when `signal` aborts, with its reason; a page that breaks an adapter gives none. */
export async function lookupSource(
  element: Element,
  signal: AbortSignal,
  walkedAdapters: readonly Adapter[] = adapters,
): Promise<SourceLead> {
  signal.throwIfAborted()
  const build = detectBuild(readPage())
  let current: Element | null = element
  for (let depth = 0; current !== null && depth <= MAX_ANCESTORS; depth += 1) {
    await yieldToPage()
    signal.throwIfAborted()
    for (const adapter of walkedAdapters) {
      let evidence: Evidence | null = null
      try {
        evidence = await adapter(current, { signal, depth })
      } catch {}
      signal.throwIfAborted()
      if (evidence !== null) {
        return toLead(depth === 0 ? evidence : { ...evidence, onPickedElement: false }, build)
      }
    }
    current = parentOf(current)
  }
  return toLead(null, build)
}
