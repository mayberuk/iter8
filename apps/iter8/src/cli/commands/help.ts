import {
  CLI_NAME,
  CLI_SURFACE,
  CliCommand,
  type CliCommandSpec,
  ExitCode,
  HookCommand,
} from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, commandArgs, runCli } from "../client"

const surface: Record<string, CliCommandSpec> = CLI_SURFACE
const HOOK_SUMMARY = "Entry points for Claude Code's hooks, run by the iter8 plugin"
const HELP_FLAGS = ["--help", "-h"]

type Flag = CliCommandSpec["flags"][number]

function columns(rows: [string, string][]): string[] {
  const width = Math.max(...rows.map(([left]) => left.length))
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd())
}

function flagTerm(flag: Flag): string {
  const value = Array.isArray(flag.value) ? flag.value.join("|") : flag.value
  return `--${flag.name} <${value}>${flag.repeatable ? "..." : ""}`
}

function rootHelp(version: string): string {
  const rows = CliCommand.options.map((name): [string, string] => [
    name,
    name === "hook" ? HOOK_SUMMARY : (surface[name]?.summary ?? ""),
  ])
  return [
    `${CLI_NAME} ${version}`,
    "Mark up a running web page and hand the notes to the Claude Code session that owns it.",
    "",
    `Usage: ${CLI_NAME} <command> [arguments] [flags]`,
    "",
    "Commands:",
    ...columns(rows),
    "",
    `Run ${CLI_NAME} help <command>, or ${CLI_NAME} <command> --help, for its arguments and flags.`,
  ].join("\n")
}

function hookHelp(): string {
  const rows = HookCommand.options.map((sub): [string, string] => [
    sub,
    surface[`hook ${sub}`]?.summary ?? "",
  ])
  return [
    `Usage: ${CLI_NAME} hook <subcommand> [flags]`,
    "",
    `${HOOK_SUMMARY}.`,
    "",
    "Subcommands:",
    ...columns(rows),
    "",
    `Run ${CLI_NAME} help hook <subcommand> for its flags.`,
  ].join("\n")
}

function commandHelp(name: string, spec: CliCommandSpec): string {
  const usage = [
    CLI_NAME,
    name,
    ...spec.positionals.map((positional) =>
      spec.positionalsOptional ? `[${positional}]` : `<${positional}>`,
    ),
    ...spec.flags.map((flag) => (flag.required ? flagTerm(flag) : `[${flagTerm(flag)}]`)),
    ...(spec.output === null ? [] : ["[--json]"]),
    ...(spec.trailing === undefined ? [] : [`[-- ${spec.trailing}...]`]),
  ]
  const flags = spec.flags.map((flag): [string, string] => [
    flagTerm(flag),
    [flag.required ? "required" : "", flag.repeatable ? "repeatable" : ""]
      .filter(Boolean)
      .join(", "),
  ])
  if (spec.output !== null) flags.push(["--json", "print the result as JSON"])
  return [
    `Usage: ${usage.join(" ")}`,
    "",
    spec.summary,
    ...(flags.length === 0 ? [] : ["", "Flags:", ...columns(flags)]),
    ...(spec.owner === "none" ? [] : ["", `Owner: ${spec.owner}`]),
  ].join("\n")
}

/** Throws a usage error for a command the surface does not have. */
export function renderHelp(words: readonly string[], version: string): string {
  const name = words.join(" ")
  const text =
    name === ""
      ? rootHelp(version)
      : name === "hook"
        ? hookHelp()
        : Object.hasOwn(surface, name)
          ? commandHelp(name, surface[name] as CliCommandSpec)
          : null
  if (text === null) throw new Error(`Unknown command ${name}`, { cause: ExitCode.usage })
  return `${text}\n`
}

/**
 * The `help` arguments that argv stands for: `--help` or `-h` before any `--`, a bare `iter8`, or a
 * bare `iter8 hook`. Null when argv asks for no help.
 */
export function helpArgs(argv: readonly string[]): string[] | null {
  if (argv.length === 0) return ["help"]
  const end = argv.indexOf("--")
  const head = end === -1 ? argv : argv.slice(0, end)
  const [first, second] = head
  const command = first?.startsWith("-") === false ? first : undefined
  const sub = command === "hook" && second?.startsWith("-") === false ? second : undefined
  const path = [command, sub].filter((word) => word !== undefined)
  if (head.some((arg) => HELP_FLAGS.includes(arg))) return ["help", ...path]
  if (command === "hook" && sub === undefined) return ["help", "hook"]
  return null
}

export const help = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "help", description: CLI_SURFACE.help.summary },
    args: commandArgs("help"),
    run: ({ rawArgs }) =>
      runCli(deps, "help", rawArgs, async ({ positionals }) => {
        deps.stdout(renderHelp(positionals, deps.version))
      }),
  })
