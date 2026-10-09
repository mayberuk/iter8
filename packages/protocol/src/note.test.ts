import { expect, test } from "bun:test"
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
