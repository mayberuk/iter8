import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const installer = fileURLToPath(new URL("../install.sh", import.meta.url))
const VERSION = "1.2.3"
const TOOLS = [
  "awk",
  "chmod",
  "cp",
  "curl",
  "grep",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "rmdir",
  "tr",
  "wc",
]

const sha256 = (bytes: string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const fakeBinary = (label: string, version = VERSION) =>
  `#!/bin/sh\n# ${label}\n[ "$1" = --version ] && printf 'iter8 ${version}\\n'\n`

type Release = {
  assets: Record<string, string>
  sums: string
  latest: string | null
}

function release(overrides: Partial<Release> = {}): Release {
  const assets = {
    "iter8-linux-x64": fakeBinary("linux"),
    "iter8-darwin-arm64": fakeBinary("darwin"),
  }
  const sums = Object.entries(assets)
    .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
    .join("")
  return { assets, sums, latest: `v${VERSION}`, ...overrides }
}

let current = release()
let requests: string[] = []
let server: ReturnType<typeof Bun.serve>
let base: string
const scratch = await mkdtemp(join(tmpdir(), "iter8-install-script-"))

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url)
      requests.push(pathname)
      if (pathname === "/releases/latest") {
        const target = current.latest === null ? "/releases" : `/releases/tag/${current.latest}`
        return new Response(null, { status: 302, headers: { location: `${base}${target}` } })
      }
      const match = pathname.match(/^\/releases\/download\/v([^/]+)\/(.+)$/)
      if (match?.[1] !== VERSION) return new Response("not found", { status: 404 })
      const name = match[2]
      if (name === "SHA256SUMS") return new Response(current.sums)
      const asset = name === undefined ? undefined : current.assets[name]
      return asset === undefined ? new Response("not found", { status: 404 }) : new Response(asset)
    },
  })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await server.stop(true)
  await rm(scratch, { recursive: true, force: true })
})

let counter = 0

type Setup = {
  uname?: [string, string]
  without?: string[]
  shasumOnly?: boolean
  binOnPath?: boolean
  env?: Record<string, string>
}

// PATH holds only symlinks to the tools the installer needs, plus a `gh` that records any call,
// so "needs no gh" and "falls back to shasum" are properties of the PATH, not of this machine.
async function runInstaller(setup: Setup = {}) {
  counter += 1
  const dir = join(scratch, `case-${counter}`)
  const tools = join(dir, "tools")
  const binDir = join(dir, "bin dir")
  const ghCalls = join(dir, "gh-called")
  await mkdir(tools, { recursive: true })
  const names = [...TOOLS, ...(setup.shasumOnly ? [] : ["sha256sum"])].filter(
    (name) => !(setup.without ?? []).includes(name),
  )
  for (const name of names) {
    const path = Bun.which(name)
    if (path === null) throw new Error(`${name} is needed to run the installer test`)
    await symlink(path, join(tools, name))
  }
  const [system, machine] = setup.uname ?? ["Linux", "x86_64"]
  await writeFile(
    join(tools, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
  )
  await writeFile(join(tools, "gh"), `#!/bin/sh\necho "$@" >> '${ghCalls}'\nexit 1\n`)
  if (setup.shasumOnly) {
    const real = Bun.which("sha256sum")
    await writeFile(
      join(tools, "shasum"),
      `#!/bin/sh\n[ "$1 $2" = "-a 256" ] || exit 2\nexec ${real} "$3"\n`,
    )
  }
  for (const name of ["uname", "gh", "shasum"]) {
    await chmod(join(tools, name), 0o755).catch(() => undefined)
  }
  requests = []
  const proc = Bun.spawn(["/bin/sh", installer], {
    env: {
      PATH: setup.binOnPath ? `${tools}:${binDir}` : tools,
      HOME: join(dir, "home"),
      ITER8_BIN_DIR: binDir,
      ITER8_RELEASE_BASE: base,
      ...setup.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const installed = join(setup.env?.ITER8_BIN_DIR ?? binDir, "iter8")
  const ghCalled = await readFile(ghCalls, "utf8").then(
    () => true,
    () => false,
  )
  return { stdout, stderr, code, installed, binDir, ghCalled, dir }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

test("resolves the latest release through the redirect, installs the verified binary, and needs no gh", async () => {
  current = release()
  const run = await runInstaller()
  expect(run.code, run.stderr).toBe(0)
  expect(await readFile(run.installed, "utf8")).toBe(fakeBinary("linux"))
  expect((await stat(run.installed)).mode & 0o111).not.toBe(0)
  expect(requests).toEqual([
    "/releases/latest",
    `/releases/download/v${VERSION}/iter8-linux-x64`,
    `/releases/download/v${VERSION}/SHA256SUMS`,
  ])
  expect(run.ghCalled).toBe(false)
  expect(run.stdout).toContain(`installed iter8 ${VERSION}`)
})

test("tells the user the next step for a remote dev server, and warns when the bin dir is off PATH", async () => {
  current = release()
  const off = await runInstaller()
  expect(off.stdout).toContain(`${off.binDir} is not on your PATH`)
  expect(off.stdout).toContain(`${off.binDir}/iter8 setup <host>`)

  const on = await runInstaller({ binOnPath: true })
  expect(on.code, on.stderr).toBe(0)
  expect(on.stdout).not.toContain("is not on your PATH")
  expect(on.stdout).toContain("  iter8 setup <host>")
})

test("a pinned ITER8_VERSION skips the latest lookup and accepts a leading v", async () => {
  current = release({ latest: null })
  const run = await runInstaller({ env: { ITER8_VERSION: `v${VERSION}` } })
  expect(run.code, run.stderr).toBe(0)
  expect(requests).not.toContain("/releases/latest")
  expect(await exists(run.installed)).toBe(true)
})

test("installs to $HOME/.local/bin when ITER8_BIN_DIR is unset", async () => {
  current = release()
  const run = await runInstaller({ env: { ITER8_BIN_DIR: "" } })
  expect(run.code, run.stderr).toBe(0)
  expect(await exists(join(run.dir, "home", ".local", "bin", "iter8"))).toBe(true)
})

test("macOS on Apple silicon downloads the darwin-arm64 asset", async () => {
  current = release()
  const run = await runInstaller({ uname: ["Darwin", "arm64"] })
  expect(run.code, run.stderr).toBe(0)
  expect(await readFile(run.installed, "utf8")).toBe(fakeBinary("darwin"))
  expect(requests).toContain(`/releases/download/v${VERSION}/iter8-darwin-arm64`)
})

test("other platforms are refused before anything is downloaded", async () => {
  current = release()
  for (const uname of [
    ["Linux", "aarch64"],
    ["Darwin", "x86_64"],
    ["FreeBSD", "amd64"],
  ] as [string, string][]) {
    const run = await runInstaller({ uname })
    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(`unsupported platform ${uname[0]}/${uname[1]}`)
    expect(run.stderr).toContain("linux-x64 and darwin-arm64")
    expect(requests).toEqual([])
    expect(await exists(run.installed)).toBe(false)
  }
})

test("a download that does not match SHA256SUMS is never installed", async () => {
  const good = release()
  current = release({
    assets: { ...good.assets, "iter8-linux-x64": `${good.assets["iter8-linux-x64"]}# tampered\n` },
    sums: good.sums,
  })
  const run = await runInstaller()
  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("checksum mismatch")
  expect(await exists(run.installed)).toBe(false)
})

test("a checksum list without the asset, or with it twice, is refused", async () => {
  const good = release()
  current = release({
    sums: good.sums
      .split("\n")
      .filter((l) => !l.includes("linux"))
      .join("\n"),
  })
  const missing = await runInstaller()
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("no entry for iter8-linux-x64")

  const line = good.sums.split("\n").find((l) => l.includes("linux")) ?? ""
  current = release({ sums: `${good.sums}${line}\n` })
  const twice = await runInstaller()
  expect(twice.code).not.toBe(0)
  expect(twice.stderr).toContain("more than once")
  expect(await exists(twice.installed)).toBe(false)
})

test("verifies with shasum -a 256 when sha256sum is absent", async () => {
  current = release()
  const run = await runInstaller({ shasumOnly: true })
  expect(run.code, run.stderr).toBe(0)
  expect(await exists(run.installed)).toBe(true)
})

test("refuses to install without a SHA-256 tool", async () => {
  current = release()
  const none = await runInstaller({ without: ["sha256sum"] })
  expect(none.code).not.toBe(0)
  expect(none.stderr).toContain("sha256sum or shasum")
  expect(await exists(none.installed)).toBe(false)
})

test("a binary that does not report the requested version is not installed", async () => {
  const wrong = fakeBinary("linux", "9.9.9")
  current = release({
    assets: { "iter8-linux-x64": wrong, "iter8-darwin-arm64": wrong },
    sums: `${sha256(wrong)}  iter8-linux-x64\n${sha256(wrong)}  iter8-darwin-arm64\n`,
  })
  const run = await runInstaller()
  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("expected 'iter8 1.2.3'")
  expect(await exists(run.installed)).toBe(false)
})

test("says so when no release exists, and rejects a malformed version", async () => {
  current = release({ latest: null })
  const none = await runInstaller()
  expect(none.code).not.toBe(0)
  expect(none.stderr).toContain("no release has been published yet")

  const bad = await runInstaller({ env: { ITER8_VERSION: "../1.2" } })
  expect(bad.code).not.toBe(0)
  expect(bad.stderr).toContain("is not a version")
  expect(requests).toEqual([])
})

test("a missing release is a clear download failure, not a partial install", async () => {
  current = release()
  const run = await runInstaller({ env: { ITER8_VERSION: "7.7.7" } })
  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("download failed")
  expect(await exists(run.installed)).toBe(false)
})

test("without curl it stops with a plain message", async () => {
  const run = await runInstaller({ without: ["curl"] })
  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("curl is required")
})
