import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CLI_NAME,
  CLI_SURFACE,
  CliCommand,
  type CliCommandSpec,
  ENV,
  ExitCode,
  HookCommand,
} from "@iter8/protocol"
import { helpArgs, renderHelp } from "./help"

const MAIN = resolve(import.meta.dir, "../../main.ts")
const surface: [string, CliCommandSpec][] = Object.entries(CLI_SURFACE)

describe("helpArgs", () => {
  test.each([
    [[], ["help"]],
    [["--help"], ["help"]],
    [["-h"], ["help"]],
    [
      ["run", "--help"],
      ["help", "run"],
    ],
    [
      ["note", "PAGE", "--body", "x", "-h"],
      ["help", "note"],
    ],
    [
      ["hook", "start", "--pid", "1", "--help"],
      ["help", "hook", "start"],
    ],
    [
      ["hook", "--help"],
      ["help", "hook"],
    ],
    [["hook"], ["help", "hook"]],
    [
      ["bogus", "--help"],
      ["help", "bogus"],
    ],
  ])("%j asks for help on %j", (argv, expected) => {
    expect(helpArgs(argv)).toEqual(expected)
  })

  test.each([
    [["status"]],
    [["hook", "start", "--pid", "1"]],
    [["help", "run"]],
    [["run", "--", "vite", "--help"]],
    [["run", "--", "-h"]],
    [["note", "PAGE", "--body=--help"]],
  ])("%j asks for no help", (argv) => {
    expect(helpArgs(argv)).toBeNull()
  })
})

describe("renderHelp", () => {
  test("the overview names the version and lists every command once, with its summary", () => {
    const text = renderHelp([], "9.8.7")
    expect(text).toStartWith(`${CLI_NAME} 9.8.7\n`)
    for (const name of CliCommand.options) {
      const rows = text.split("\n").filter((line) => line.trimStart().startsWith(`${name} `))
      expect({ name, rows: rows.length }).toEqual({ name, rows: 1 })
      if (name !== "hook") expect(rows[0]).toContain(CLI_SURFACE[name].summary)
    }
  })

  test("hook lists every hook subcommand with its summary", () => {
    const text = renderHelp(["hook"], "1.0.0")
    expect(text).toStartWith(`Usage: ${CLI_NAME} hook <subcommand>`)
    for (const sub of HookCommand.options) {
      expect(text).toContain(`  ${sub}`)
      expect(text).toContain(CLI_SURFACE[`hook ${sub}`].summary)
    }
  })

  test.each(surface)("%s shows its usage, summary, flags, JSON output and owner", (name, spec) => {
    const text = renderHelp(name.split(" "), "1.0.0")
    const [usage = ""] = text.split("\n")
    expect(usage).toStartWith(`Usage: ${CLI_NAME} ${name}`)
    expect(text).toContain(`\n${spec.summary}\n`)
    for (const positional of spec.positionals) {
      expect(usage).toContain(spec.positionalsOptional ? `[${positional}]` : `<${positional}>`)
    }
    for (const flag of spec.flags) {
      const value = Array.isArray(flag.value) ? flag.value.join("|") : flag.value
      const term = `--${flag.name} <${value}>${flag.repeatable ? "..." : ""}`
      expect(usage).toContain(flag.required ? ` ${term}` : `[${term}]`)
      const row = text.split("\n").find((line) => line.trimStart().startsWith(term))
      expect(row).toBeDefined()
      expect(row?.includes("required")).toBe(flag.required)
      expect(row?.includes("repeatable")).toBe(flag.repeatable)
    }
    expect(usage.includes("[--json]")).toBe(spec.output !== null)
    expect(text.includes("print the result as JSON")).toBe(spec.output !== null)
    expect(text.includes(`Owner: ${spec.owner}`)).toBe(spec.owner !== "none")
    expect(usage.includes(`[-- ${spec.trailing}...]`)).toBe(spec.trailing !== undefined)
  })

  test("run shows its optional DIR and the dev command taken after --", () => {
    expect(renderHelp(["run"], "1.0.0")).toStartWith(
      `Usage: ${CLI_NAME} run [DIR] [--port <integer>] [--owner <text>] [-- COMMAND...]\n`,
    )
  })

  test.each([[["bogus"]], [["hook", "bogus"]], [["serve", "x"]], [["status", "hook"]]])(
    "%j is an unknown command and a usage error",
    (words) => {
      let thrown: unknown
      try {
        renderHelp(words, "1.0.0")
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect((thrown as Error).message).toBe(`Unknown command ${words.join(" ")}`)
      expect((thrown as Error).cause).toBe(ExitCode.usage)
    },
  )
})

describe("the iter8 executable", () => {
  const scratch: string[] = []
  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function iter8(args: string[]) {
    const root = await mkdtemp(join(tmpdir(), "iter8-help-"))
    scratch.push(root)
    const home = join(root, "home")
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("ITER8_")),
    )
    const child = Bun.spawn([process.execPath, MAIN, ...args], {
      cwd: root,
      env: { ...env, [ENV.home]: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr, touchedHome: existsSync(home) }
  }

  test.each([
    [[], `${CLI_NAME} `],
    [["--help"], `${CLI_NAME} `],
    [["help"], `${CLI_NAME} `],
    [["hook"], `Usage: ${CLI_NAME} hook <subcommand>`],
    [["status", "--help"], `Usage: ${CLI_NAME} status [--owner <text>] [--json]\n`],
    [["note", "-h"], `Usage: ${CLI_NAME} note <PAGE> --intent`],
    [["help", "hook", "wait"], `Usage: ${CLI_NAME} hook wait --pid <integer>`],
    [["hook", "start", "--pid", "1", "--help"], `Usage: ${CLI_NAME} hook start --pid <integer>`],
  ])(
    "%j prints help on stdout, exits 0 and never reaches the service",
    async (args, start) => {
      const run = await iter8(args)
      expect(run.stderr).toBe("")
      expect(run.exitCode).toBe(ExitCode.ok)
      expect(run.stdout).toStartWith(start)
      expect(run.touchedHome).toBe(false)
    },
    30_000,
  )

  test.each([
    [["help", "bogus"], "Unknown command bogus\n"],
    [["help", "run", "x", "y"], "Expected COMMAND SUBCOMMAND\n"],
  ])(
    "%j exits usage with the reason on stderr",
    async (args, reason) => {
      const run = await iter8(args)
      expect(run.exitCode).toBe(ExitCode.usage)
      expect(run.stdout).toBe("")
      expect(run.stderr).toBe(reason)
    },
    30_000,
  )
})
