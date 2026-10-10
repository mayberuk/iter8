import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLI_NAME, CLI_SURFACE, ExitCode } from "@iter8/protocol"
import { defineCommand, runCommand } from "citty"
import { type CliDeps, commandArgs, runCli } from "./cli/client"
import { cliCommands } from "./cli/commands"
import { ensureService } from "./cli/ensure"
import { resolvePaths } from "./home"
import { processAncestry, readProcessStart } from "./pairing/process-identity"
import { runService, VERSION } from "./service/lifecycle"

const argv = process.argv.slice(2)

if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write(`${CLI_NAME} ${VERSION}\n`)
} else {
  const paths = resolvePaths(process.env)
  const command = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, Bun.main]
  const deps: CliDeps = {
    connect: (options) =>
      ensureService(paths, { spawn: Bun.spawn, env: process.env, command }, options),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    exit: (code) => {
      process.exitCode = code
    },
    cwd: process.cwd(),
    pid: process.pid,
    ancestry: () => processAncestry(process.pid),
    processStart: readProcessStart,
    makeTempDir: () => mkdtemp(join(tmpdir(), `${CLI_NAME}-show-`)),
    version: VERSION,
  }
  const serve = defineCommand({
    meta: { name: "serve", description: CLI_SURFACE.serve.summary },
    args: commandArgs("serve"),
    run: ({ rawArgs }) =>
      runCli(deps, "serve", rawArgs, () =>
        runService({
          env: process.env,
          // The path the release build embeds the overlay bundles under.
          embeddedOverlayDir: join(import.meta.dir, "overlay"),
          idleMs: 600_000,
          exit: (code) => process.exit(code),
        }),
      ),
  })
  const root = defineCommand({
    meta: { name: CLI_NAME, version: VERSION },
    subCommands: { ...cliCommands(deps), serve },
  })
  try {
    await runCommand(root, { rawArgs: argv })
  } catch (error) {
    const message = Bun.stripANSI(error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim()
    process.stderr.write(`${message}\n`)
    process.exitCode =
      error instanceof Error && error.name === "CLIError" ? ExitCode.usage : ExitCode.failure
  }
}
