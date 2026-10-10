import { expect, test } from "bun:test"
import type { Box, ElementAnchor } from "@iter8/protocol"
import fc from "fast-check"
import { type AnchorCandidate, chooseAnchor } from "./anchor"

type Identity = Pick<AnchorCandidate, "role" | "name" | "text">

function stored(identity: Identity, box: Box): ElementAnchor {
  return {
    selector: ["body > button:nth-of-type(1)"],
    ...(identity.role === undefined ? {} : { role: identity.role }),
    ...(identity.name === undefined ? {} : { name: identity.name }),
    ...(identity.text === undefined ? {} : { text: identity.text }),
    box,
    renderGeneration: 0,
  }
}

function at(x: number, y: number, width = 30, height = 40): Box {
  return { x, y, width, height }
}

const SAVE: Identity = { role: "button", name: undefined, text: "Save" }
const HOME = at(100, 100)

const identities = fc.record({
  role: fc.constantFrom<string | undefined>(undefined, "button", "link"),
  name: fc.constantFrom<string | undefined>(undefined, "Save", "Close"),
  text: fc.constantFrom<string | undefined>(undefined, "Save", "Saved"),
})
const boxes = fc.record({
  x: fc.integer({ min: 0, max: 400 }),
  y: fc.integer({ min: 0, max: 400 }),
  width: fc.integer({ min: 0, max: 120 }),
  height: fc.integer({ min: 0, max: 120 }),
})
const candidates = fc.array(
  fc
    .record({ identity: identities, box: boxes })
    .map(({ identity, box }) => ({ ...identity, box })),
  { maxLength: 8 },
)
const anchors = fc
  .record({ identity: identities, box: boxes })
  .map(({ identity, box }) => stored(identity, box))

test("a re-anchored pin either resolves to one element or is marked moved", () => {
  fc.assert(
    fc.property(anchors, candidates, (anchor, list) => {
      const choice = chooseAnchor(anchor, list)
      if (choice.kind === "lost") {
        expect(["missing", "ambiguous"]).toContain(choice.reason)
        return
      }
      expect(Number.isInteger(choice.index)).toBe(true)
      const picked = list[choice.index]
      expect(picked).toBeDefined()
      expect(picked?.role).toBe(anchor.role)
      expect(picked?.name).toBe(anchor.name)
    }),
  )
  fc.assert(
    fc.property(anchors, candidates, (anchor, list) => {
      expect(chooseAnchor(anchor, [...list, ...list]).kind).toBe("lost")
    }),
  )
})

test("no candidates at all is missing", () => {
  expect(chooseAnchor(stored(SAVE, HOME), [])).toEqual({ kind: "lost", reason: "missing" })
})

test("the one candidate matching role, name and text is anchored wherever it now is", () => {
  const choice = chooseAnchor(stored(SAVE, HOME), [
    { role: "button", name: undefined, text: "Cancel", box: HOME },
    { ...SAVE, box: at(2000, 3000) },
    { role: "link", name: undefined, text: "Save", box: HOME },
  ])
  expect(choice).toEqual({ kind: "anchored", index: 1 })
})

test("among identical matches the strictly nearest one within reach is anchored", () => {
  const choice = chooseAnchor(stored(SAVE, HOME), [
    { ...SAVE, box: at(100, 300) },
    { ...SAVE, box: at(104, 103) },
  ])
  expect(choice).toEqual({ kind: "anchored", index: 1 })
})

test("identical matches equally near the stored box are ambiguous", () => {
  const choice = chooseAnchor(stored(SAVE, HOME), [
    { ...SAVE, box: at(100, 70) },
    { ...SAVE, box: at(100, 130) },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "ambiguous" })
})

test("identical matches all out of reach are ambiguous, not missing", () => {
  const choice = chooseAnchor(stored(SAVE, HOME), [
    { ...SAVE, box: at(100, 900) },
    { ...SAVE, box: at(100, 1200) },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "ambiguous" })
})

const SAVE_NAMED: Identity = { role: "button", name: "Save draft", text: "Save" }

test("with no exact match, a same role and name candidate is anchored only inside half the diagonal plus 48 px", () => {
  // A 30 × 40 box has a 50 px diagonal, so the reach is 25 + 48 = 73 px from its centre.
  const edited = { role: "button", name: "Save draft", text: "Saved" }
  expect(chooseAnchor(stored(SAVE_NAMED, HOME), [{ ...edited, box: at(172, 100) }])).toEqual({
    kind: "anchored",
    index: 0,
  })
  expect(chooseAnchor(stored(SAVE_NAMED, HOME), [{ ...edited, box: at(173, 100) }])).toEqual({
    kind: "lost",
    reason: "missing",
  })
})

test("an element with no accessible name whose text differs never re-anchors, even in its own box", () => {
  const drop = stored({ role: "button", name: undefined, text: "Drop me" }, HOME)
  const choice = chooseAnchor(drop, [
    { role: "button", name: undefined, text: "Keep me", box: HOME },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "missing" })
})

test("with no exact match, two same role and name candidates equally near are ambiguous", () => {
  const edited = { role: "button", name: "Save draft", text: "Saved" }
  const choice = chooseAnchor(stored(SAVE_NAMED, HOME), [
    { ...edited, box: at(120, 100) },
    { ...edited, box: at(80, 100) },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "ambiguous" })
})

test("a candidate with a different role or name never re-anchors, however near", () => {
  const named = stored({ role: "button", name: "Save draft", text: "Save" }, HOME)
  const choice = chooseAnchor(named, [
    { role: "button", name: "Discard", text: "Save", box: HOME },
    { role: "link", name: "Save draft", text: "Save", box: HOME },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "missing" })
})

test("an anchor with neither role nor name is lost when its text changes, even beside a same-tag node", () => {
  const paragraph = stored({ role: undefined, name: undefined, text: "Card in static" }, HOME)
  const choice = chooseAnchor(paragraph, [
    { role: undefined, name: undefined, text: "Details for the static page.", box: at(100, 110) },
  ])
  expect(choice).toEqual({ kind: "lost", reason: "missing" })
})
