import { afterEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ExitCode } from "@iter8/protocol"
import { runCommand } from "citty"
import type { CliDeps } from "../client"
import { type SetupSystem, setup } from "./setup"

const VERSION = "3.2.1"
const teardowns: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown()
})

type Reply = { code?: number; stderr?: string }

async function fixture(
  options: {
    platform?: "linux" | "darwin"
    build?: "compiled" | "source"
    env?: Record<string, string | undefined>
    reply?: (argv: string[]) => Reply
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "i8-setup-"))
  teardowns.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const stateDir = join(root, "state")
  await mkdir(home)
  const downloaded = join(root, "downloaded-iter8")
  await writeFile(downloaded, "#!/bin/sh\necho compiled\n")
  await chmod(downloaded, 0o755)

  const spawned: string[][] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const exits: number[] = []
  const deps: CliDeps = {
    connect: async () => null,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    exit: (code) => exits.push(code),
    cwd: root,
    pid: process.pid,
    ancestry: () => [],
    processStart: () => null,
    makeTempDir: () => mkdtemp(join(tmpdir(), "i8-setup-tmp-")),
    version: VERSION,
  }
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text))
        controller.close()
      },
    })
  const system: SetupSystem = {
    home,
    env: { PATH: `/usr/bin:${join(home, ".local", "bin")}`, ITER8_HOME: stateDir, ...options.env },
    platform: options.platform ?? "linux",
    uid: 501,
    execPath: downloaded,
    build: options.build ?? "compiled",
    version: VERSION,
    spawn: (argv) => {
      spawned.push(argv)
      const reply = options.reply?.(argv) ?? {}
      return {
        stdout: stream(""),
        stderr: stream(reply.stderr ?? ""),
        exited: Promise.resolve(reply.code ?? 0),
      }
    },
  }
  const run = (...rawArgs: string[]) => runCommand(setup(deps, system), { rawArgs })
  const data = join(home, ".local", "share", "iter8-claude-plugin")
  return {
    root,
    home,
    stateDir,
    downloaded,
    data,
    system,
    spawned,
    stdout,
    stderr,
    exits,
    run,
    binary: join(data, "releases", `v${VERSION}`, "iter8"),
    launcher: join(home, ".local", "bin", "iter8"),
    unit: join(home, ".config", "systemd", "user", "iter8-connect.service"),
    plist: join(home, "Library", "LaunchAgents", "dev.iter8.connect.plist"),
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

const LAUNCHER_PATHS = (data: string) => `#!/bin/sh\n# iter8 setup\nexec "${data}/current" "$@"\n`

describe("installing the command", () => {
  test("refuses a source build, with nothing written", async () => {
    const t = await fixture({ build: "source" })
    await t.run()
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr).toEqual(["Run setup from an installed iter8; this is a source build.\n"])
    expect(t.stdout).toEqual([])
    expect(await readdir(t.home)).toEqual([])
    expect(t.spawned).toEqual([])
  })

  test("copies the binary under releases, points current at it and writes the launcher", async () => {
    const t = await fixture()
    await t.run()
    expect(t.exits).toEqual([ExitCode.ok])
    expect(await readFile(t.binary, "utf8")).toBe("#!/bin/sh\necho compiled\n")
    expect((await stat(t.binary)).mode & 0o777).toBe(0o755)
    expect(await readlink(join(t.data, "current"))).toBe(t.binary)
    expect(await readFile(t.launcher, "utf8")).toBe(LAUNCHER_PATHS(t.data))
    expect((await stat(t.launcher)).mode & 0o777).toBe(0o755)
    expect(t.stdout).toEqual([`Installed iter8 ${VERSION} at ~/.local/bin/iter8.\n`])
    expect(t.spawned).toEqual([])
    expect(await readdir(join(t.data, "releases", `v${VERSION}`))).toEqual(["iter8"])
    expect(await readdir(join(t.home, ".local", "bin"))).toEqual(["iter8"])
  })

  test("the launcher follows ITER8_PLUGIN_DATA", async () => {
    const t = await fixture()
    const elsewhere = join(t.root, "plugin-data")
    t.system.env.ITER8_PLUGIN_DATA = elsewhere
    await t.run()
    expect(await readFile(t.launcher, "utf8")).toBe(LAUNCHER_PATHS(elsewhere))
    expect(await readlink(join(elsewhere, "current"))).toBe(
      join(elsewhere, "releases", `v${VERSION}`, "iter8"),
    )
    expect(await exists(t.data)).toBe(false)
  })

  test("escapes shell metacharacters in the data directory", async () => {
    const t = await fixture()
    t.system.env.ITER8_PLUGIN_DATA = join(t.root, 'we"ird $dir`')
    await t.run()
    expect(await readFile(t.launcher, "utf8")).toBe(
      `#!/bin/sh\n# iter8 setup\nexec "${join(t.root, 'we\\"ird \\$dir\\`')}/current" "$@"\n`,
    )
  })

  test("running from the installed path copies nothing and leaves the file as it is", async () => {
    const t = await fixture()
    await mkdir(join(t.data, "releases", `v${VERSION}`), { recursive: true })
    await writeFile(t.binary, "installed")
    await chmod(t.binary, 0o755)
    t.system.execPath = t.binary
    await t.run()
    expect(t.exits).toEqual([ExitCode.ok])
    expect(await readFile(t.binary, "utf8")).toBe("installed")
    expect(await readdir(join(t.data, "releases", `v${VERSION}`))).toEqual(["iter8"])
    expect(await readlink(join(t.data, "current"))).toBe(t.binary)
  })

  test("keeps an installed release of the same version instead of replacing it", async () => {
    const t = await fixture()
    await mkdir(join(t.data, "releases", `v${VERSION}`), { recursive: true })
    await writeFile(t.binary, "verified download")
    await chmod(t.binary, 0o755)
    await t.run()
    expect(await readFile(t.binary, "utf8")).toBe("verified download")
  })

  test("never points current at an older release than the one it targets", async () => {
    const t = await fixture()
    const newer = join(t.data, "releases", "v9.0.0", "iter8")
    await mkdir(join(t.data, "releases", "v9.0.0"), { recursive: true })
    await writeFile(newer, "newer")
    await chmod(newer, 0o755)
    await symlink(newer, join(t.data, "current"))
    await t.run()
    expect(await readlink(join(t.data, "current"))).toBe(newer)
    expect(await readFile(t.binary, "utf8")).toBe("#!/bin/sh\necho compiled\n")
  })

  test("a second run succeeds and rewrites the same launcher", async () => {
    const t = await fixture()
    await t.run()
    await t.run()
    expect(t.exits).toEqual([ExitCode.ok, ExitCode.ok])
    expect(await readFile(t.launcher, "utf8")).toBe(LAUNCHER_PATHS(t.data))
    expect(await readdir(join(t.home, ".local", "bin"))).toEqual(["iter8"])
  })

  test("fails when the running binary cannot be copied, leaving no partial file", async () => {
    const t = await fixture()
    t.system.execPath = join(t.root, "missing")
    await t.run()
    expect(t.exits).toEqual([ExitCode.failure])
    expect(await readdir(join(t.data, "releases", `v${VERSION}`))).toEqual([])
    expect(await exists(t.launcher)).toBe(false)
    expect(t.stdout).toEqual([])
  })
})

describe("an existing ~/.local/bin/iter8", () => {
  test.each([
    ["a script not written by iter8 setup", "#!/bin/sh\nexec something-else\n"],
    [
      "a script that only mentions the marker inside a longer line",
      "#!/bin/sh\n# iter8 setup notes\n",
    ],
    ["an empty file", ""],
  ])("refuses %s, naming the path and leaving it alone", async (_name, content) => {
    const t = await fixture()
    await mkdir(join(t.home, ".local", "bin"), { recursive: true })
    await writeFile(t.launcher, content)
    await t.run()
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr.join("")).toContain(t.launcher)
    expect(await readFile(t.launcher, "utf8")).toBe(content)
    expect(t.stdout).toEqual([])
  })

  test("refuses a symlink without writing through it", async () => {
    const t = await fixture()
    const target = join(t.root, "someone-elses-iter8")
    await writeFile(target, "keep me")
    await mkdir(join(t.home, ".local", "bin"), { recursive: true })
    await symlink(target, t.launcher)
    await t.run()
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr.join("")).toContain(t.launcher)
    expect(await readFile(target, "utf8")).toBe("keep me")
    expect((await lstat(t.launcher)).isSymbolicLink()).toBe(true)
  })

  test("refuses a directory", async () => {
    const t = await fixture()
    await mkdir(t.launcher, { recursive: true })
    await t.run()
    expect(t.exits).toEqual([ExitCode.failure])
    expect((await lstat(t.launcher)).isDirectory()).toBe(true)
  })

  test("replaces a launcher an earlier setup wrote", async () => {
    const t = await fixture()
    await mkdir(join(t.home, ".local", "bin"), { recursive: true })
    await writeFile(t.launcher, '#!/bin/sh\n# iter8 setup\nexec "/old/current" "$@"\n')
    await t.run()
    expect(t.exits).toEqual([ExitCode.ok])
    expect(await readFile(t.launcher, "utf8")).toBe(LAUNCHER_PATHS(t.data))
  })
})

describe("the PATH hint and the plugin pin", () => {
  test("says ~/.local/bin is missing from PATH and edits no shell profile", async () => {
    const t = await fixture({ env: { PATH: "/usr/bin:/bin" } })
    const profiles = [".bashrc", ".zshrc", ".profile", ".bash_profile", ".zprofile"]
    for (const name of profiles) await writeFile(join(t.home, name), `# ${name}\n`)
    await t.run()
    expect(t.exits).toEqual([ExitCode.ok])
    expect(t.stdout).toEqual([
      `Installed iter8 ${VERSION} at ~/.local/bin/iter8.\n`,
      "~/.local/bin is not on your PATH; add it in your shell profile.\n",
    ])
    for (const name of profiles)
      expect(await readFile(join(t.home, name), "utf8")).toBe(`# ${name}\n`)
    expect((await readdir(t.home)).sort()).toEqual([".local", ...profiles].sort())
  })

  test("says it when PATH is unset", async () => {
    const t = await fixture({ env: { PATH: undefined } })
    await t.run()
    expect(t.stdout.at(-1)).toBe(
      "~/.local/bin is not on your PATH; add it in your shell profile.\n",
    )
  })

  test.each([
    ["with a trailing slash", (home: string) => `/usr/bin:${join(home, ".local", "bin")}/`],
    ["first", (home: string) => `${join(home, ".local", "bin")}:/usr/bin`],
  ])("stays quiet when ~/.local/bin is on PATH %s", async (_name, path) => {
    const t = await fixture()
    t.system.env.PATH = path(t.home)
    await t.run()
    expect(t.stdout).toEqual([`Installed iter8 ${VERSION} at ~/.local/bin/iter8.\n`])
  })

  test("does not count a different directory that merely contains the name", async () => {
    const t = await fixture()
    t.system.env.PATH = `${join(t.home, ".local", "bin-extra")}:/usr/bin`
    await t.run()
    expect(t.stdout).toHaveLength(2)
  })

  test("warns when current targets a release newer than the plugin's pin", async () => {
    const t = await fixture({ env: { ITER8_PINNED_VERSION: "3.1.0" } })
    await t.run()
    expect(t.stdout).toEqual([
      `Installed iter8 ${VERSION} at ~/.local/bin/iter8.\n`,
      `Claude Code's iter8 plugin pins an older release; update the plugin so both use iter8 ${VERSION}.\n`,
    ])
  })

  test("names the newer release current already targets", async () => {
    const t = await fixture({ env: { ITER8_PINNED_VERSION: "3.1.0" } })
    const newer = join(t.data, "releases", "v9.0.0", "iter8")
    await mkdir(join(t.data, "releases", "v9.0.0"), { recursive: true })
    await writeFile(newer, "newer")
    await chmod(newer, 0o755)
    await symlink(newer, join(t.data, "current"))
    await t.run()
    expect(t.stdout.at(-1)).toContain("so both use iter8 9.0.0.")
  })

  test.each([
    ["equals the installed version", VERSION],
    ["is newer", "4.0.0"],
    ["is unset", undefined],
    ["is not a release version", "latest"],
  ])("says nothing when the pin %s", async (_name, pin) => {
    const t = await fixture({ env: { ITER8_PINNED_VERSION: pin } })
    await t.run()
    expect(t.stdout).toEqual([`Installed iter8 ${VERSION} at ~/.local/bin/iter8.\n`])
  })
})

describe("a host on Linux", () => {
  const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--"]

  test("checks ssh, writes the unit and enables it", async () => {
    const t = await fixture({ env: { SSH_AUTH_SOCK: "/run/user/1000/agent.sock" } })
    t.system.env.PATH = `/usr/local/bin:/usr/bin:${join(t.home, ".local", "bin")}`
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.ok])
    expect(t.spawned).toEqual([
      [...ssh, "devbox", "true"],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "iter8-connect.service"],
    ])
    expect(await readFile(t.unit, "utf8")).toBe(
      [
        "[Unit]",
        "Description=iter8 connect devbox",
        "",
        "[Service]",
        "ExecStart=%h/.local/bin/iter8 connect devbox",
        "Restart=always",
        "RestartSec=5",
        `Environment=PATH=/usr/local/bin:/usr/bin:${join(t.home, ".local", "bin")}`,
        "Environment=SSH_AUTH_SOCK=/run/user/1000/agent.sock",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    )
    expect(t.stdout.at(-1)).toBe("iter8 connect devbox now runs at login.\n")
    expect(await exists(t.plist)).toBe(false)
  })

  test("omits SSH_AUTH_SOCK when the environment has none", async () => {
    const t = await fixture()
    await t.run("devbox")
    expect(await readFile(t.unit, "utf8")).not.toContain("SSH_AUTH_SOCK")
  })

  test("doubles % in the description and the command, which systemd would expand", async () => {
    const t = await fixture()
    await t.run("me@dev%box")
    const unit = await readFile(t.unit, "utf8")
    expect(unit).toContain("Description=iter8 connect me@dev%%box\n")
    expect(unit).toContain("ExecStart=%h/.local/bin/iter8 connect me@dev%%box\n")
    expect(t.spawned[0]).toEqual([...ssh, "me@dev%box", "true"])
    expect(t.stdout.at(-1)).toBe("iter8 connect me@dev%box now runs at login.\n")
  })

  test("quotes a host or PATH that systemd would split or expand", async () => {
    const t = await fixture({ env: { PATH: "/opt/my tools/bin:/usr/bin" } })
    await t.run('we"ird$host')
    const unit = await readFile(t.unit, "utf8")
    expect(unit).toContain('ExecStart=%h/.local/bin/iter8 connect "we\\"ird$$host"\n')
    expect(unit).toContain('Environment="PATH=/opt/my tools/bin:/usr/bin"\n')
  })

  test("writes no unit and enables nothing when ssh needs a password or host-key confirmation", async () => {
    const t = await fixture({
      reply: (argv) => (argv[0] === "ssh" ? { code: 255, stderr: "Permission denied" } : {}),
    })
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr).toEqual([
      "SSH to devbox needs a password or a host-key confirmation. Run ssh devbox once, then retry setup.\n",
    ])
    expect(await exists(t.unit)).toBe(false)
    expect(await exists(join(t.home, ".config"))).toBe(false)
    expect(t.spawned).toEqual([[...ssh, "devbox", "true"]])
    expect(t.stdout.join("")).not.toContain("now runs at login")
  })

  test("exits 1 with the stderr of a failing systemctl and prints no success line", async () => {
    const t = await fixture({
      reply: (argv) =>
        argv.includes("enable")
          ? { code: 1, stderr: "Failed to connect to bus: No medium found\n" }
          : {},
    })
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr).toEqual(["Failed to connect to bus: No medium found\n"])
    expect(t.stdout.join("")).not.toContain("now runs at login")
  })

  test("exits 1 naming the tool when it cannot be started", async () => {
    const t = await fixture()
    const spawn = t.system.spawn
    t.system.spawn = (argv) => {
      if (argv[0] === "systemctl") throw new Error("ENOENT: no such file")
      return spawn(argv)
    }
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr).toEqual(["Could not run systemctl: ENOENT: no such file\n"])
  })

  test("does not spawn anything without a host", async () => {
    const t = await fixture()
    await t.run()
    expect(t.spawned).toEqual([])
    expect(await exists(join(t.home, ".config"))).toBe(false)
  })
})

describe("a host on macOS", () => {
  test("writes the launch agent and bootstraps it after clearing any earlier one", async () => {
    const t = await fixture({
      platform: "darwin",
      env: { SSH_AUTH_SOCK: "/private/tmp/com.apple.launchd.x/Listeners" },
    })
    t.system.env.PATH = "/opt/homebrew/bin:/usr/bin"
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.ok])
    expect(t.spawned).toEqual([
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", "devbox", "true"],
      ["launchctl", "bootout", "gui/501/dev.iter8.connect"],
      ["launchctl", "bootstrap", "gui/501", t.plist],
    ])
    const log = join(t.stateDir, "connect.log")
    expect(await readFile(t.plist, "utf8")).toBe(
      [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
        `<plist version="1.0">`,
        `<dict>`,
        `  <key>Label</key>`,
        `  <string>dev.iter8.connect</string>`,
        `  <key>ProgramArguments</key>`,
        `  <array>`,
        `    <string>${t.launcher}</string>`,
        `    <string>connect</string>`,
        `    <string>devbox</string>`,
        `  </array>`,
        `  <key>RunAtLoad</key>`,
        `  <true/>`,
        `  <key>KeepAlive</key>`,
        `  <true/>`,
        `  <key>EnvironmentVariables</key>`,
        `  <dict>`,
        `    <key>PATH</key>`,
        `    <string>/opt/homebrew/bin:/usr/bin</string>`,
        `    <key>SSH_AUTH_SOCK</key>`,
        `    <string>/private/tmp/com.apple.launchd.x/Listeners</string>`,
        `  </dict>`,
        `  <key>StandardOutPath</key>`,
        `  <string>${log}</string>`,
        `  <key>StandardErrorPath</key>`,
        `  <string>${log}</string>`,
        `</dict>`,
        `</plist>`,
        "",
      ].join("\n"),
    )
    expect((await stat(t.stateDir)).mode & 0o777).toBe(0o700)
    expect(t.stdout.at(-1)).toBe("iter8 connect devbox now runs at login.\n")
    expect(await exists(t.unit)).toBe(false)
  })

  test("escapes XML metacharacters in the host and the environment", async () => {
    const t = await fixture({ platform: "darwin", env: { PATH: "/a&b:/c<d" } })
    await t.run("user&co@box")
    const text = await readFile(t.plist, "utf8")
    expect(text).toContain("<string>user&amp;co@box</string>")
    expect(text).toContain("<string>/a&amp;b:/c&lt;d</string>")
    expect(text).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/)
    const tags = [...text.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)]
    const open: string[] = []
    for (const [, closing, name = "", selfClosing] of tags) {
      if (selfClosing) continue
      if (closing) expect(open.pop()).toBe(name)
      else open.push(name)
    }
    expect(open).toEqual([])
    expect(t.spawned[2]).toEqual(["launchctl", "bootstrap", "gui/501", t.plist])
  })

  test("omits SSH_AUTH_SOCK when the environment has none", async () => {
    const t = await fixture({ platform: "darwin" })
    await t.run("devbox")
    expect(await readFile(t.plist, "utf8")).not.toContain("SSH_AUTH_SOCK")
  })

  test("goes on when bootout fails because no earlier agent is loaded", async () => {
    const t = await fixture({
      platform: "darwin",
      reply: (argv) =>
        argv[1] === "bootout" ? { code: 113, stderr: "Could not find service" } : {},
    })
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.ok])
    expect(t.spawned.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", t.plist])
  })

  test("exits 1 with launchctl's stderr when bootstrap fails", async () => {
    const t = await fixture({
      platform: "darwin",
      reply: (argv) =>
        argv[1] === "bootstrap" ? { code: 5, stderr: "Bootstrap failed: 5\n" } : {},
    })
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.failure])
    expect(t.stderr).toEqual(["Bootstrap failed: 5\n"])
    expect(t.stdout.join("")).not.toContain("now runs at login")
  })

  test("writes no agent when ssh needs a password or host-key confirmation", async () => {
    const t = await fixture({
      platform: "darwin",
      reply: (argv) => (argv[0] === "ssh" ? { code: 255 } : {}),
    })
    await t.run("devbox")
    expect(t.exits).toEqual([ExitCode.failure])
    expect(await exists(join(t.home, "Library"))).toBe(false)
    expect(await exists(t.stateDir)).toBe(false)
    expect(t.spawned).toHaveLength(1)
  })
})

describe("an invalid host", () => {
  test.each([
    ["-oProxyCommand=x", ["-oProxyCommand=x"]],
    ["an option after --", ["--", "-oProxyCommand=x"]],
    ["an empty argument", [""]],
    ["whitespace", ["dev box"]],
    ["a control character", ["dev\u0007box"]],
  ])("%s exits usage before writing a file or running a program", async (_name, args) => {
    const t = await fixture()
    await t.run(...args)
    expect(t.exits).toEqual([ExitCode.usage])
    expect(await readdir(t.home)).toEqual([])
    expect(t.spawned).toEqual([])
    expect(t.stdout).toEqual([])
  })

  test("two hosts exit usage", async () => {
    const t = await fixture()
    await t.run("one", "two")
    expect(t.exits).toEqual([ExitCode.usage])
    expect(await readdir(t.home)).toEqual([])
  })

  test("an unknown flag exits usage", async () => {
    const t = await fixture()
    await t.run("--wat")
    expect(t.exits).toEqual([ExitCode.usage])
    expect(await readdir(t.home)).toEqual([])
  })
})
