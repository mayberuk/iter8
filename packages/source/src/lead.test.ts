import { expect, test } from "bun:test"
import { SourceBuild, type SourceFrame, SourceFramework, SourceLead } from "@iter8/protocol"
import fc from "fast-check"
import { type Evidence, toLead } from "./lead"

// The exact rows of the source-confidence decision; fixtures/manifest.json labels vite-react,
// next-turbopack, sveltekit and astro exact on the same terms.
const EXACT_ROWS: readonly { framework: SourceFramework; major?: number; build: SourceBuild }[] = [
  { framework: "react", build: "vite" },
  { framework: "react", build: "next-turbopack" },
  { framework: "svelte", major: 5, build: "vite" },
  { framework: "astro", build: "vite" },
]

const listedExact = (evidence: Evidence, build: SourceBuild) =>
  EXACT_ROWS.some(
    (row) =>
      row.framework === evidence.framework &&
      row.build === build &&
      (row.major === undefined || row.major === evidence.major),
  )

const frames = fc.record({
  kind: fc.constantFrom("generated", "source"),
  file: fc.string({ minLength: 1 }),
  line: fc.integer({ min: 1, max: 10_000 }),
})

const evidences = fc.record({
  framework: fc.constantFrom(...SourceFramework.options),
  major: fc.constantFrom(null, 3, 4, 5, 6, 18, 19),
  component: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  frames: fc.array(frames, { maxLength: 12 }),
  onPickedElement: fc.boolean(),
})

const builds = fc.constantFrom(...SourceBuild.options)

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    framework: "react",
    major: 19,
    component: "Card",
    frames: [{ kind: "generated", file: "http://larkspur.localhost:3990/src/Card.jsx", line: 7 }],
    onPickedElement: true,
    ...overrides,
  }
}

test("a lead is exact only for a combination the confidence table lists as exact", () => {
  fc.assert(
    fc.property(evidences, builds, (found, build) => {
      const lead = toLead(found, build)
      expect(lead.confidence === "exact").toBe(
        listedExact(found, build) && found.onPickedElement && found.frames.length > 0,
      )
    }),
  )
})

test("evidence from an ancestor is never exact", () => {
  fc.assert(
    fc.property(evidences, builds, (found, build) => {
      expect(toLead({ ...found, onPickedElement: false }, build).confidence).not.toBe("exact")
    }),
  )
})

test("an ancestor keeps a label below exact rather than raising it", () => {
  fc.assert(
    fc.property(evidences, builds, (found, build) => {
      const onElement = toLead({ ...found, onPickedElement: true }, build).confidence
      const onAncestor = toLead({ ...found, onPickedElement: false }, build).confidence
      expect(onAncestor).toBe(onElement === "exact" ? "approximate" : onElement)
    }),
  )
})

test("every lead is a valid SourceLead", () => {
  fc.assert(
    fc.property(fc.option(evidences, { nil: null }), builds, (found, build) => {
      expect(SourceLead.safeParse(toLead(found, build)).success).toBe(true)
    }),
  )
})

test("no evidence gives none", () => {
  expect(toLead(null, "vite")).toEqual({ confidence: "none" })
})

test("evidence with no frames gives none", () => {
  expect(toLead(evidence({ frames: [] }), "vite")).toEqual({ confidence: "none" })
})

test("twelve frames keep the first eight in their original order", () => {
  const twelve: SourceFrame[] = Array.from({ length: 12 }, (_, index) => ({
    kind: "generated",
    file: `http://larkspur.localhost:3990/src/Frame${index}.jsx`,
    line: index + 1,
  }))
  const lead = toLead(evidence({ frames: twelve }), "vite")
  expect(lead.confidence === "none" ? [] : lead.frames).toEqual(twelve.slice(0, 8))
})

test.each([
  ["react", 19, "vite", "exact"],
  ["react", 19, "next-turbopack", "exact"],
  ["react", 19, "next-webpack", "approximate"],
  ["react", 18, "unknown", "approximate"],
  ["svelte", 5, "vite", "exact"],
  ["svelte", 5, "unknown", "approximate"],
  ["svelte", 4, "vite", "approximate"],
  ["svelte", null, "vite", "approximate"],
  ["vue", 3, "vite", "file-only"],
  ["vue", 3, "unknown", "file-only"],
  ["astro", null, "vite", "exact"],
  ["astro", null, "unknown", "approximate"],
] as const)("%s %p on %s is %s", (framework, major, build, confidence) => {
  expect(toLead(evidence({ framework, major }), build)).toEqual({
    confidence,
    framework,
    build,
    component: "Card",
    frames: evidence().frames,
  })
})
