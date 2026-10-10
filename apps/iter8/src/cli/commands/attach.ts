import { CLI_SURFACE, PageId, PairResult } from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, caller, commandArgs, connect, printResult, request, runCli } from "../client"

export const attach = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "attach", description: CLI_SURFACE.attach.summary },
    args: commandArgs("attach"),
    run: ({ rawArgs }) =>
      runCli(deps, "attach", rawArgs, async ({ values, positionals }) => {
        const body = { ...caller(deps, values), page: PageId.parse(positionals[0]) }
        const client = await connect(deps)
        const result = await (await request(() => client.attach.$post({ json: body }))).json()
        printResult(deps, "attach", result, values.json === true, (data) => {
          const { pairing } = PairResult.parse(data)
          return `Paired with ${pairing.process.label} (${pairing.agent})\n`
        })
      }),
  })
