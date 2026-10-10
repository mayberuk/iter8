import {
  CLI_SURFACE,
  ExitCode,
  formatPointer,
  HookEndReason,
  HookSource,
  RoundPointer,
} from "@iter8/protocol"
import { type ArgsDef, defineCommand } from "citty"
import {
  type CliDeps,
  commandArgs,
  connect,
  printResult,
  request,
  runCli,
  textFlag,
} from "../client"

export const hook = (deps: CliDeps) => {
  const identity = (value: string | undefined) => {
    const pid = Number(value)
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("--pid requires a positive integer", { cause: ExitCode.usage })
    return { pid, startedAt: deps.processStart(pid) }
  }
  const pointers = (items: unknown[], channel: (text: string) => void) => {
    const lines = items.map((item) => {
      const parsed = RoundPointer.safeParse(item)
      if (!parsed.success) throw new Error(`Invalid round pointer: ${parsed.error.message}`)
      return `${formatPointer(parsed.data)}\n`
    })
    for (const line of lines) channel(line)
  }

  return defineCommand({
    meta: { name: "hook" },
    args: { json: { type: "boolean" } } as ArgsDef,
    subCommands: {
      start: defineCommand({
        meta: { name: "start", description: CLI_SURFACE["hook start"].summary },
        args: commandArgs("hook start"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook start", rawArgs, async ({ values }) => {
            const body = {
              ...identity(textFlag(values, "pid")),
              label: textFlag(values, "label") ?? "",
              source: HookSource.parse(textFlag(values, "source")),
              agent: textFlag(values, "agent") ?? "agent",
              cwd: deps.cwd,
            }
            const client = await connect(deps)
            const result = await (
              await request(() => client.hook.start.$post({ json: body }))
            ).json()
            if (values.json === true) printResult(deps, "hook start", result, true, () => "")
            else pointers(result.pointers, deps.stdout)
          }),
      }),
      prompt: defineCommand({
        meta: { name: "prompt", description: CLI_SURFACE["hook prompt"].summary },
        args: commandArgs("hook prompt"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook prompt", rawArgs, async ({ values }) => {
            const body = identity(textFlag(values, "pid"))
            const client = await connect(deps)
            const result = await (
              await request(() => client.hook.prompt.$post({ json: body }))
            ).json()
            pointers(result.pointers, deps.stdout)
          }),
      }),
      tool: defineCommand({
        meta: { name: "tool", description: CLI_SURFACE["hook tool"].summary },
        args: commandArgs("hook tool"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook tool", rawArgs, async ({ values }) => {
            const body = identity(textFlag(values, "pid"))
            const client = await connect(deps, false)
            const result = await (
              await request(() => client.hook.tool.$post({ json: body }))
            ).json()
            pointers(result.pointers, deps.stdout)
          }),
      }),
      stop: defineCommand({
        meta: { name: "stop", description: CLI_SURFACE["hook stop"].summary },
        args: commandArgs("hook stop"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook stop", rawArgs, async ({ values }) => {
            const body = identity(textFlag(values, "pid"))
            const client = await connect(deps)
            await request(() => client.hook.stop.$post({ json: body }))
          }),
      }),
      wait: defineCommand({
        meta: { name: "wait", description: CLI_SURFACE["hook wait"].summary },
        args: commandArgs("hook wait"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook wait", rawArgs, async ({ values }) => {
            const process = identity(textFlag(values, "pid"))
            const timeoutSeconds = textFlag(values, "timeout-seconds") ?? ""
            if (Number(timeoutSeconds) > 2_147_483)
              throw new Error("--timeout-seconds exceeds the supported timer duration", {
                cause: ExitCode.usage,
              })
            const query = {
              pid: String(process.pid),
              startedAt: process.startedAt ?? "",
              timeoutSeconds,
            }
            const client = await connect(deps)
            const response = await request(() => client.hook.wait.$get({ query }))
            let result: Awaited<ReturnType<typeof response.json>>
            try {
              result = await response.json()
            } catch {
              throw new Error("Lost iter8 control connection while waiting", {
                cause: ExitCode.serviceUnavailable,
              })
            }
            if (result.outcome === "woken") {
              pointers(result.pointers, deps.stderr)
              return ExitCode.wake
            }
            return ExitCode.ok
          }),
      }),
      end: defineCommand({
        meta: { name: "end", description: CLI_SURFACE["hook end"].summary },
        args: commandArgs("hook end"),
        run: ({ rawArgs }) =>
          runCli(deps, "hook end", rawArgs, async ({ values }) => {
            const body = {
              ...identity(textFlag(values, "pid")),
              label: textFlag(values, "label") ?? "",
              reason: HookEndReason.parse(textFlag(values, "reason")),
            }
            const client = await connect(deps)
            await request(() => client.hook.end.$post({ json: body }))
          }),
      }),
    },
  })
}
