import type { SourceLead } from "@iter8/protocol"

/** Stands in for the page's source bundle, and rejects on abort the way the real one does. */
export function lookupSource(el: Element, signal: AbortSignal): Promise<SourceLead> {
  if (el.closest("[data-fake-slow]") !== null) {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })
  }
  if (el.closest("[data-fake-src]") !== null) {
    return Promise.resolve({
      confidence: "exact",
      framework: "react",
      build: "vite",
      component: "Card",
      frames: [{ kind: "source", file: "src/Card.jsx", line: 3 }],
    })
  }
  return Promise.resolve({ confidence: "none" })
}
