import type { Adapter, Evidence } from "./lead"

const SOURCE_FILE = "data-astro-source-file"
const SOURCE_LOC = "data-astro-source-loc"

// The 6.6 KB fixture page parses in 0.1 ms in headless Chromium and a 1 MB page built from it in 4 ms.
export const MAX_SERVED_HTML_BYTES = 1_000_000

function annotatedEvidence(element: Element, onPickedElement: boolean): Evidence | null {
  const file = element.getAttribute(SOURCE_FILE)
  if (file === null || file === "") return null
  const line = Number(element.getAttribute(SOURCE_LOC)?.split(":")[0])
  const basename = file.slice(file.lastIndexOf("/") + 1)
  return {
    framework: "astro",
    major: null,
    component: basename.endsWith(".astro") ? basename.slice(0, -".astro".length) : null,
    // The loc column marks the end of the opening tag, not where the element starts, so it is dropped.
    frames: [{ kind: "source", file, ...(Number.isInteger(line) && line >= 1 ? { line } : {}) }],
    onPickedElement,
  }
}

function isAstroPage(): boolean {
  const generator = document.querySelector('meta[name="generator"]')?.getAttribute("content")
  return (
    generator?.startsWith("Astro") === true || document.querySelector("astro-dev-toolbar") !== null
  )
}

function pathFromBody(element: Element): { tag: string; index: number }[] | null {
  const steps: { tag: string; index: number }[] = []
  let current = element
  while (current !== document.body) {
    const parent = current.parentElement
    if (parent === null) return null
    const tag = current.localName
    const sameTag = Array.from(parent.children).filter((sibling) => sibling.localName === tag)
    steps.unshift({ tag, index: sameTag.indexOf(current) })
    current = parent
  }
  return steps
}

async function readCapped(response: Response): Promise<string | null> {
  if (response.body === null) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_SERVED_HTML_BYTES) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/**
 * Astro's dev toolbar strips the source attributes shortly after load and keeps them in a map
 * private to its audit app, so once they are gone the page's own served HTML is the only record.
 */
export const astroEvidence: Adapter = async (element, { signal, depth }) => {
  const live = annotatedEvidence(element, true)
  if (live !== null) return live
  if (depth > 0 || !isAstroPage()) return null
  const path = pathFromBody(element)
  if (path === null) return null

  const response = await fetch(location.href, {
    signal,
    cache: "no-store",
    credentials: "same-origin",
  })
  signal.throwIfAborted()
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const html = await readCapped(response)
  signal.throwIfAborted()
  if (html === null) return null
  const served = new DOMParser().parseFromString(html, "text/html")
  signal.throwIfAborted()

  let node: Element | undefined = served.body
  let annotated = node.hasAttribute(SOURCE_FILE) ? node : null
  for (const { tag, index } of path) {
    node = Array.from(node.children).filter((child) => child.localName === tag)[index]
    if (node === undefined) break
    if (node.hasAttribute(SOURCE_FILE)) annotated = node
  }
  if (annotated === null) return null
  const found = annotated
  const same =
    found === node &&
    ["id", "class"].every((name) => found.getAttribute(name) === element.getAttribute(name))
  return annotatedEvidence(found, same)
}
