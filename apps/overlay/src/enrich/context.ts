import { parentAcrossShadow } from "../pick/anchor"

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "form",
  "main",
  "navigation",
  "region",
  "search",
])

const IMPLICIT_ROLES: Readonly<Record<string, string>> = {
  main: "main",
  nav: "navigation",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  form: "form",
  dialog: "dialog",
}

const TEXT_NODE_LIMIT = 200
const TEXT_CHAR_LIMIT = 600
const NOT_PROSE = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"])

function accessibleName(el: Element): string {
  const label = el.getAttribute("aria-label")?.trim()
  if (label) return label
  const ids = el.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? []
  const root = el.getRootNode()
  if (!(root instanceof Document || root instanceof ShadowRoot)) return ""
  return ids
    .map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
}

function landmarkRole(el: Element): string | undefined {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0]
  if (explicit) return LANDMARK_ROLES.has(explicit) ? explicit : undefined
  const implicit = IMPLICIT_ROLES[el.localName]
  if (implicit) return implicit
  if (el.localName === "section" && accessibleName(el)) return "region"
  return undefined
}

function landmarkOf(el: Element): string | undefined {
  for (let node: Element | null = el; node !== null; node = parentAcrossShadow(node)) {
    const role = landmarkRole(node)
    if (role === undefined) continue
    const name = accessibleName(node)
    return name ? `${role} · ${name}` : role
  }
  return undefined
}

function textAround(el: Element): string {
  const root = parentAcrossShadow(el) ?? el
  const walker = el.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const parts: string[] = []
  let length = 0
  for (let seen = 0; seen < TEXT_NODE_LIMIT && length < TEXT_CHAR_LIMIT; seen++) {
    const node = walker.nextNode()
    if (node === null) break
    if (node.parentElement !== null && NOT_PROSE.has(node.parentElement.tagName)) continue
    const text = node.nodeValue?.replace(/\s+/g, " ").trim()
    if (!text) continue
    parts.push(text)
    length += text.length + 1
  }
  return parts.join(" ").slice(0, TEXT_CHAR_LIMIT)
}

export function describeContext(el: Element): { landmark?: string; surroundingText?: string } {
  const landmark = landmarkOf(el)
  const surroundingText = textAround(el)
  return {
    ...(landmark ? { landmark } : {}),
    ...(surroundingText ? { surroundingText } : {}),
  }
}
