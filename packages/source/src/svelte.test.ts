import { expect, test } from "bun:test"
import { SourceLead } from "@iter8/protocol"
import { toLead } from "./lead"
import { svelteEvidence, svelteMetaEvidence } from "./svelte"

const meta = { parent: null, loc: { file: "src/lib/Card.svelte", line: 6, column: 2 } }

test("a Svelte 5 location becomes one source frame with a 1-based column", () => {
  expect(svelteMetaEvidence(meta, 5)).toEqual({
    framework: "svelte",
    major: 5,
    component: "Card",
    frames: [{ kind: "source", file: "src/lib/Card.svelte", line: 6, column: 3 }],
    onPickedElement: true,
  })
})

test("the file is passed through exactly as the compiler wrote it", () => {
  const evidence = svelteMetaEvidence(
    { loc: { file: "/home/ada/app/src/routes/+page.svelte", line: 1, column: 0 } },
    5,
  )
  expect(evidence?.frames[0]).toMatchObject({ file: "/home/ada/app/src/routes/+page.svelte" })
  expect(evidence?.component).toBe("+page")
})

test("a Svelte 5 element on a Vite page is exact and carries the frame", () => {
  const lead = SourceLead.parse(toLead(svelteMetaEvidence(meta, 5), "vite"))
  expect(lead).toMatchObject({ confidence: "exact", framework: "svelte", component: "Card" })
})

test("a Svelte 4 element is approximate on every build, with its line as given", () => {
  const evidence = svelteMetaEvidence(meta, 4)
  expect(evidence?.major).toBe(4)
  for (const build of ["vite", "next-turbopack", "next-webpack", "unknown"] as const) {
    const lead = SourceLead.parse(toLead(evidence, build))
    expect(lead).toMatchObject({
      confidence: "approximate",
      frames: [{ kind: "source", line: 6 }],
    })
  }
})

test.each([
  ["no meta", undefined],
  ["a meta without loc", { parent: null }],
  ["a loc without a file", { loc: { line: 1, column: 0 } }],
  ["an empty file", { loc: { file: "", line: 1, column: 0 } }],
])("%s gives no evidence", (_label, value) => {
  expect(svelteMetaEvidence(value, 5)).toBeNull()
})

test("a missing or malformed line and column are left off the frame", () => {
  const evidence = svelteMetaEvidence({ loc: { file: "A.svelte", line: 0, column: "3" } }, 5)
  expect(evidence?.frames).toEqual([{ kind: "source", file: "A.svelte" }])
})

const PICKED = { __svelte_meta: meta } as unknown as Element
const CONTEXT = { signal: new AbortController().signal, depth: 0 }

async function readWith(runtime: unknown) {
  const had = Reflect.has(globalThis, "window")
  const before: unknown = Reflect.get(globalThis, "window")
  Reflect.set(globalThis, "window", runtime === undefined ? {} : { __svelte: runtime })
  try {
    return await svelteEvidence(PICKED, CONTEXT)
  } finally {
    if (had) Reflect.set(globalThis, "window", before)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test.each([
  ["a single 4", ["4"], 4],
  ["a single 5", ["5"], 5],
  ["5 listed before 4", ["5", "4"], 5],
  ["4 listed before 5", ["4", "5"], 5],
  ["three majors out of order", ["3", "5", "4"], 5],
  ["a non-numeric entry before a number", ["canary", "4"], 4],
  ["a non-numeric entry after a number", ["4", "canary"], 4],
  ["a non-numeric entry between two numbers", ["4", "next", "5"], 5],
  ["only non-numeric entries", ["canary", "latest"], null],
  ["no entries", [], null],
])(
  "the page's major is the highest numeric entry of __svelte.v: %s",
  async (_label, entries, major) => {
    const evidence = await readWith({ v: new Set(entries) })
    expect(evidence?.major).toBe(major)
    expect(evidence?.frames).toEqual([
      { kind: "source", file: "src/lib/Card.svelte", line: 6, column: 3 },
    ])
  },
)

test.each([
  ["__svelte is absent", undefined],
  ["__svelte has no v", {}],
  ["__svelte.v is not a set of entries", "5"],
])("%s: the lead still carries the location, with no major", async (_label, runtime) => {
  const evidence = await readWith(runtime)
  expect(evidence?.major).toBeNull()
  expect(evidence?.component).toBe("Card")
})

test("the runtime's major decides the label: 4 is approximate, 5 is exact, on Vite", async () => {
  const labelFor = async (entries: string[]) =>
    toLead(await readWith({ v: new Set(entries) }), "vite").confidence
  expect(await labelFor(["4"])).toBe("approximate")
  expect(await labelFor(["5"])).toBe("exact")
  expect(await labelFor(["4", "5"])).toBe("exact")
  expect(await labelFor(["5", "4"])).toBe("exact")
})
