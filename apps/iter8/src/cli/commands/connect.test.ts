import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pkg from "../../../../../package.json"
import type { CliDeps } from "../client"
import { liveSystem } from "./connect"

const RELEASE = "9.0.0"
const OLDER = "8.0.0"
const HOST = "devbox"
const ASSET = `iter8-${process.platform === "darwin" ? "darwin-arm64" : "linux-x64"}`
const SIGNAL_EXIT = { SIGINT: 30, SIGTERM: 31, SIGHUP: 32 } as const

const teardowns: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown()
})

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

async function until(condition: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after 5000 ms waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const deps: CliDeps = {
  connect: async () => null,
  stdout: () => {},
  stderr: () => {},
  exit: () => {},
  cwd: "/",
  pid: process.pid,
  ancestry: () => [],
  processStart: () => null,
  readStdin: async () => "",
  makeTempDir: () => mkdtemp(join(tmpdir(), "i8-connect-cli-")),
  version: pkg.version,
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "i8-connect-cli-"))
  teardowns.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const data = join(home, ".local", "share", "iter8-claude-plugin")
  const published = join(root, "published")
  const marks = join(root, "marks")
  await mkdir(published)
  await mkdir(marks)

  const binary = [
    "#!/bin/sh",
    `if [ "$1" = --version ]; then printf 'iter8 ${RELEASE}\\n'; exit 0; fi`,
    `printf '%s\\n' "$@" > '${marks}/argv'`,
    ...Object.entries(SIGNAL_EXIT).map(
      ([signal, code]) =>
        `trap 'kill $sleeper; printf ${signal} > "${marks}/signal"; exit ${code}' ${signal.slice(3)}`,
    ),
    `touch '${marks}/ready'`,
    "sleep 30 &",
    "sleeper=$!",
    'wait "$sleeper"',
    "exit 3",
    "",
  ].join("\n")
  await writeFile(join(published, ASSET), binary)
  await writeFile(
    join(published, "SHA256SUMS"),
    `${createHash("sha256").update(binary).digest("hex")}  ${ASSET}\n`,
  )

  const gh = join(root, "gh")
  await writeExecutable(
    gh,
    [
      "#!/bin/sh",
      "dir=",
      'while [ $# -gt 0 ]; do if [ "$1" = --dir ]; then dir=$2; fi; shift; done',
      `cp '${published}'/* "$dir"/`,
      "",
    ].join("\n"),
  )

  const spawned: { argv: string[]; options: unknown }[] = []
  const spawn = ((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    spawned.push({ argv, options })
    return Bun.spawn(argv[0] === "gh" ? [gh, ...argv.slice(1)] : argv, options)
  }) as typeof Bun.spawn

  const execPath = join(root, "running", "iter8")
  const system = liveSystem(deps, {
    spawn,
    env: { ITER8_HOME: join(root, "iter8-home") },
    home,
    execPath,
  })
  return { root, data, marks, spawned, system, execPath }
}

test("self is this build's version and the injected executable path", async () => {
  const rig = await setup()
  expect(rig.system.self).toEqual({ version: pkg.version, build: "source", execPath: rig.execPath })
  expect(rig.system.home).toBe(join(rig.root, "iter8-home"))
})

test("install downloads through gh into the data dir and leaves current on the new release", async () => {
  const rig = await setup()
  const older = join(rig.data, "releases", `v${OLDER}`, "iter8")
  await mkdir(join(rig.data, "releases", `v${OLDER}`), { recursive: true })
  await writeExecutable(older, "older")
  await symlink(older, join(rig.data, "current"))

  const installed = join(rig.data, "releases", `v${RELEASE}`, "iter8")
  expect(await rig.system.releases?.install(RELEASE)).toBe(installed)
  expect(await readlink(join(rig.data, "current"))).toBe(installed)
  expect(await rig.system.releases?.newest()).toEqual({ version: RELEASE, path: installed })

  const download = rig.spawned[0]?.argv ?? []
  expect(download.slice(0, -1)).toEqual([
    "gh",
    "release",
    "download",
    `v${RELEASE}`,
    "--repo",
    "mayberuk/iter8",
    "--pattern",
    ASSET,
    "--pattern",
    "SHA256SUMS",
    "--dir",
  ])
})

test("install refuses a version outside the plugin's format and creates nothing", async () => {
  const rig = await setup()
  await expect(rig.system.releases?.install("../x")).rejects.toThrow("is not a release version")
  expect(rig.spawned).toEqual([])
  expect(await Bun.file(join(rig.root, "home")).exists()).toBe(false)
})

test("restart runs the binary as connect <host> on this terminal and resolves its exit code", async () => {
  const rig = await setup()
  const installed = (await rig.system.releases?.install(RELEASE)) ?? ""
  const restarting = rig.system.restart?.(installed, ["connect", HOST])
  await until(() => Bun.file(join(rig.marks, "ready")).exists(), "the restarted binary")

  const restart = rig.spawned.at(-1)
  expect(restart?.argv).toEqual([installed, "connect", HOST])
  expect(restart?.options).toEqual({ stdio: ["inherit", "inherit", "inherit"] })
  expect(await readFile(join(rig.marks, "argv"), "utf8")).toBe(`connect\n${HOST}\n`)

  process.emit("SIGTERM", "SIGTERM")
  expect(await restarting).toBe(SIGNAL_EXIT.SIGTERM)
})

test.each(Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[])(
  "%s sent to this process reaches the restarted connect, whose exit code is returned",
  async (signal) => {
    const rig = await setup()
    const installed = (await rig.system.releases?.install(RELEASE)) ?? ""
    const listeners = process.listenerCount(signal)
    const restarting = rig.system.restart?.(installed, ["connect", HOST])
    await until(() => Bun.file(join(rig.marks, "ready")).exists(), "the restarted binary")

    process.emit(signal, signal)
    expect(await restarting).toBe(SIGNAL_EXIT[signal])
    expect(await readFile(join(rig.marks, "signal"), "utf8")).toBe(signal)
    expect(process.listenerCount(signal)).toBe(listeners)
  },
)

test("every interrupt signal stops connect, and a repeated one does not fall through to the default", async () => {
  const rig = await setup()
  const before = Object.fromEntries(
    Object.keys(SIGNAL_EXIT).map((signal) => [signal, process.listeners(signal as NodeJS.Signals)]),
  )
  let stops = 0
  rig.system.onInterrupt(() => {
    stops++
  })
  for (const signal of Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]) {
    const added = process
      .listeners(signal)
      .filter((listener) => !before[signal]?.includes(listener))
    teardowns.push(async () => {
      for (const listener of added) process.off(signal, listener)
    })
    expect(added).toHaveLength(1)
    process.emit(signal, signal)
    process.emit(signal, signal)
    expect(process.listeners(signal).filter((listener) => added.includes(listener))).toEqual(added)
  }
  expect(stops).toBe(6)
})
