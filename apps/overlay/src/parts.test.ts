import { expect, test } from "bun:test"
import { join } from "node:path"
import { Iter8Part } from "@iter8/protocol"
import { PARTS } from "./parts"

const repo = join(import.meta.dir, "../../..")
const entries = Object.entries(PARTS)

test.each(entries)("part %s names a source file that exists", async (_key, { source }) => {
  expect(await Bun.file(join(repo, source)).exists()).toBe(true)
})

test.each(entries)("part %s is tagged in the file its source names", async (key, { source }) => {
  const text = await Bun.file(join(repo, source)).text()
  expect(text).toContain(`"${key}"`)
})

test.each(entries)("part %s fits the protocol's part schema", (key, { name, source }) => {
  expect(Iter8Part.safeParse({ key, name, source }).success).toBe(true)
})

test("part names are unique, so a note's label says which part it is about", () => {
  const names = entries.map(([, { name }]) => name)
  expect(new Set(names).size).toBe(names.length)
})
