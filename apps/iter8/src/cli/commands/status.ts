import { CLI_SURFACE, ServiceStatus } from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, caller, commandArgs, connect, printResult, request, runCli } from "../client"

export const status = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "status", description: CLI_SURFACE.status.summary },
    args: commandArgs("status"),
    run: ({ rawArgs }) =>
      runCli(deps, "status", rawArgs, async ({ values }) => {
        const body = caller(deps, values)
        const client = await connect(deps, false)
        const result = await (await request(() => client.status.$post({ json: body }))).json()
        printResult(deps, "status", result, values.json === true, (data) => {
          const report = ServiceStatus.parse(data)
          return `iter8 ${report.version} ${report.state}\nPool: ${report.pool.join(", ")}\nOwner: ${report.owner?.process.label ?? "none"}\n`
        })
      }),
  })
