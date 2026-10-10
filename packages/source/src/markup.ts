import { MARKUP_TEXT_LENGTH, MAX_MARKUP_STEPS, type MarkupPath } from "@iter8/protocol"

// The heavy page's table has 120,601 text nodes; walking all of them took 31 ms in headless
// Chromium and 1,000 took 0.3 ms.
const MAX_TEXT_NODES = 1000

const collapse = (text: string) => text.replace(/\s+/g, " ").trimStart()

/** Equals `collapse(chunks.join("")).slice(0, MARKUP_TEXT_LENGTH)` while reading only as many chunks as the prefix needs. */
export function textPrefix(chunks: Iterable<string>): string {
  let prefix = ""
  for (const chunk of chunks) {
    prefix = collapse(prefix + chunk)
    if (prefix.length > MARKUP_TEXT_LENGTH) break
  }
  return prefix.slice(0, MARKUP_TEXT_LENGTH)
}

function* textNodes(element: Element): Generator<string> {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let visited = 0; visited < MAX_TEXT_NODES; visited += 1) {
    const node = walker.nextNode()
    if (node === null) return
    yield (node as Text).data
  }
}

function stepsFromBody(element: Element): MarkupPath["steps"] | null {
  const steps: MarkupPath["steps"] = []
  let current = element
  while (current !== document.body) {
    const parent = current.parentElement
    if (parent === null || steps.length === MAX_MARKUP_STEPS) return null
    const tag = current.localName
    const sameTag = Array.from(parent.children).filter((sibling) => sibling.localName === tag)
    steps.unshift({ tag, index: sameTag.indexOf(current) })
    current = parent
  }
  return steps
}

/**
 * Where `element` sits in the page's markup, or null when it is outside `<body>` or too deep. An
 * element in a shadow root is described by its outermost light-DOM host.
 */
export function markupOf(element: Element): MarkupPath | null {
  let located = element
  let onPickedElement = true
  for (let root = located.getRootNode(); root instanceof ShadowRoot; root = located.getRootNode()) {
    located = root.host
    onPickedElement = false
  }
  const steps = stepsFromBody(located)
  if (steps === null) return null
  return {
    url: location.href,
    steps,
    id: located.getAttribute("id"),
    className: located.getAttribute("class"),
    text: textPrefix(textNodes(located)),
    onPickedElement,
  }
}
