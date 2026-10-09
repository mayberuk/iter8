import { expect, test } from "bun:test"
import { CLI_SURFACE, CliCommand, HookCommand } from "./cli"

const entries = Object.entries(CLI_SURFACE)

test("the surface has one entry per command and one per hook subcommand", () => {
  const expected = [
    ...CliCommand.options.filter((command) => command !== "hook"),
    ...HookCommand.options.map((sub) => `hook ${sub}`),
  ]
  expect(Object.keys(CLI_SURFACE).sort()).toEqual(expected.sort())
})

test("every flag name is kebab-case", () => {
  for (const [, spec] of entries)
    for (const flag of spec.flags) expect(flag.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
})

test("no command requires --owner, so an agent's own ancestry can resolve it", () => {
  const ownerFlags = entries.flatMap(([, spec]) =>
    spec.flags.filter((flag) => flag.name === "owner"),
  )
  expect(ownerFlags.length).toBeGreaterThan(0)
  for (const flag of ownerFlags) expect(flag.required).toBe(false)
})
