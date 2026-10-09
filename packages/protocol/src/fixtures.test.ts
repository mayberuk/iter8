import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { z } from "zod"
import * as protocol from "./index"

const root = Bun.fileURLToPath(new URL("../fixtures/", import.meta.url))
const fixtures = (await readdir(root)).filter((file) => file.endsWith(".json")).sort()

const exported = Object.entries<unknown>(protocol).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
)

/** `NAME.json` or `NAME.VARIANT.json` names the exported schema that parses it. */
function schemaFor(file: string): z.ZodType {
  const name = file.split(".")[0] ?? ""
  const found = exported.find(([exportedName]) => exportedName === name)
  if (!found) throw new Error(`fixtures/${file} names no schema exported from the protocol`)
  return found[1]
}

function nameOf(schema: z.ZodType, where: string): string {
  const found = exported.find(([, candidate]) => candidate === schema)
  if (!found) throw new Error(`${where} is not an exported schema, so no fixture can name it`)
  return found[0]
}

const routeFixtures = Object.entries(protocol.OVERLAY_ROUTES).flatMap(([route, spec]) =>
  [spec.request, spec.response]
    .filter((schema) => schema !== null)
    .map((schema) => `${nameOf(schema, `OVERLAY_ROUTES.${route}`)}.json`),
)
const messageFixtures = [
  ...protocol.ServerMessage.options.map(
    (option) => `ServerMessage.${option.shape.type.value}.json`,
  ),
  ...protocol.ClientMessage.options.map(
    (option) => `ClientMessage.${option.shape.type.value}.json`,
  ),
]
const cliFixtures = Object.entries(protocol.CLI_SURFACE).flatMap(([command, spec]) =>
  spec.output === null ? [] : [`${nameOf(spec.output, `CLI_SURFACE["${command}"]`)}.json`],
)
const namedVariants: Record<string, unknown> = {
  "Capture.stale.json": { completeness: "stale" },
  "Note.unanchored.json": { anchorStatus: "unanchored" },
  "SourceLead.none.json": { confidence: "none" },
  "ResolvedSourceLead.none.json": { confidence: "none" },
  "ResolvedSourceLead.file-only.json": { confidence: "file-only" },
  "Pairing.gone.json": { state: { status: "gone" } },
  "Round.orphaned.json": { state: { stage: "orphaned" } },
  "Round.queued.json": { state: { stage: "queued" } },
  "HelloResult.refused.json": { outcome: "refused" },
  "SendResult.refused.json": { outcome: "refused" },
  "AttachResult.refused.json": { outcome: "refused" },
  "ShowResult.capture-omitted.json": {
    notes: expect.arrayContaining([
      expect.objectContaining({
        untrustedCapture: expect.objectContaining({ completeness: "omitted" }),
      }),
    ]),
  },
}
const degradedFixtures = Object.keys(namedVariants)

test("a fixture naming no exported schema fails by name", () => {
  expect(() => schemaFor("NotASchema.json")).toThrow("fixtures/NotASchema.json")
})

test("a schema missing from the exports fails by where it is used", () => {
  expect(() => nameOf(z.object({}), "OVERLAY_ROUTES.example")).toThrow("OVERLAY_ROUTES.example")
})

for (const required of new Set([
  ...routeFixtures,
  ...messageFixtures,
  ...cliFixtures,
  ...degradedFixtures,
]))
  test(`fixture ${required} exists`, () => {
    expect(fixtures).toContain(required)
  })

for (const file of fixtures)
  test(`${file} parses and survives a JSON round trip`, async () => {
    const value = JSON.parse(await Bun.file(`${root}${file}`).text())
    const parsed = schemaFor(file).parse(value)
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(value)
  })

for (const file of messageFixtures)
  test(`${file} holds the message its name states`, async () => {
    const value = await Bun.file(`${root}${file}`).json()
    const variant = file.split(".")[1]
    expect(schemaFor(file).parse(value)).toHaveProperty("type", variant)
  })

for (const [file, expected] of Object.entries(namedVariants))
  test(`${file} exercises the variant its name states`, async () => {
    const value = await Bun.file(`${root}${file}`).json()
    expect(schemaFor(file).parse(value)).toMatchObject(expected as Record<string, unknown>)
  })

test("every fixture named for a variant is checked against that variant", () => {
  const checked = new Set([...messageFixtures, ...degradedFixtures])
  const unchecked = fixtures.filter((file) => file.split(".").length > 2 && !checked.has(file))
  expect(unchecked).toEqual([])
})
