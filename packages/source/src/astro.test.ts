import { expect, test } from "bun:test"
import { astroEvidence } from "./astro"

const FILE = "/work/fixtures/astro/src/pages/multiline.astro"

function annotated(attributes: Record<string, string>): Element {
  return { getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element
}

async function locatedAt(loc: string | undefined) {
  const element = annotated({
    "data-astro-source-file": FILE,
    ...(loc === undefined ? {} : { "data-astro-source-loc": loc }),
  })
  return astroEvidence(element, { signal: new AbortController().signal, depth: 0 })
}

test.each([
  ["16:6", 16],
  ["1:30", 1],
  ["12:9", 12],
  ["10:7", 10],
  ["204:1", 204],
])("a source location of %s reports line %i, never a fixed line", async (loc, line) => {
  expect(await locatedAt(loc)).toEqual({
    framework: "astro",
    major: null,
    component: "multiline",
    frames: [{ kind: "source", file: FILE, line }],
    onPickedElement: true,
  })
})

test.each([
  ["no location", undefined],
  ["a location with no line", ":6"],
  ["a line of zero", "0:6"],
  ["a non-numeric line", "x:6"],
])("%s leaves the line off the frame", async (_label, loc) => {
  expect((await locatedAt(loc))?.frames).toEqual([{ kind: "source", file: FILE }])
})

test("an element with no source file carries no live evidence", async () => {
  const element = annotated({ "data-astro-source-loc": "3:4" })
  const context = { signal: new AbortController().signal, depth: 1 }
  expect(await astroEvidence(element, context)).toBeNull()
})
