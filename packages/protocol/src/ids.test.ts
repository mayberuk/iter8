import { expect, test } from "bun:test"
import fc from "fast-check"
import { IdempotencyKey, NoteId, OwnerId, PageId, PageToken, RoundId } from "./ids"

const whitespace = fc.constantFrom(" ", "\t", "\n", "\r", " ", " ")

function withInserted(valid: fc.Arbitrary<string>, insert: fc.Arbitrary<string>) {
  return fc.tuple(valid, insert, fc.nat()).map(([id, extra, at]) => {
    const index = at % (id.length + 1)
    return id.slice(0, index) + extra + id.slice(index)
  })
}

const pageIds = fc.stringMatching(/^[a-z][a-z0-9-]{1,30}$/)
const roundIds = fc.integer({ min: 1 }).map((n) => `R${n}`)
const noteIds = fc.integer({ min: 1 }).map((n) => `N${n}`)
const ownerIds = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => !/\s/.test(s))
const pageTokens = fc.stringMatching(/^[A-Za-z0-9_-]{32,64}$/)

test("every id generated from its stated format parses", () => {
  fc.assert(fc.property(pageIds, (id) => PageId.safeParse(id).success))
  fc.assert(fc.property(roundIds, (id) => RoundId.safeParse(id).success))
  fc.assert(fc.property(noteIds, (id) => NoteId.safeParse(id).success))
  fc.assert(fc.property(ownerIds, (id) => OwnerId.safeParse(id).success))
  fc.assert(fc.property(pageTokens, (id) => PageToken.safeParse(id).success))
  fc.assert(
    fc.property(
      fc.string({ minLength: 8, maxLength: 100 }),
      (key) => IdempotencyKey.safeParse(key).success,
    ),
  )
})

test("an empty id is refused", () => {
  for (const schema of [PageId, RoundId, NoteId, OwnerId, PageToken, IdempotencyKey])
    expect(schema.safeParse("").success).toBe(false)
})

test("an id with whitespace anywhere in it is refused", () => {
  const cases = [
    [PageId, pageIds],
    [RoundId, roundIds],
    [NoteId, noteIds],
    [OwnerId, ownerIds],
    [PageToken, pageTokens],
  ] as const
  for (const [schema, valid] of cases)
    fc.assert(fc.property(withInserted(valid, whitespace), (id) => !schema.safeParse(id).success))
})

test("a round or note id with the wrong prefix or a leading zero is refused", () => {
  const digits = fc.integer({ min: 1 }).map(String)
  const notR = fc.string({ minLength: 1, maxLength: 3 }).filter((p) => !p.startsWith("R"))
  const notN = fc.string({ minLength: 1, maxLength: 3 }).filter((p) => !p.startsWith("N"))
  fc.assert(fc.property(notR, digits, (prefix, n) => !RoundId.safeParse(prefix + n).success))
  fc.assert(fc.property(notN, digits, (prefix, n) => !NoteId.safeParse(prefix + n).success))
  fc.assert(fc.property(noteIds, (id) => !RoundId.safeParse(id).success))
  fc.assert(fc.property(roundIds, (id) => !NoteId.safeParse(id).success))
  for (const id of ["R", "R0", "R01", "N", "N0", "N007"])
    expect(RoundId.safeParse(id).success || NoteId.safeParse(id).success).toBe(false)
})

test("a round or note id followed by anything but digits is refused", () => {
  const suffix = fc
    .tuple(fc.string({ unit: "binary", minLength: 1, maxLength: 1 }), fc.string({ maxLength: 4 }))
    .filter(([first]) => !/[0-9]/.test(first))
    .map(([first, rest]) => first + rest)
  fc.assert(fc.property(roundIds, suffix, (id, tail) => !RoundId.safeParse(id + tail).success))
  fc.assert(fc.property(noteIds, suffix, (id, tail) => !NoteId.safeParse(id + tail).success))
  expect(RoundId.safeParse("R12x").success).toBe(false)
  expect(NoteId.safeParse("N12x").success).toBe(false)
})

test("a page id that is not a lowercase DNS label of 2 to 31 characters is refused", () => {
  const badStart = fc.tuple(fc.stringMatching(/^[0-9-]$/), pageIds).map(([c, id]) => c + id)
  const upper = withInserted(pageIds, fc.stringMatching(/^[A-Z]$/))
  const tooLong = fc.stringMatching(/^[a-z][a-z0-9-]{31,40}$/)
  for (const bad of [badStart, upper, tooLong])
    fc.assert(fc.property(bad, (id) => !PageId.safeParse(id).success))
  expect(PageId.safeParse("a").success).toBe(false)
})

test("a page id with punctuation or any other character outside a-z, 0-9 and - is refused", () => {
  const forbidden = fc
    .string({ unit: "binary", minLength: 1, maxLength: 1 })
    .filter((c) => !/[a-z0-9-]/.test(c))
  fc.assert(fc.property(withInserted(pageIds, forbidden), (id) => !PageId.safeParse(id).success))
  for (const id of ["ab.cd", "ab_cd", "ab cd", "ab/cd", "ab:cd", "ab+cd", "ab\u00e9cd"])
    expect(PageId.safeParse(id).success).toBe(false)
})

test("an owner id over 200 characters is refused", () => {
  expect(OwnerId.safeParse("o".repeat(201)).success).toBe(false)
})

test("a page token shorter than 32 characters or outside unpadded base64url is refused", () => {
  fc.assert(
    fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{1,31}$/), (t) => !PageToken.safeParse(t).success),
  )
  fc.assert(
    fc.property(
      withInserted(pageTokens, fc.constantFrom("=", "+", "/", ".")),
      (t) => !PageToken.safeParse(t).success,
    ),
  )
})

test("an idempotency key outside 8 to 100 characters is refused", () => {
  expect(IdempotencyKey.safeParse("k".repeat(7)).success).toBe(false)
  expect(IdempotencyKey.safeParse("k".repeat(101)).success).toBe(false)
})
