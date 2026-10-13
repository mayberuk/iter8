import { parseArgs } from "node:util"
import { CLI_SURFACE, type CliCommandSpec, ExitCode, OwnerId } from "@iter8/protocol"
import type { ArgsDef } from "citty"
import { hc } from "hono/client"
import { ZodError } from "zod"
import type { ProcessKey } from "../pairing/process-identity"
import type { ControlApp } from "../service/control-api"

export type ControlClient = ReturnType<typeof hc<ControlApp>>

export function controlClientFor(socketPath: string): ControlClient {
  return hc<ControlApp>("http://iter8", {
    // Bun's fetch drops a connection idle for 5 minutes, and hook wait sends nothing until it settles.
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, unix: socketPath, timeout: false }),
  })
}

export type CliDeps = {
  connect: (options: { start: boolean }) => Promise<ControlClient | null>
  stdout: (text: string) => void
  stderr: (text: string) => void
  exit: (code: number) => void
  cwd: string
  pid: number
  ancestry: () => ProcessKey[]
  processStart: (pid: number) => string | null
  makeTempDir: () => Promise<string>
  version: string
}

type SurfaceName = keyof typeof CLI_SURFACE

export function commandArgs(name: SurfaceName): ArgsDef {
  const spec: CliCommandSpec = CLI_SURFACE[name]
  const args: ArgsDef = { json: { type: "boolean" } }
  for (const positional of spec.positionals) {
    args[positional] = spec.positionalsOptional
      ? { type: "positional", required: false }
      : { type: "positional", required: true, default: "" }
  }
  for (const flag of spec.flags) {
    // citty validates before run, where the injected exit maps usage errors to the protocol code.
    args[flag.name] = {
      type: "string",
      required: flag.required,
      ...(flag.required ? { default: "" } : {}),
      valueHint: Array.isArray(flag.value) ? flag.value.join("|") : String(flag.value),
      description: flag.repeatable ? "Repeatable" : "",
    }
  }
  return args
}

function parseCommand(name: SurfaceName, rawArgs: string[]) {
  const spec: CliCommandSpec = CLI_SURFACE[name]
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
    json: { type: "boolean" },
  }
  for (const flag of spec.flags) options[flag.name] = { type: "string", multiple: flag.repeatable }
  const parsed = parseArgs({
    args: rawArgs,
    options,
    allowPositionals: true,
    strict: true,
    tokens: true,
  })
  const given = parsed.positionals.length
  if (
    given > spec.positionals.length ||
    (given < spec.positionals.length && !spec.positionalsOptional)
  ) {
    throw new Error(`Expected ${spec.positionals.join(" ") || "no positional arguments"}`)
  }
  const seen = new Set<string>()
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue
    if (seen.has(token.name) && !options[token.name]?.multiple) {
      throw new Error(`--${token.name} may only be given once`)
    }
    seen.add(token.name)
  }
  for (const flag of spec.flags) {
    const value = parsed.values[flag.name]
    if (flag.required && (value === undefined || value === "")) {
      throw new Error(`Missing required flag --${flag.name}`)
    }
    if (value === undefined) continue
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry !== "string" || !entry.length) throw new Error(`Invalid --${flag.name}`)
      if (
        flag.value === "integer" &&
        (!/^\d+$/.test(entry) || !Number.isSafeInteger(Number(entry)))
      ) {
        throw new Error(`--${flag.name} requires an integer`)
      }
      if (Array.isArray(flag.value) && !(flag.value as readonly string[]).includes(entry)) {
        throw new Error(`--${flag.name} must be ${flag.value.join("|")}`)
      }
    }
  }
  return parsed
}

export async function runCli(
  deps: CliDeps,
  name: SurfaceName,
  rawArgs: string[],
  run: (args: ReturnType<typeof parseCommand>) => Promise<number | void>,
): Promise<void> {
  let args: ReturnType<typeof parseCommand>
  try {
    args = parseCommand(name, rawArgs)
  } catch (error) {
    deps.stderr(`${diagnostic(error)}\n`)
    deps.exit(ExitCode.usage)
    return
  }
  try {
    const code = await run(args)
    deps.exit(code ?? ExitCode.ok)
  } catch (error) {
    deps.stderr(`${diagnostic(error)}\n`)
    deps.exit(
      error instanceof ZodError
        ? ExitCode.usage
        : error instanceof Error && typeof error.cause === "number"
          ? error.cause
          : ExitCode.failure,
    )
  }
}

function diagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim()
}

export function textFlag(
  values: ReturnType<typeof parseCommand>["values"],
  name: string,
): string | undefined {
  const value = values[name]
  return typeof value === "string" ? value : undefined
}

export function repeatedFlag(
  values: ReturnType<typeof parseCommand>["values"],
  name: string,
): string[] {
  const value = values[name]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : []
}

export function caller(deps: CliDeps, values: ReturnType<typeof parseCommand>["values"]) {
  const owner = textFlag(values, "owner")
  return { identities: deps.ancestry(), owner: owner === undefined ? null : OwnerId.parse(owner) }
}

export async function connect(deps: CliDeps, start = true): Promise<ControlClient> {
  try {
    const client = await deps.connect({ start })
    if (client) return client
    throw new Error("Service unavailable")
  } catch (error) {
    throw new Error(`Cannot reach iter8 service: ${diagnostic(error)}`, {
      cause: ExitCode.serviceUnavailable,
    })
  }
}

export async function request<
  T extends { ok: boolean; status: number; text: () => Promise<string> },
>(send: () => Promise<T>): Promise<Extract<T, { ok: true }>> {
  let response: T
  try {
    response = await send()
  } catch (error) {
    throw new Error(`Lost iter8 control connection: ${diagnostic(error)}`, {
      cause: ExitCode.serviceUnavailable,
    })
  }
  if (!response.ok) {
    const code =
      response.status === 404
        ? ExitCode.notFound
        : response.status === 409
          ? ExitCode.refused
          : response.status === 400
            ? ExitCode.usage
            : ExitCode.failure
    throw new Error(await response.text(), { cause: code })
  }
  return response as Extract<T, { ok: true }>
}

export function printResult(
  deps: CliDeps,
  name: SurfaceName,
  result: unknown,
  json: boolean,
  text: (result: unknown) => string,
): void {
  const schema = CLI_SURFACE[name].output
  if (!schema) return
  const parsed = schema.safeParse(result)
  if (!parsed.success) throw new Error(`Invalid ${name} response: ${parsed.error.message}`)
  deps.stdout(json ? `${JSON.stringify(parsed.data)}\n` : text(parsed.data))
}
