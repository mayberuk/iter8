import { AgentNoteResult, CLI_SURFACE, Intent, PageId } from "@iter8/protocol"
import { defineCommand } from "citty"
import {
  type CliDeps,
  caller,
  commandArgs,
  connect,
  printResult,
  repeatedFlag,
  request,
  runCli,
  textFlag,
} from "../client"

export const note = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "note", description: CLI_SURFACE.note.summary },
    args: commandArgs("note"),
    run: ({ rawArgs }) =>
      runCli(deps, "note", rawArgs, async ({ values, positionals }) => {
        const body = {
          ...caller(deps, values),
          page: PageId.parse(positionals[0]),
          intent: Intent.parse(textFlag(values, "intent")),
          body: textFlag(values, "body") ?? "",
          at: repeatedFlag(values, "at"),
          ...Object.fromEntries(
            ["role", "name", "text"].flatMap((key) => {
              const value = textFlag(values, key)
              return value === undefined ? [] : [[key, value]]
            }),
          ),
        }
        const client = await connect(deps)
        const result = await (await request(() => client.note.$post({ json: body }))).json()
        printResult(deps, "note", result, values.json === true, (data) => {
          const pinned = AgentNoteResult.parse(data)
          return `${pinned.note.id} ${pinned.anchorStatus}\n`
        })
      }),
  })
