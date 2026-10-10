import { CLI_SURFACE, RoundsResult } from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, caller, commandArgs, connect, printResult, request, runCli } from "../client"

export const rounds = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "rounds", description: CLI_SURFACE.rounds.summary },
    args: commandArgs("rounds"),
    run: ({ rawArgs }) =>
      runCli(deps, "rounds", rawArgs, async ({ values }) => {
        const body = caller(deps, values)
        const client = await connect(deps)
        const result = await (await request(() => client.rounds.$post({ json: body }))).json()
        printResult(deps, "rounds", result, values.json === true, (data) => {
          const { rounds } = RoundsResult.parse(data)
          return rounds.length
            ? `${rounds.map((round) => `${round.id} ${round.pageId} ${round.stage}`).join("\n")}\n`
            : "No rounds\n"
        })
      }),
  })
