import { CLI_SURFACE, DoneResult, NoteId } from "@iter8/protocol"
import { defineCommand } from "citty"
import {
  type CliDeps,
  caller,
  commandArgs,
  connect,
  printResult,
  request,
  runCli,
  textFlag,
} from "../client"

export const done = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "done", description: CLI_SURFACE.done.summary },
    args: commandArgs("done"),
    run: ({ rawArgs }) =>
      runCli(deps, "done", rawArgs, async ({ values, positionals }) => {
        const body = {
          ...caller(deps, values),
          note: NoteId.parse(positionals[0]),
          reply: textFlag(values, "reply") ?? null,
        }
        const client = await connect(deps)
        const result = await (await request(() => client.done.$post({ json: body }))).json()
        printResult(deps, "done", result, values.json === true, (data) => {
          const resolved = DoneResult.parse(data)
          return `${resolved.noteId} ${resolved.resolution.status}\n`
        })
      }),
  })
