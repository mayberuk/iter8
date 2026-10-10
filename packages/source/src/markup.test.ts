import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { textPrefix } from "./markup"

const NBSP = String.fromCodePoint(0xa0)
const EM_SPACE = String.fromCodePoint(0x2003)
const BOM = String.fromCodePoint(0xfeff)

const wholeText = (chunks: string[]) =>
  chunks.join("").replace(/\s+/g, " ").trimStart().slice(0, 64)

const chunk = fc.string({
  unit: fc.constantFrom("a", "b", "é", "<", " ", " ", "\t", "\n", "\r\n", NBSP, EM_SPACE, BOM),
  maxLength: 40,
})

describe("textPrefix", () => {
  test("equals the collapsed text content cut to 64 characters, however it is split into text nodes", () => {
    fc.assert(
      fc.property(fc.array(chunk, { maxLength: 30 }), (chunks) => {
        expect(textPrefix(chunks)).toBe(wholeText(chunks))
      }),
      { numRuns: 500 },
    )
  })

  test("equals the formula for whitespace-only chunks around a few words", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(" ", "\n", NBSP, "ab", "\t ", "c"), { maxLength: 150 }),
        (chunks) => {
          expect(textPrefix(chunks)).toBe(wholeText(chunks))
        },
      ),
      { numRuns: 500 },
    )
  })

  test.each([
    ["no chunks", [], ""],
    ["whitespace only", [" ", "\n", NBSP], ""],
    ["leading whitespace split across chunks", [" ", "\n ", "a"], "a"],
    ["a whitespace run split across chunks", ["a ", " \n", `${NBSP}b`], "a b"],
    ["a non-breaking space", [`a${NBSP}${NBSP}b`], "a b"],
  ])("%s", (_label, chunks, expected) => {
    expect(textPrefix(chunks)).toBe(expected)
  })

  test("cuts at 64 characters", () => {
    expect(textPrefix(["x".repeat(100)])).toBe("x".repeat(64))
    expect(textPrefix(["x".repeat(64)])).toBe("x".repeat(64))
    expect(textPrefix(["x".repeat(63)])).toBe("x".repeat(63))
  })

  test("stops reading once the prefix is longer than 64 characters", () => {
    let pulled = 0
    function* chunks() {
      for (;;) {
        pulled += 1
        yield "x".repeat(30)
      }
    }
    expect(textPrefix(chunks())).toBe("x".repeat(64))
    expect(pulled).toBe(3)
  })

  test("keeps reading while collapsing leaves the prefix at or under 64 characters", () => {
    let pulled = 0
    function* chunks() {
      while (pulled < 500) {
        pulled += 1
        yield " "
      }
      yield "end"
    }
    expect(textPrefix(chunks())).toBe("end")
    expect(pulled).toBe(500)
  })
})
