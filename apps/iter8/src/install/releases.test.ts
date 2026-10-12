import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
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
import fc from "fast-check"
import {
  compareVersions,
  dataDir,
  type InstallDeps,
  installRelease,
  newestInstalled,
  pointCurrent,
  RELEASE_REPO,
} from "./releases"

const VERSION = "1.2.3"
const ASSET = "iter8-linux-x64"
const OTHER_ASSET = "iter8-darwin-arm64"

const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "i8-releases-"))
  directories.push(path)
  return path
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const versionScript = (printed: string) => `#!/bin/sh\nprintf '${printed}'\n`

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content)
  await chmod(path, 0o755)
}

type Release = { files: Record<string, string>; ghExit?: number; ghStderr?: string }

async function setup(release: Release) {
  const root = await tempDir()
  const data = join(root, "data")
  const published = join(root, "published")
  await mkdir(published)
  for (const [name, content] of Object.entries(release.files)) {
    await writeFile(join(published, name), content)
  }
  const ghLog = join(root, "gh.argv")
  const gh = join(root, "gh")
  await writeExecutable(
    gh,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > '${ghLog}'`,
      "dir=",
      'while [ $# -gt 0 ]; do if [ "$1" = --dir ]; then dir=$2; fi; shift; done',
      `for file in '${published}'/*; do [ -e "$file" ] && cp "$file" "$dir"/; done`,
      `printf '${release.ghStderr ?? ""}' >&2`,
      `exit ${release.ghExit ?? 0}`,
      "",
    ].join("\n"),
  )
  const spawned: string[][] = []
  const sleeps: number[] = []
  const deps: InstallDeps = {
    spawn: ((argv: string[], options: Parameters<typeof Bun.spawn>[1]) => {
      spawned.push(argv)
      return Bun.spawn(argv[0] === "gh" ? [gh, ...argv.slice(1)] : argv, options)
    }) as InstallDeps["spawn"],
    platform: "linux-x64",
    pid: 4242,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  const releaseDir = join(data, "releases", `v${VERSION}`)
  return {
    data,
    deps,
    spawned,
    sleeps,
    releaseDir,
    binary: join(releaseDir, "iter8"),
    ghArgv: async () => (await readFile(ghLog, "utf8")).trimEnd().split("\n"),
  }
}

const goodBinary = versionScript(`iter8 ${VERSION}\\n`)
const goodRelease = (binary = goodBinary): Release => ({
  files: {
    [ASSET]: binary,
    SHA256SUMS: `${sha256("darwin bytes")}  ${OTHER_ASSET}\n${sha256(binary)}  ${ASSET}\n`,
  },
})

async function installFails(release: Release, reason: string | RegExp) {
  const rig = await setup(release)
  const installing = installRelease(rig.data, VERSION, rig.deps)
  if (typeof reason === "string") await expect(installing).rejects.toThrow(reason)
  else await expect(installing).rejects.toThrow(reason)
  expect(await readdir(rig.releaseDir)).toEqual([])
  return rig
}

describe("dataDir", () => {
  test("follows the plugin launcher's formula, an empty variable counting as unset", () => {
    expect(dataDir({ ITER8_PLUGIN_DATA: "/plugin", XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe(
      "/plugin",
    )
    expect(dataDir({ XDG_DATA_HOME: "/xdg" }, "/home/u")).toBe("/xdg/iter8-claude-plugin")
    expect(dataDir({}, "/home/u")).toBe("/home/u/.local/share/iter8-claude-plugin")
    expect(dataDir({ ITER8_PLUGIN_DATA: "", XDG_DATA_HOME: "" }, "/home/u")).toBe(
      "/home/u/.local/share/iter8-claude-plugin",
    )
  })
})

describe("compareVersions", () => {
  test.each([
    ["0.3.0", "0.3.1"],
    ["0.9.9", "0.10.0"],
    ["0.10.0", "1.0.0"],
    ["1.0.0-rc.1", "1.0.0"],
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-2", "1.0.0-10"],
    ["1.0.0-9", "1.0.0-a"],
    ["0.9.0", "1.0.0-rc.1"],
    ["1.0.0-rc.1+build.9", "1.0.0"],
    ["not-a-version", "0.0.1"],
    ["1.0.0-", "0.0.1"],
    ["../9.9.9", "0.0.1"],
  ])("%s sorts below %s", (lower, higher) => {
    expect(compareVersions(lower, higher)).toBe(-1)
    expect(compareVersions(higher, lower)).toBe(1)
  })

  test("a version equals itself", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0)
  })

  test("build metadata does not change the order", () => {
    expect(compareVersions("1.2.3+build.5", "1.2.3")).toBe(0)
    expect(compareVersions("1.2.3+build.5", "1.2.3+sha.a1b2")).toBe(0)
  })

  const version = fc.oneof(
    fc
      .tuple(
        fc.nat(3),
        fc.nat(3),
        fc.nat(3),
        fc.option(
          fc.array(fc.constantFrom("alpha", "rc", "0", "1", "2", "10", "a-b"), {
            minLength: 1,
            maxLength: 3,
          }),
        ),
      )
      .map(([a, b, c, pre]) => `${a}.${b}.${c}${pre === null ? "" : `-${pre.join(".")}`}`),
    fc.constantFrom("", "v1.0.0", "1.0", "garbage", "1.0.0-", "01.2.3"),
  )

  test("compareVersions is antisymmetric and transitive", () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)) || 0)
        if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0) {
          expect(compareVersions(a, c)).toBeLessThanOrEqual(0)
        }
      }),
      { numRuns: 2_000 },
    )
  })
})

describe("installRelease", () => {
  test("downloads the platform asset and SHA256SUMS, verifies them and installs the binary", async () => {
    const rig = await setup(goodRelease())
    const path = await installRelease(rig.data, VERSION, rig.deps)

    expect(path).toBe(rig.binary)
    expect(await readFile(path, "utf8")).toBe(goodBinary)
    expect((await stat(path)).mode & 0o777).toBe(0o755)
    expect(await readdir(rig.releaseDir)).toEqual(["iter8"])
    const download = (await rig.ghArgv()).at(-1) ?? ""
    expect(await rig.ghArgv()).toEqual([
      "release",
      "download",
      `v${VERSION}`,
      "--repo",
      RELEASE_REPO,
      "--pattern",
      ASSET,
      "--pattern",
      "SHA256SUMS",
      "--dir",
      download,
    ])
    expect(download.startsWith(`${rig.releaseDir}/`)).toBe(true)
    expect(RELEASE_REPO).toBe("mayberuk/iter8")
    expect(rig.spawned.map((argv) => argv.slice(-1))).toEqual([[download], ["--version"]])
  })

  test("accepts a --version line with no trailing newline", async () => {
    const rig = await setup(goodRelease(versionScript(`iter8 ${VERSION}`)))
    expect(await installRelease(rig.data, VERSION, rig.deps)).toBe(rig.binary)
  })

  test("a release already installed is returned without downloading", async () => {
    const rig = await setup(goodRelease())
    await mkdir(rig.releaseDir, { recursive: true })
    await writeExecutable(rig.binary, "installed earlier")
    expect(await installRelease(rig.data, VERSION, rig.deps)).toBe(rig.binary)
    expect(rig.spawned).toEqual([])
    expect(await readFile(rig.binary, "utf8")).toBe("installed earlier")
    expect(await readdir(rig.releaseDir)).toEqual(["iter8"])
  })

  test("a checksum mismatch installs nothing and says so", async () => {
    await installFails(
      {
        files: {
          [ASSET]: goodBinary,
          SHA256SUMS: `${sha256("other bytes")}  ${ASSET}\n`,
        },
      },
      `the downloaded ${ASSET} does not match SHA256SUMS`,
    )
  })

  test("SHA256SUMS listing the asset twice is refused, even when one line matches", async () => {
    await installFails(
      {
        files: {
          [ASSET]: goodBinary,
          SHA256SUMS: `${sha256(goodBinary)}  ${ASSET}\n${sha256("other")}  ${ASSET}\n`,
        },
      },
      `SHA256SUMS lists ${ASSET} more than once`,
    )
  })

  test.each([
    ["no line for the asset", `${sha256(goodBinary)}  ${OTHER_ASSET}\n`],
    ["a line with one space", `${sha256(goodBinary)} ${ASSET}\n`],
    ["an uppercase hash", `${sha256(goodBinary).toUpperCase()}  ${ASSET}\n`],
  ])("SHA256SUMS with %s is refused", async (_case, sums) => {
    await installFails(
      { files: { [ASSET]: goodBinary, SHA256SUMS: sums } },
      `SHA256SUMS has no line for ${ASSET}`,
    )
  })

  test("a release without SHA256SUMS or without the asset is refused", async () => {
    await installFails({ files: { [ASSET]: goodBinary } }, "the release has no SHA256SUMS")
    await installFails(
      { files: { SHA256SUMS: `${sha256(goodBinary)}  ${ASSET}\n` } },
      `the release has no ${ASSET}`,
    )
  })

  test.each([
    ["another version", versionScript("iter8 1.2.4\\n")],
    ["extra output", versionScript(`iter8 ${VERSION}\\nmore\\n`)],
    ["two newlines", versionScript(`iter8 ${VERSION}\\n\\n`)],
    ["nothing", versionScript("")],
    ["a failing exit", `#!/bin/sh\nprintf 'iter8 ${VERSION}\\n'\nexit 1\n`],
  ])("a binary whose --version prints %s is refused", async (_case, binary) => {
    await installFails(goodRelease(binary), /--version printed .* instead of "iter8 1\.2\.3"/)
  })

  test("a failed gh download names gh's reason", async () => {
    await installFails(
      { files: {}, ghExit: 1, ghStderr: "release not found\\n" },
      `gh release download v${VERSION} failed: release not found`,
    )
  })

  test("a gh that cannot be run is reported", async () => {
    const rig = await setup(goodRelease())
    const deps: InstallDeps = {
      ...rig.deps,
      spawn: (() => {
        throw new Error('Executable not found in $PATH: "gh"')
      }) as InstallDeps["spawn"],
    }
    await expect(installRelease(rig.data, VERSION, deps)).rejects.toThrow("could not run gh")
    expect(await readdir(rig.releaseDir)).toEqual([])
  })

  test.each([
    "../x",
    "../escape",
    "/../../../escape",
    "1.2.3/../../../../escape",
    "1.2.3-rc/../../../../escape",
    "1.2.3\n",
    "1.2",
    "v1.2.3",
    "1.2.3-",
    "",
  ])(
    "a version %j that is not the plugin's version format is refused before touching the disk",
    async (version) => {
      const rig = await setup(goodRelease())
      const root = join(rig.data, "..")
      const before = (await readdir(root)).sort()
      await expect(installRelease(rig.data, version, rig.deps)).rejects.toThrow(
        "is not a release version",
      )
      expect(rig.spawned).toEqual([])
      await expect(stat(rig.data)).rejects.toMatchObject({ code: "ENOENT" })
      expect((await readdir(root)).sort()).toEqual(before)
      expect(await readdir(join(root, ".."))).not.toContain("escape")
    },
  )

  test("a version with prerelease and build metadata in the plugin's format is installed", async () => {
    const version = "1.2.3-rc.1+build.5"
    const binary = versionScript(`iter8 ${version}\\n`)
    const rig = await setup(goodRelease(binary))
    const path = await installRelease(rig.data, version, rig.deps)
    expect(path).toBe(join(rig.data, "releases", `v${version}`, "iter8"))
    expect(await readFile(path, "utf8")).toBe(binary)
  })

  test("a lock left by a dead process is reaped and the install goes ahead", async () => {
    const rig = await setup(goodRelease())
    const dead = Bun.spawn(["true"])
    await dead.exited
    await mkdir(join(rig.releaseDir, ".lock"), { recursive: true })
    await writeFile(join(rig.releaseDir, ".lock", "pid"), `${dead.pid}\n`)

    expect(await installRelease(rig.data, VERSION, rig.deps)).toBe(rig.binary)
    expect(rig.sleeps).toEqual([])
    expect(await readdir(rig.releaseDir)).toEqual(["iter8"])
  })

  test("a lock held by a live process is waited on, polling every second", async () => {
    const rig = await setup(goodRelease())
    const lock = join(rig.releaseDir, ".lock")
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, "pid"), `${process.pid}\n`)
    rig.deps.sleep = async (ms) => {
      rig.sleeps.push(ms)
      if (rig.sleeps.length === 3) await rm(lock, { recursive: true })
    }

    expect(await installRelease(rig.data, VERSION, rig.deps)).toBe(rig.binary)
    expect(rig.sleeps).toEqual([1_000, 1_000, 1_000])
  })

  test("a lock a live process never releases gives up after 300 s", async () => {
    const rig = await setup(goodRelease())
    const lock = join(rig.releaseDir, ".lock")
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, "pid"), `${process.pid}\n`)

    await expect(installRelease(rig.data, VERSION, rig.deps)).rejects.toThrow("over 300 s")
    expect(rig.sleeps).toEqual(Array.from({ length: 300 }, () => 1_000))
    expect(rig.spawned).toEqual([])
    expect(await readFile(join(lock, "pid"), "utf8")).toBe(`${process.pid}\n`)
  })
})

async function installAt(data: string, version: string, mode = 0o755): Promise<string> {
  const dir = join(data, "releases", `v${version}`)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "iter8")
  await writeFile(path, version)
  await chmod(path, mode)
  return path
}

describe("newestInstalled and pointCurrent", () => {
  test("with no release installed there is nothing to point at", async () => {
    const data = await tempDir()
    expect(await newestInstalled(data)).toBeNull()
    expect(await pointCurrent(data)).toBeNull()
    await expect(lstat(join(data, "current"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("only executable binaries under a v<x.y.z> directory count", async () => {
    const data = await tempDir()
    const one = await installAt(data, "1.0.0")
    await installAt(data, "3.0.0", 0o644)
    await mkdir(join(data, "releases", "vlatest"), { recursive: true })
    await writeExecutable(join(data, "releases", "vlatest", "iter8"), "")
    await mkdir(join(data, "releases", "v2.0.0"), { recursive: true })
    expect(await newestInstalled(data)).toEqual({ version: "1.0.0", path: one })
  })

  test("a directory whose name is not v plus the plugin's version format is skipped", async () => {
    const data = await tempDir()
    const one = await installAt(data, "1.0.0")
    for (const name of ["v9.9.9-", "v9.9", "v9.9.9 ", "v..", "9.9.9", "v9.9.9_1"]) {
      await mkdir(join(data, "releases", name), { recursive: true })
      await writeExecutable(join(data, "releases", name, "iter8"), "")
    }
    expect(await newestInstalled(data)).toEqual({ version: "1.0.0", path: one })
    expect(await pointCurrent(data)).toBe(one)

    const built = await installAt(data, "1.5.0+build.7")
    expect(await newestInstalled(data)).toEqual({ version: "1.5.0+build.7", path: built })
  })

  test("current moves forward to each newer release and never back", async () => {
    const data = await tempDir()
    const link = join(data, "current")
    const two = await installAt(data, "2.0.0")
    expect(await pointCurrent(data)).toBe(two)
    expect(await readlink(link)).toBe(two)

    await installAt(data, "1.5.0")
    expect(await pointCurrent(data)).toBe(two)
    expect(await readlink(link)).toBe(two)

    const three = await installAt(data, "3.0.0-rc.1")
    expect(await pointCurrent(data)).toBe(three)
    expect(await readlink(link)).toBe(three)
    expect((await readdir(data)).sort()).toEqual(["current", "releases"])
  })

  test("current already on a newer release, even one not installed here, stays put", async () => {
    const data = await tempDir()
    const link = join(data, "current")
    await installAt(data, "1.0.0")
    await symlink("releases/v9.0.0/iter8", link)
    expect(await pointCurrent(data)).toBe(join(data, "releases", "v9.0.0", "iter8"))
    expect(await readlink(link)).toBe("releases/v9.0.0/iter8")
  })

  test("current on something that is not a release is repointed", async () => {
    const data = await tempDir()
    const link = join(data, "current")
    const one = await installAt(data, "1.0.0")
    await symlink("/usr/bin/true", link)
    expect(await pointCurrent(data)).toBe(one)
    expect(await readlink(link)).toBe(one)
  })

  const release = fc
    .tuple(fc.nat(4), fc.nat(4), fc.nat(4), fc.option(fc.nat(3)))
    .map(([major, minor, patch, rc]) => ({ core: [major, minor, patch], rc }))
  type Release = { core: number[]; rc: number | null }
  const name = (r: Release) => `${r.core.join(".")}${r.rc === null ? "" : `-rc.${r.rc}`}`
  const newer = (a: Release, b: Release): boolean => {
    for (let index = 0; index < 3; index++) {
      const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0)
      if (diff !== 0) return diff > 0
    }
    return (a.rc ?? Number.POSITIVE_INFINITY) > (b.rc ?? Number.POSITIVE_INFINITY)
  }

  test("pointCurrent always targets the maximum installed version", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(release, { minLength: 1, maxLength: 6, selector: name }),
        async (releases) => {
          const data = await mkdtemp(join(tmpdir(), "i8-current-"))
          try {
            let best: Release | null = null
            for (const next of releases) {
              await installAt(data, name(next))
              if (best === null || newer(next, best)) best = next
              const expected = join(data, "releases", `v${name(best)}`, "iter8")
              expect(await pointCurrent(data)).toBe(expected)
              expect(await readlink(join(data, "current"))).toBe(expected)
            }
          } finally {
            await rm(data, { recursive: true, force: true })
          }
        },
      ),
      { numRuns: 40 },
    )
  })
})
