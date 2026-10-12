import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { join } from "node:path"
import pkg from "../../../package.json"
import { BUILD_OUTPUTS } from "../../../scripts/build"
import { reapWithParent } from "../../rig/reap"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"

const REPO = join(import.meta.dir, "..", "..", "..")
const SYSTEM_PATH = "/usr/bin:/bin"

async function run(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  reapWithParent(child)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

test("setup from the compiled binary installs the release, points current at it and writes the launcher", async () => {
  const built = join(REPO, BUILD_OUTPUTS.bin)
  if (!(await Bun.file(built).exists()))
    throw new Error(`no built binary at ${built} — run bun run build`)
  const scratch = await scratchDir(`${SCRATCH_ROOT}setup-`)
  try {
    const home = join(scratch.path, "home")
    const data = join(scratch.path, "data")
    const iter8Home = join(scratch.path, "iter8-home")
    await mkdir(home)
    const env = (path: string) => ({
      HOME: home,
      XDG_DATA_HOME: data,
      ITER8_HOME: iter8Home,
      PATH: path,
    })
    const dataDir = join(data, "iter8-claude-plugin")
    const launcher = join(home, ".local", "bin", "iter8")

    const off = await run([built, "setup"], env(SYSTEM_PATH))
    expect(off.stderr).toBe("")
    expect(off.exitCode).toBe(0)
    expect(off.stdout).toBe(
      `Installed iter8 ${pkg.version} at ~/.local/bin/iter8.\n~/.local/bin is not on your PATH; add it in your shell profile.\n`,
    )

    const release = join(dataDir, "releases", `v${pkg.version}`, "iter8")
    expect(
      Buffer.compare(Buffer.from(await readFile(release)), Buffer.from(await readFile(built))),
    ).toBe(0)
    expect((await lstat(join(dataDir, "current"))).isSymbolicLink()).toBe(true)
    expect(await realpath(join(dataDir, "current"))).toBe(await realpath(release))

    expect(await readFile(launcher, "utf8")).toBe(
      `#!/bin/sh\n# iter8 setup\nexec "${join(dataDir, "current")}" "$@"\n`,
    )
    expect((await lstat(launcher)).mode & 0o777).toBe(0o755)

    const version = await run([launcher, "--version"], env(SYSTEM_PATH))
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toBe(`iter8 ${pkg.version}\n`)

    const on = await run([built, "setup"], env(`${join(home, ".local", "bin")}:${SYSTEM_PATH}`))
    expect(on.exitCode).toBe(0)
    expect(on.stdout).toBe(`Installed iter8 ${pkg.version} at ~/.local/bin/iter8.\n`)
  } finally {
    await scratch.dispose()
  }
}, 60_000)
