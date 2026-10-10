import { join } from "node:path"
import { ENV } from "@iter8/protocol"
import type { z } from "zod"

const REPO = join(import.meta.dir, "..", "..")

export type CliEnv = {
  /** The argv prefix that runs the CLI; {@link cliCommand} when absent. */
  command?: string[]
  home: string
  pool: string
  overlayDir?: string
  /** Extra variables, such as the ones that steer the fake CLI. */
  vars?: Record<string, string>
}

export type CliRun = {
  exitCode: number
  stdout: string
  stderr: string
  json<S extends z.ZodType>(schema: S): z.output<S>
}

export function cliCommand(binary?: string): string[] {
  if (binary !== undefined) return [binary]
  const testBinary = process.env.ITER8_TEST_BINARY
  if (testBinary !== undefined && testBinary !== "") return [testBinary]
  return [process.execPath, join(REPO, "apps", "iter8", "src", "main.ts")]
}

/**
 * The environment a CLI child runs in. Inherited `ITER8_*` and the developer's own
 * `CLAUDE_CODE_SESSION_ID` are dropped so a run never reaches the real state dir or session.
 */
export function childEnv(env: CliEnv): Record<string, string> {
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      !entry[0].startsWith("ITER8_") &&
      entry[0] !== "CLAUDE_CODE_SESSION_ID",
  )
  return {
    ...Object.fromEntries(inherited),
    [ENV.home]: env.home,
    [ENV.pool]: env.pool,
    ...(env.overlayDir === undefined ? {} : { [ENV.overlayDir]: env.overlayDir }),
    ...env.vars,
  }
}

export function cliRun(exitCode: number, stdout: string, stderr: string): CliRun {
  return {
    exitCode,
    stdout,
    stderr,
    json(schema) {
      let value: unknown
      try {
        value = JSON.parse(stdout)
      } catch {
        throw new Error(`CLI stdout is not JSON (exit ${exitCode}): ${stdout}\nstderr: ${stderr}`)
      }
      const parsed = schema.safeParse(value)
      if (!parsed.success) {
        throw new Error(
          `CLI stdout does not match the schema (exit ${exitCode}): ${parsed.error.message}\nstdout: ${stdout}`,
        )
      }
      return parsed.data
    },
  }
}

export async function runCli(
  env: CliEnv,
  args: string[],
  options: { cwd?: string } = {},
): Promise<CliRun> {
  const child = Bun.spawn([...(env.command ?? cliCommand()), ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: childEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return cliRun(exitCode, stdout, stderr)
}
