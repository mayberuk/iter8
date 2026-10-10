import { expect, test } from "bun:test"
import fc from "fast-check"
import { diffStyles, VISUAL_PROPERTIES } from "./styles"

test("a property the target sets differently from its parent is reported with the target's value", () => {
  expect(
    diffStyles(
      { color: "rgb(255, 0, 0)", "font-size": "16px" },
      { color: "rgb(0, 0, 0)", "font-size": "16px" },
    ),
  ).toEqual({ color: "rgb(255, 0, 0)" })
})

test("a property the parent lacks counts as different", () => {
  expect(diffStyles({ "border-radius": "8px" }, {})).toEqual({ "border-radius": "8px" })
})

test("a property the target lacks is not reported", () => {
  expect(diffStyles({}, { opacity: "0.5" })).toEqual({})
})

test("a property outside the visual list is never reported, however different", () => {
  expect(diffStyles({ cursor: "pointer", "will-change": "transform" }, {})).toEqual({})
})

test("the visual list covers each group a capture reports, at about forty properties", () => {
  expect(VISUAL_PROPERTIES).toEqual(
    expect.arrayContaining([
      "margin",
      "padding",
      "background-color",
      "border-top",
      "border-radius",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "text-align",
      "text-transform",
      "display",
      "position",
      "flex-direction",
      "grid-template-columns",
      "gap",
      "opacity",
      "z-index",
      "overflow",
      "box-shadow",
      "transform",
    ]),
  )
  expect(VISUAL_PROPERTIES.length).toBeGreaterThanOrEqual(35)
  expect(VISUAL_PROPERTIES.length).toBeLessThanOrEqual(45)
  expect(new Set(VISUAL_PROPERTIES).size).toBe(VISUAL_PROPERTIES.length)
})

test("every reported property is a listed one whose target value differs from the parent's", () => {
  const property = fc.constantFrom(...VISUAL_PROPERTIES, "cursor", "content")
  const value = fc.constantFrom("0px", "8px", "auto", "none")
  const styles = fc.dictionary(property, value)
  fc.assert(
    fc.property(styles, styles, (target, parent) => {
      const diff = diffStyles(target, parent)
      for (const [key, reported] of Object.entries(diff)) {
        expect(VISUAL_PROPERTIES as readonly string[]).toContain(key)
        expect(reported).toBe(target[key] as string)
        expect(parent[key]).not.toBe(reported)
      }
      for (const key of VISUAL_PROPERTIES) {
        if (target[key] !== undefined && target[key] !== parent[key]) {
          expect(diff[key]).toBe(target[key] as string)
        }
      }
    }),
  )
})
