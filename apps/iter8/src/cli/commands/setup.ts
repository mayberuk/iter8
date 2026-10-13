import { randomBytes } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { CLI_SURFACE } from "@iter8/protocol"
import { type CommandDef, defineCommand } from "citty"
import { assertHost } from "../../connect/ssh"
import { resolvePaths } from "../../home"
import { compareVersions, dataDir, isReleaseVersion, pointCurrent } from "../../install/releases"
import { BUILD, VERSION } from "../../service/lifecycle"
import { type CliDeps, commandArgs, runCli } from "../client"

type Child = {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

export type SetupSystem = {
  home: string
  env: Record<string, string | undefined>
  platform: "linux" | "darwin"
  uid: number
  execPath: string
  build: "compiled" | "source"
  version: string
  spawn: (argv: string[]) => Child
}

const LAUNCHER_MARK = "# iter8 setup"
const UNIT_NAME = "iter8-connect.service"
const AGENT_LABEL = "dev.iter8.connect"
const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}

function liveSystem(): SetupSystem {
  const platform = process.platform
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("iter8 setup runs on macOS and Linux")
  }
  return {
    home: homedir(),
    env: process.env,
    platform,
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    build: BUILD,
    version: VERSION,
    spawn: (argv) => Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
  }
}

async function execute(
  system: SetupSystem,
  argv: string[],
): Promise<{ code: number; stderr: string }> {
  let child: Child
  try {
    child = system.spawn(argv)
  } catch (error) {
    throw new Error(
      `Could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
    new Response(child.stdout).text(),
  ])
  return { code, stderr }
}

async function succeed(system: SetupSystem, argv: string[]): Promise<void> {
  const { code, stderr } = await execute(system, argv)
  if (code !== 0) {
    throw new Error(stderr.trim() || `${argv.join(" ")} exited with code ${code}`)
  }
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined
}

async function writeAtomically(path: string, content: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const staging = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}`)
  try {
    await writeFile(staging, content)
    await chmod(staging, mode)
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

async function installBinary(system: SetupSystem, data: string): Promise<void> {
  const target = join(data, "releases", `v${system.version}`, "iter8")
  if (!(await isExecutableFile(target))) {
    await mkdir(dirname(target), { recursive: true })
    const staging = join(dirname(target), `.iter8.${randomBytes(4).toString("hex")}`)
    try {
      await copyFile(system.execPath, staging)
      await chmod(staging, 0o755)
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { force: true })
      throw error
    }
  }
}

function shellQuoted(text: string): string {
  return text.replace(/[\\"$`]/g, "\\$&")
}

async function writeLauncher(path: string, data: string): Promise<void> {
  let existing: string | null = null
  try {
    existing = (await lstat(path)).isFile() ? await readFile(path, "utf8") : ""
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
  if (existing !== null && !existing.split("\n").includes(LAUNCHER_MARK)) {
    throw new Error(
      `${path} exists and was not written by iter8 setup; move it aside, then run setup again.`,
    )
  }
  await writeAtomically(
    path,
    `#!/bin/sh\n${LAUNCHER_MARK}\nexec "${shellQuoted(join(data, "current"))}" "$@"\n`,
    0o755,
  )
}

// systemd expands % specifiers in every value; only the safe set is left unquoted.
function unitWord(text: string): string {
  const escaped = text.replaceAll("%", "%%")
  if (/^[\w.@:%/+=,-]+$/.test(escaped)) return escaped
  return `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function agentEnvironment(system: SetupSystem): [string, string][] {
  return [
    ["PATH", system.env.PATH],
    ["SSH_AUTH_SOCK", system.env.SSH_AUTH_SOCK],
  ].flatMap(([name, value]) => (name && value ? [[name, value] as [string, string]] : []))
}

async function enableUnit(system: SetupSystem, host: string): Promise<void> {
  const unit = join(system.home, ".config", "systemd", "user", UNIT_NAME)
  const content = [
    "[Unit]",
    `Description=iter8 connect ${host.replaceAll("%", "%%")}`,
    "",
    "[Service]",
    `ExecStart=%h/.local/bin/iter8 connect ${unitWord(host.replaceAll("$", "$$$$"))}`,
    "Restart=always",
    "RestartSec=5",
    ...agentEnvironment(system).map(
      ([name, value]) => `Environment=${unitWord(`${name}=${value}`)}`,
    ),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
  await writeAtomically(unit, content, 0o644)
  await succeed(system, ["systemctl", "--user", "daemon-reload"])
  await succeed(system, ["systemctl", "--user", "enable", UNIT_NAME])
  await succeed(system, ["systemctl", "--user", "restart", UNIT_NAME])
}

const xml = (text: string) => text.replace(/[&<>"']/g, (char) => XML_ENTITIES[char] ?? char)

async function bootstrapAgent(system: SetupSystem, host: string): Promise<void> {
  const logs = resolvePaths(system.env).home
  await mkdir(logs, { recursive: true, mode: 0o700 })
  const plist = join(system.home, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`)
  const log = join(logs, "connect.log")
  const content = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${AGENT_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...[join(system.home, ".local", "bin", "iter8"), "connect", host].map(
      (argument) => `    <string>${xml(argument)}</string>`,
    ),
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...agentEnvironment(system).flatMap(([name, value]) => [
      `    <key>${xml(name)}</key>`,
      `    <string>${xml(value)}</string>`,
    ]),
    `  </dict>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n")
  await writeAtomically(plist, content, 0o644)
  const domain = `gui/${system.uid}`
  await execute(system, ["launchctl", "bootout", `${domain}/${AGENT_LABEL}`]).catch(() => {})
  await succeed(system, ["launchctl", "bootstrap", domain, plist])
}

async function keepConnected(deps: CliDeps, system: SetupSystem, host: string): Promise<void> {
  // An unattended unit would otherwise restart every 5 s forever on an auth refusal.
  const probe = await execute(system, [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "--",
    host,
    "true",
  ])
  if (probe.code !== 0) {
    throw new Error(
      `SSH to ${host} needs a password or a host-key confirmation. Run ssh ${host} once, then retry setup.`,
    )
  }
  if (system.platform === "linux") await enableUnit(system, host)
  else await bootstrapAgent(system, host)
  deps.stdout(`iter8 connect ${host} now runs at login.\n`)
}

async function runSetup(deps: CliDeps, system: SetupSystem, host: string | null): Promise<void> {
  if (system.build === "source") {
    throw new Error("Run setup from an installed iter8; this is a source build.")
  }
  const data = dataDir(system.env, system.home)
  await installBinary(system, data)
  const current = await pointCurrent(data)
  if (current === null) throw new Error(`No iter8 release is installed under ${data}`)
  const launcher = join(system.home, ".local", "bin", "iter8")
  await writeLauncher(launcher, data)
  deps.stdout(`Installed iter8 ${system.version} at ~/.local/bin/iter8.\n`)

  const binDir = dirname(launcher)
  const onPath = (system.env.PATH ?? "")
    .split(":")
    .some((entry) => entry.replace(/\/+$/, "") === binDir)
  if (!onPath) deps.stdout("~/.local/bin is not on your PATH; add it in your shell profile.\n")

  const pinned = system.env.ITER8_PINNED_VERSION
  const installed = basename(dirname(current)).slice(1)
  if (pinned && isReleaseVersion(pinned) && compareVersions(installed, pinned) > 0) {
    deps.stdout(
      `Claude Code's iter8 plugin pins an older release; update the plugin so both use iter8 ${installed}.\n`,
    )
  }

  if (host !== null) await keepConnected(deps, system, host)
}

function givesHost(args: string[]): boolean {
  const { positionals } = parseArgs({
    args,
    options: { json: { type: "boolean" } },
    allowPositionals: true,
    strict: false,
  })
  return positionals.length > 0
}

export const setup = (deps: CliDeps, system?: SetupSystem): CommandDef =>
  defineCommand({
    meta: { name: "setup", description: CLI_SURFACE.setup.summary },
    args: commandArgs("setup"),
    run: ({ rawArgs }) => {
      const given = givesHost(rawArgs)
      return runCli(deps, "setup", given ? rawArgs : [...rawArgs, ""], ({ positionals }) =>
        runSetup(deps, system ?? liveSystem(), given ? assertHost(positionals[0] ?? "") : null),
      )
    },
  })
