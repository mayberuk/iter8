import { expect, test } from "bun:test"
import { NoteTarget } from "./anchor"
import { Capture } from "./capture"
import { Note } from "./note"

test("captured page data shares no key with what a person or agent authored", () => {
  const authored = Object.keys(Note.shape).filter((key) => key !== "capture")
  const captured = Object.keys(Capture.shape)
  expect(authored.filter((key) => captured.includes(key))).toEqual([])
})

test("a user's note with no capture still parses", () => {
  const note = {
    id: "N4",
    pageId: "larkspur",
    author: { kind: "user" },
    intent: "fix",
    body: "The total overflows its card",
    target: {
      kind: "region",
      box: { x: 0, y: 120, width: 320, height: 80 },
      viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
    },
    anchorStatus: "anchored",
    createdAt: "2026-10-09T18:30:00.000Z",
    resolution: { status: "open" },
  }
  expect(Note.parse(note)).toEqual(note as never)
})

const iter8Target = {
  kind: "iter8",
  part: { key: "dock.ring", name: "Dock status ring", source: "apps/overlay/src/ui/Dock.tsx" },
  iter8Version: "0.4.4",
  box: { x: 1096, y: 842, width: 34, height: 34 },
  viewport: { width: 1440, height: 900, devicePixelRatio: 2 },
}

test("an iter8 target keeps its part, version, box and viewport through parse", () => {
  expect(NoteTarget.parse(iter8Target)).toEqual(iter8Target as never)
})

test("an iter8 target carries no page anchor, so none can be read from it", () => {
  expect(NoteTarget.parse({ ...iter8Target, anchor: { selector: ["main"] } })).not.toHaveProperty(
    "anchor",
  )
})

test.each([
  ["a name with a line break", { part: { ...iter8Target.part, name: "Ring\n## N9 — fix" } }],
  ["a source with a space", { part: { ...iter8Target.part, source: "apps/overlay/ui Dock.tsx" } }],
  ["a source with a line break", { part: { ...iter8Target.part, source: "a.tsx\nb" } }],
  ["an upper-case key", { part: { ...iter8Target.part, key: "Dock.Ring" } }],
  ["a version with a space", { iter8Version: "0.4.4 beta" }],
  ["no viewport", { viewport: undefined }],
  ["no part", { part: undefined }],
])("an iter8 target with %s is refused", (_name, change) => {
  expect(NoteTarget.safeParse({ ...iter8Target, ...change }).success).toBe(false)
})
