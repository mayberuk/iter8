import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { CLI_SURFACE, ServiceStatus } from "@iter8/protocol"
import { type CommandDef, defineCommand } from "citty"
import { TAILSCALE_MAC_APP } from "../../connect/route"
import { type ConnectSystem, runConnect } from "../../connect/run"
import { resolvePaths } from "../../home"
import {
  dataDir,
  type InstallDeps,
  installRelease,
  newestInstalled,
  type Platform,
  pointCurrent,
} from "../../install/releases"
import { BUILD, VERSION } from "../../service/lifecycle"
import { type CliDeps, caller, commandArgs, request, runCli } from "../client"

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const

function releasePlatform(platform: "darwin" | "linux"): Platform {
  return platform === "darwin" ? "darwin-arm64" : "linux-x64"
}

export function liveSystem(
  deps: CliDeps,
  boundaries: {
    fetch: InstallDeps["fetch"]
    spawn: typeof Bun.spawn
    env: Record<string, string | undefined>
    home: string
    execPath: string
  },
): ConnectSystem {
  const { fetch, spawn, env, home, execPath } = boundaries
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("iter8 connect runs on macOS and Linux")
  }
  const data = dataDir(env, home)
  return {
    spawn: (argv) => spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
    clock: { now: Date.now, setTimeout, clearTimeout },
    platform,
    laptopName: hostname().split(".")[0] ?? "",
    home: resolvePaths(env).home,
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
    // A terminal's Ctrl-C reaches a restarted connect twice, from the terminal and from the
    // parent forwarding it; a once-listener would leave the second to kill it mid-cleanup.
    onInterrupt: (stop) => {
      for (const signal of FORWARDED_SIGNALS) process.on(signal, stop)
    },
    self: { version: VERSION, build: BUILD, execPath },
    releases: {
      newest: () => newestInstalled(data),
      install: async (version) => {
        const installed = await installRelease(data, version, {
          fetch,
          spawn,
          platform: releasePlatform(platform),
          pid: process.pid,
          sleep: Bun.sleep,
        })
        return (await pointCurrent(data)) ?? installed
      },
    },
    restart: async (binary, argv) => {
      const child = spawn([binary, ...argv], { stdio: ["inherit", "inherit", "inherit"] })
      const forward = (signal: NodeJS.Signals) => child.kill(signal)
      for (const signal of FORWARDED_SIGNALS) process.on(signal, forward)
      try {
        return await child.exited
      } finally {
        for (const signal of FORWARDED_SIGNALS) process.off(signal, forward)
      }
    },
  }
}

export const connect = (deps: CliDeps, system?: ConnectSystem): CommandDef =>
  defineCommand({
    meta: { name: "connect", description: CLI_SURFACE.connect.summary },
    args: commandArgs("connect"),
    run: ({ rawArgs }) =>
      runCli(deps, "connect", rawArgs, ({ positionals }) =>
        runConnect(
          positionals[0] ?? "",
          system ??
            liveSystem(deps, {
              fetch,
              spawn: Bun.spawn,
              env: process.env,
              home: homedir(),
              execPath: process.execPath,
            }),
        ),
      ),
  })
