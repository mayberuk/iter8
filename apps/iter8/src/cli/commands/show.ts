import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CLI_SURFACE, type NoteId, RoundId, ShowResult } from "@iter8/protocol"
import { defineCommand } from "citty"
import { type CliDeps, caller, commandArgs, connect, printResult, request, runCli } from "../client"
import { renderShow } from "../render-show"

export const show = (deps: CliDeps) =>
  defineCommand({
    meta: { name: "show", description: CLI_SURFACE.show.summary },
    args: commandArgs("show"),
    run: ({ rawArgs }) =>
      runCli(deps, "show", rawArgs, async ({ values, positionals }) => {
        const body = { ...caller(deps, values), round: RoundId.parse(positionals[0]) }
        const client = await connect(deps)
        const response = await request(() => client.show.$post({ json: body }))
        const parsed = CLI_SURFACE.show.output.safeParse(await response.json())
        if (!parsed.success) throw new Error(`Invalid show response: ${parsed.error.message}`)
        const result = parsed.data
        const paths = new Map<NoteId, string>()
        const directory = await deps.makeTempDir()
        for (const { authored, untrustedCapture } of result.notes) {
          const screenshot = untrustedCapture?.screenshot
          if (!screenshot) continue
          const png = await request(() =>
            client.screenshots[":ref"].$get({ param: { ref: screenshot.ref } }),
          )
          const path = join(directory, `${authored.id}.png`)
          await writeFile(path, new Uint8Array(await png.arrayBuffer()))
          paths.set(authored.id, path)
        }
        printResult(deps, "show", result, values.json === true, (data) =>
          renderShow(ShowResult.parse(data), paths),
        )
      }),
  })
