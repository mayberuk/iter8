import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { hostname } from "node:os"
import { CLI_SURFACE, ServiceStatus } from "@iter8/protocol"
import { type CommandDef, defineCommand } from "citty"
import { TAILSCALE_MAC_APP } from "../../connect/route"
import { type ConnectSystem, runConnect } from "../../connect/run"
import { resolvePaths } from "../../home"
import { type CliDeps, caller, commandArgs, request, runCli } from "../client"

function liveSystem(deps: CliDeps): ConnectSystem {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("iter8 connect runs on macOS and Linux")
  }
  return {
    spawn: (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
    clock: { now: Date.now, setTimeout, clearTimeout },
    platform,
    laptopName: hostname().split(".")[0] ?? "",
    home: resolvePaths(process.env).home,
    forwardAddress: null,
    tailscale: () =>
      Bun.which("tailscale") ??
      (platform === "darwin" && existsSync(TAILSCALE_MAC_APP) ? TAILSCALE_MAC_APP : null),
    localPool: async () => {
      try {
        const client = await deps.connect({ start: false })
        if (client === null) return null
        const result = await (
          await request(() => client.status.$post({ json: caller(deps, {}) }))
        ).json()
        return ServiceStatus.parse(result).pool
      } catch {
        return null
      }
    },
    nonce: () => randomBytes(4).toString("hex"),
    out: (line) => deps.stdout(`${line}\n`),
    onInterrupt: (stop) => {
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    },
  }
}

export const connect = (deps: CliDeps, system?: ConnectSystem): CommandDef =>
  defineCommand({
    meta: { name: "connect", description: CLI_SURFACE.connect.summary },
    args: commandArgs("connect"),
    run: ({ rawArgs }) =>
      runCli(deps, "connect", rawArgs, ({ positionals }) =>
        runConnect(positionals[0] ?? "", system ?? liveSystem(deps)),
      ),
  })
