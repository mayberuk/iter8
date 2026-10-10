/**
 * The visual properties a capture reports. Shorthands like `margin` and `border-top` read back as
 * one computed value in Chromium, which keeps the list short without losing a side.
 */
export const VISUAL_PROPERTIES = [
  "box-sizing",
  "width",
  "height",
  "margin",
  "padding",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration-line",
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "flex-direction",
  "flex-wrap",
  "flex",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "grid-template-rows",
  "gap",
  "opacity",
  "z-index",
  "overflow",
  "box-shadow",
  "transform",
] as const

export function diffStyles(
  target: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string>>,
): Record<string, string> {
  const diff: Record<string, string> = {}
  for (const property of VISUAL_PROPERTIES) {
    const value = target[property]
    if (value !== undefined && value !== parent[property]) diff[property] = value
  }
  return diff
}
