import { CLI_SURFACE, PROTOCOL_VERSION } from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, commandArgs, printResult, runCli } from "../client"

export const version = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "version", description: CLI_SURFACE.version.summary },
    args: commandArgs("version"),
    run: ({ rawArgs }) =>
      runCli(deps, "version", rawArgs, async ({ values }) => {
        printResult(
          deps,
          "version",
          { version: deps.version, protocolVersion: PROTOCOL_VERSION },
          values.json === true,
          () => `iter8 ${deps.version}\n`,
        )
      }),
  })
