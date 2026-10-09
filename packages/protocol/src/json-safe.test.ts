import { expect, test } from "bun:test"
import { z } from "zod"
import * as protocol from "./index"

const UNSAFE = new Set(["transform", "pipe", "date", "map", "set", "custom", "default", "prefault"])

function children(schema: z.core.$ZodTypes): z.core.$ZodType[] {
  const def = schema._zod.def
  switch (def.type) {
    case "object":
      return [...Object.values(def.shape), ...(def.catchall ? [def.catchall] : [])]
    case "array":
      return [def.element]
    case "tuple":
      return [...def.items, ...(def.rest ? [def.rest] : [])]
    case "record":
      return [def.keyType, def.valueType]
    case "union":
      return [...def.options]
    case "intersection":
      return [def.left, def.right]
    case "pipe":
      return [def.in, def.out]
    case "lazy":
      return [def.getter()]
    case "optional":
    case "nullable":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "default":
    case "prefault":
    case "promise":
      return [def.innerType]
    default:
      return []
  }
}

function unsafeNodes(schema: z.core.$ZodType, seen = new Set<z.core.$ZodType>()): string[] {
  if (seen.has(schema)) return []
  seen.add(schema)
  const own = schema as z.core.$ZodTypes
  const type = own._zod.def.type
  return [
    ...(UNSAFE.has(type) ? [type] : []),
    ...children(own).flatMap((child) => unsafeNodes(child, seen)),
  ]
}

const schemas = Object.entries<unknown>(protocol).filter(
  (entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType,
)

test("the walk finds an unsafe node however deep it sits", () => {
  expect(unsafeNodes(z.object({ a: z.array(z.string().transform(Number)) }))).toContain("pipe")
  expect(unsafeNodes(z.object({ a: z.date().nullable() }))).toEqual(["date"])
  expect(
    unsafeNodes(z.discriminatedUnion("k", [z.object({ k: z.literal("x"), s: z.set(z.string()) })])),
  ).toEqual(["set"])
  expect(unsafeNodes(z.record(z.string(), z.number().default(1)))).toEqual(["default"])
  expect(unsafeNodes(z.tuple([z.string()], z.custom<string>()))).toEqual(["custom"])
})

test("the package exports schemas to check", () => {
  expect(schemas.length).toBeGreaterThan(40)
})

for (const [name, schema] of schemas)
  test(`${name} is JSON-safe`, () => {
    expect({ [name]: unsafeNodes(schema) }).toEqual({ [name]: [] })
  })
