import { MARKUP_TEXT_LENGTH, type MarkupPath } from "@iter8/protocol"
import { type DefaultTreeAdapterTypes, parse } from "parse5"

function elementChildren(node: DefaultTreeAdapterTypes.ParentNode) {
  return node.childNodes.filter(
    (child): child is DefaultTreeAdapterTypes.Element => "tagName" in child,
  )
}

export function locateInMarkup(
  html: string,
  markup: MarkupPath,
): { line: number; column: number; exact: boolean } | null {
  const document = parse(html, { sourceCodeLocationInfo: true })
  const root = elementChildren(document).find((element) => element.tagName === "html")
  const body = root && elementChildren(root).find((element) => element.tagName === "body")
  if (!body) return null

  let node = body
  let located = body.sourceCodeLocation ? body : null
  let followed = 0
  for (const step of markup.steps) {
    const next = elementChildren(node).filter((child) => child.tagName === step.tag)[step.index]
    if (!next) break
    node = next
    followed++
    if (node.sourceCodeLocation) located = node
  }
  const location = located?.sourceCodeLocation
  if (!location) return null

  const text: string[] = []
  const pending: DefaultTreeAdapterTypes.ChildNode[] = [...node.childNodes].reverse()
  while (pending.length > 0) {
    const child = pending.pop()
    if (!child) continue
    if ("value" in child) text.push(child.value)
    else if ("childNodes" in child) {
      for (let index = child.childNodes.length - 1; index >= 0; index--) {
        const descendant = child.childNodes[index]
        if (descendant) pending.push(descendant)
      }
    }
  }
  return {
    line: location.startLine,
    column: location.startCol,
    exact:
      followed === markup.steps.length &&
      located === node &&
      markup.onPickedElement &&
      (node.attrs.find((attribute) => attribute.name === "id")?.value ?? null) === markup.id &&
      (node.attrs.find((attribute) => attribute.name === "class")?.value ?? null) ===
        markup.className &&
      text.join("").replace(/\s+/g, " ").trimStart().slice(0, MARKUP_TEXT_LENGTH) === markup.text,
  }
}
