import type { Box, ElementAnchor, NoteTarget } from "@iter8/protocol"

const ROLE_MAX = 64
const NAME_MAX = 200
const TEXT_MAX = 200

/** React's `useId` values are minted per render tree, so a selector anchored on one breaks on reload. */
const GENERATED_ID = /«r[0-9a-z]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/

const LANDMARK_SCOPE = "article, aside, main, nav, section"

type TreeRoot = Document | ShadowRoot

function uniqueIn(root: TreeRoot, element: Element, selector: string): boolean {
  const matches = root.querySelectorAll(selector)
  return matches.length === 1 && matches[0] === element
}

function nthOfType(element: Element, qualifier = ""): string {
  const tag = element.localName
  let index = 1
  for (let at = element.previousElementSibling; at !== null; at = at.previousElementSibling)
    if (at.localName === tag) index += 1
  return `${CSS.escape(tag)}${qualifier}:nth-of-type(${index})`
}

function stopSegment(element: Element, root: TreeRoot): string | null {
  const tag = element.localName
  if (root instanceof Document && (tag === "body" || tag === "html")) return tag
  const id = element.id
  if (id !== "" && !GENERATED_ID.test(id) && root.getElementById(id) === element) {
    const selector = `${CSS.escape(tag)}#${CSS.escape(id)}`
    if (uniqueIn(root, element, selector)) return selector
  }
  const testid = element.getAttribute("data-testid")
  if (testid !== null && testid !== "") {
    const selector = `${CSS.escape(tag)}[data-testid="${CSS.escape(testid)}"]`
    if (uniqueIn(root, element, selector)) return selector
  }
  return null
}

function stepSegment(element: Element): string {
  const testid = element.getAttribute("data-testid")
  return testid === null || testid === ""
    ? nthOfType(element)
    : nthOfType(element, `[data-testid="${CSS.escape(testid)}"]`)
}

/** A shadow root has no `html` to stop at, so its walk is pinned to the root with `:host >`. */
function selectorWithin(element: Element, root: TreeRoot): string {
  const segments: string[] = []
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const stop = stopSegment(node, root)
    if (stop !== null) return [stop, ...segments].join(" > ")
    segments.unshift(stepSegment(node))
  }
  return [":host", ...segments].join(" > ")
}

function selectorPath(element: Element): string[] {
  const hops: string[] = []
  for (let node: Element | null = element; node !== null; ) {
    const root = node.getRootNode()
    if (root instanceof ShadowRoot) {
      hops.unshift(selectorWithin(node, root))
      node = root.host
    } else {
      hops.unshift(selectorWithin(node, node.ownerDocument))
      node = null
    }
  }
  return hops
}

function inputRole(input: HTMLInputElement): string | undefined {
  switch (input.type) {
    case "button":
    case "submit":
    case "reset":
    case "image":
      return "button"
    case "checkbox":
      return "checkbox"
    case "radio":
      return "radio"
    case "range":
      return "slider"
    case "number":
      return "spinbutton"
    case "hidden":
      return undefined
    case "search":
      return input.hasAttribute("list") ? "combobox" : "searchbox"
    default:
      return input.hasAttribute("list") ? "combobox" : "textbox"
  }
}

const TAG_ROLES: Record<string, string> = {
  article: "article",
  aside: "complementary",
  button: "button",
  dialog: "dialog",
  fieldset: "group",
  details: "group",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hr: "separator",
  li: "listitem",
  main: "main",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  option: "option",
  output: "status",
  progress: "progressbar",
  table: "table",
  tbody: "rowgroup",
  td: "cell",
  textarea: "textbox",
  tfoot: "rowgroup",
  th: "columnheader",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
}

function implicitRole(element: Element): string | undefined {
  const tag = element.localName
  if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : undefined
  if (element instanceof HTMLInputElement) return inputRole(element)
  if (element instanceof HTMLSelectElement)
    return element.multiple || element.size > 1 ? "listbox" : "combobox"
  if (tag === "img") return element.getAttribute("alt") === "" ? "presentation" : "img"
  if (tag === "header" || tag === "footer") {
    if (element.parentElement?.closest(LANDMARK_SCOPE) != null) return undefined
    return tag === "header" ? "banner" : "contentinfo"
  }
  if (tag === "section") return accessibleName(element) === undefined ? undefined : "region"
  return TAG_ROLES[tag]
}

function roleOf(element: Element): string | undefined {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0]
  const role = explicit === undefined || explicit === "" ? implicitRole(element) : explicit
  return role?.slice(0, ROLE_MAX)
}

function squeezed(value: string | null | undefined, max: number): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  return text === "" ? undefined : text.slice(0, max)
}

function accessibleName(element: Element): string | undefined {
  const label = squeezed(element.getAttribute("aria-label"), NAME_MAX)
  if (label !== undefined) return label

  const root = element.getRootNode()
  const ids = element.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? []
  const labelledBy =
    root instanceof Document || root instanceof ShadowRoot
      ? squeezed(ids.map((id) => root.getElementById(id)?.textContent ?? "").join(" "), NAME_MAX)
      : undefined
  if (labelledBy !== undefined) return labelledBy

  const labels = "labels" in element && element.labels instanceof NodeList ? element.labels : []
  return squeezed(Array.from(labels, (label) => label.textContent ?? "").join(" "), NAME_MAX)
}

/** Equals `squeezed(element.textContent, TEXT_MAX)` but stops reading once it has enough. */
function leadingText(element: Element): string | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let text = ""
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const chunk = (node.nodeValue ?? "").replace(/\s+/g, " ")
    text += text === "" || text.endsWith(" ") ? chunk.trimStart() : chunk
    if (text.length > TEXT_MAX) break
  }
  return squeezed(text, TEXT_MAX)
}

export function identityOf(element: Element): Pick<ElementAnchor, "role" | "name" | "text"> {
  const role = roleOf(element)
  const name = accessibleName(element)
  const text = leadingText(element)
  return {
    ...(role === undefined ? {} : { role }),
    ...(name === undefined ? {} : { name }),
    ...(text === undefined ? {} : { text }),
  }
}

function toPage(rect: DOMRectReadOnly): Box {
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  }
}

export function pageBox(element: Element): Box {
  return toPage(element.getBoundingClientRect())
}

export function snapshotElement(el: Element, renderGeneration: number): ElementAnchor {
  return { selector: selectorPath(el), ...identityOf(el), box: pageBox(el), renderGeneration }
}

/** `rect` is in viewport coordinates, as a drag reports it; the target's box is in page coordinates. */
export function regionTarget(rect: DOMRectReadOnly): Extract<NoteTarget, { kind: "region" }> {
  return {
    kind: "region",
    box: toPage(rect),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
  }
}

/** Counts mutation batches on the page, so a stored anchor can tell whether the page re-rendered since. */
export function createRenderGeneration(): { current: () => number; dispose: () => void } {
  let generation = 0
  const observer = new MutationObserver(() => {
    generation += 1
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  return { current: () => generation, dispose: () => observer.disconnect() }
}
