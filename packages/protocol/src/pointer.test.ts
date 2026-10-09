import { expect, test } from "bun:test"
import fc from "fast-check"
import { formatPointer, POINTER_LINE, RoundPointer } from "./pointer"

const pointer = (roundId: string, pageId: string, noteCount: number) =>
  RoundPointer.parse({ roundId, pageId, noteCount })

test("a pointer reads exactly as the design states, with a middle dot and an em dash", () => {
  expect(formatPointer(pointer("R12", "larkspur", 7))).toBe(
    "Review round R12 from larkspur \u00b7 7 notes \u2014 run `iter8 show R12`",
  )
})

test("a single note is not pluralised", () => {
  expect(formatPointer(pointer("R3", "larkspur", 1))).toBe(
    "Review round R3 from larkspur \u00b7 1 note \u2014 run `iter8 show R3`",
  )
})

const pointers = fc
  .record({
    roundId: fc.integer({ min: 1 }).map((n) => `R${n}`),
    pageId: fc.stringMatching(/^[a-z][a-z0-9-]{1,30}$/),
    noteCount: fc.integer({ min: 1, max: 10_000 }),
  })
  .map((raw) => RoundPointer.parse(raw))

test("every formatted pointer matches POINTER_LINE and captures what it was given", () => {
  fc.assert(
    fc.property(pointers, (p) => {
      const line = formatPointer(p)
      const groups = POINTER_LINE.exec(line)?.groups
      const inBackticks = /`iter8 show (R[0-9]+)`$/.exec(line)?.[1]
      expect(groups).toEqual({ id: p.roundId, page: p.pageId, count: String(p.noteCount) })
      expect(groups?.id).toBe(inBackticks)
    }),
  )
})

test("POINTER_LINE refuses a pointer with anything after the closing backtick", () => {
  fc.assert(
    fc.property(pointers, fc.string({ minLength: 1 }), (p, tail) => {
      expect(POINTER_LINE.test(formatPointer(p) + tail)).toBe(false)
    }),
  )
})

test("POINTER_LINE refuses lines formatPointer cannot produce", () => {
  const real = formatPointer(pointer("R12", "larkspur", 7))
  for (const line of [
    real.replace("7 notes", "1 notes"),
    real.replace("7 notes", "7 note"),
    real.replace("show R12", "show R13"),
    real.replace("\u00b7", "-"),
    real.replace("\u2014", "-"),
    `> ${real}`,
  ])
    expect(POINTER_LINE.test(line)).toBe(false)
})
