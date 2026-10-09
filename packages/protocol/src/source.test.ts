import { expect, test } from "bun:test"
import { ResolvedSourceLead, SourceLead } from "./source"

const frame = { kind: "generated", file: "http://larkspur.localhost:3990/src/Card.tsx", line: 4 }
const lead = (frames: unknown[]) => ({
  confidence: "exact",
  framework: "react",
  build: "vite",
  component: "Card",
  frames,
})

test("a source lead carries between 1 and 8 frames", () => {
  expect(SourceLead.safeParse(lead([])).success).toBe(false)
  expect(SourceLead.safeParse(lead(Array(9).fill(frame))).success).toBe(false)
  expect(SourceLead.safeParse(lead([frame])).success).toBe(true)
  expect(SourceLead.safeParse(lead(Array(8).fill(frame))).success).toBe(true)
})

const fileOnly = {
  confidence: "file-only",
  framework: "vue",
  component: "Card",
  file: "src/components/Card.vue",
}

test("a file-only resolved lead never carries a line or a column", () => {
  expect(ResolvedSourceLead.safeParse(fileOnly).success).toBe(true)
  expect(ResolvedSourceLead.safeParse({ ...fileOnly, line: 12 }).success).toBe(false)
  expect(ResolvedSourceLead.safeParse({ ...fileOnly, column: 3 }).success).toBe(false)
})

test("a resolved lead of none states why", () => {
  expect(ResolvedSourceLead.safeParse({ confidence: "none" }).success).toBe(false)
  expect(
    ResolvedSourceLead.safeParse({ confidence: "none", reason: "outside-project" }).success,
  ).toBe(true)
})

test("a resolved file is relative to the project and stays inside it", () => {
  const exact = { ...fileOnly, confidence: "exact", framework: "react", line: 4 }
  expect(ResolvedSourceLead.safeParse(exact).success).toBe(true)
  for (const file of ["/home/biruk/app/src/Card.tsx", "../other/Card.tsx", "src/../../Card.tsx"])
    expect(ResolvedSourceLead.safeParse({ ...exact, file }).success).toBe(false)
})
