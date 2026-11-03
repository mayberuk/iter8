import { randomBytes } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"

export const RELEASE_REPO = "mayberuk/iter8"

export type Platform = "linux-x64" | "darwin-arm64"

const LOCK_POLL_MS = 1_000
const LOCK_WAIT_MS = 300_000 // The plugin installer shares this lock and waits the same 300 s.

// The plugin's install.sh and pin-release.sh accept exactly this VERSION_FORMAT; a version from
// another machine names directories and download URLs, so nothing looser may reach them.
const VERSION_FORMAT = /^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const SUM_LINE = /^([0-9a-f]{64}) {2}(iter8-linux-x64|iter8-darwin-arm64)$/
const CURRENT_TARGET = /(?:^|\/)releases\/v([^/]+)\/iter8$/

/** The plugin's data dir, by the same formula as the plugin's launcher. */
export function dataDir(env: Record<string, string | undefined>, home: string): string {
  return (
    env.ITER8_PLUGIN_DATA ||
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "iter8-claude-plugin")
  )
}

export function isReleaseVersion(version: string): boolean {
  return VERSION_FORMAT.test(version)
}

function parseVersion(version: string): { core: number[]; pre: string[] | null } | null {
  const match = VERSION_FORMAT.exec(version)
  if (match === null) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].slice(1).split("."),
  }
}

function compareIdentifiers(a: string, b: string): number {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Math.sign(Number(a) - Number(b))
  if (numericA !== numericB) return numericA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Orders x.y.z versions, a prerelease below its release and build metadata ignored; a string that
 * is not one sorts lowest.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) {
    if (left !== null) return 1
    if (right !== null) return -1
    return a < b ? -1 : a > b ? 1 : 0
  }
  for (let index = 0; index < 3; index++) {
    const order = Math.sign((left.core[index] ?? 0) - (right.core[index] ?? 0))
    if (order !== 0) return order
  }
  if (left.pre === null || right.pre === null) {
    return left.pre === right.pre ? 0 : left.pre === null ? 1 : -1
  }
  for (let index = 0; index < Math.min(left.pre.length, right.pre.length); index++) {
    const order = compareIdentifiers(left.pre[index] ?? "", right.pre[index] ?? "")
    if (order !== 0) return order
  }
  return Math.sign(left.pre.length - right.pre.length)
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined
}

function binaryPath(dataDir: string, version: string): string {
  return join(dataDir, "releases", `v${version}`, "iter8")
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export async function newestInstalled(
  dataDir: string,
): Promise<{ version: string; path: string } | null> {
  let entries: string[]
  try {
    entries = await readdir(join(dataDir, "releases"))
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw error
  }
  let newest: { version: string; path: string } | null = null
  for (const entry of entries) {
    const version = entry.slice(1)
    if (!entry.startsWith("v") || !isReleaseVersion(version)) continue
    const path = binaryPath(dataDir, version)
    if (!(await isExecutableFile(path))) continue
    if (newest === null || compareVersions(version, newest.version) > 0) newest = { version, path }
  }
  return newest
}

async function currentVersion(link: string): Promise<string | null> {
  try {
    const version = CURRENT_TARGET.exec(await readlink(link))?.[1]
    return version !== undefined && parseVersion(version) !== null ? version : null
  } catch {
    return null
  }
}

/** Points `current` at the newest installed release, unless it already targets a newer one. */
export async function pointCurrent(dataDir: string): Promise<string | null> {
  const link = join(dataDir, "current")
  const newest = await newestInstalled(dataDir)
  const pointed = await currentVersion(link)
  if (pointed !== null && (newest === null || compareVersions(pointed, newest.version) >= 0)) {
    return binaryPath(dataDir, pointed)
  }
  if (newest === null) return null
  const staging = `${link}.${process.pid}.${randomBytes(4).toString("hex")}`
  await symlink(newest.path, staging)
  try {
    await rename(staging, link)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
  return newest.path
}

export type InstallDeps = {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  spawn: typeof Bun.spawn
  platform: Platform
  pid: number
  sleep: (ms: number) => Promise<void>
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === "EPERM"
  }
}

async function lockHolder(lock: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(join(lock, "pid"), "utf8")).trim())
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function reapIfStale(lock: string): Promise<boolean> {
  const holder = await lockHolder(lock)
  if (holder === null || isAlive(holder)) return false
  const reaper = `${lock}.reap`
  try {
    await mkdir(reaper)
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  }
  try {
    // Another installer may have reaped this lock and taken it between the check and the mkdir.
    if ((await lockHolder(lock)) !== holder) return false
    await rm(join(lock, "pid"), { force: true })
    await rmdir(lock).catch(() => {})
    return true
  } finally {
    await rmdir(reaper)
  }
}

async function acquireLock(lock: string, deps: InstallDeps, version: string): Promise<void> {
  let waited = 0
  for (;;) {
    try {
      await mkdir(lock)
      await writeFile(join(lock, "pid"), `${deps.pid}\n`)
      return
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error
    }
    if (await reapIfStale(lock)) continue
    if (waited >= LOCK_WAIT_MS) {
      throw new Error(
        `another install of iter8 ${version} held ${lock} for over ${LOCK_WAIT_MS / 1000} s`,
      )
    }
    await deps.sleep(LOCK_POLL_MS)
    waited += LOCK_POLL_MS
  }
}

async function releaseLock(lock: string): Promise<void> {
  await rm(join(lock, "pid"), { force: true })
  await rmdir(lock).catch(() => {})
}

async function run(
  deps: InstallDeps,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = (() => {
    try {
      return deps.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    } catch (error) {
      throw new Error(
        `could not run ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })()
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

async function download(deps: InstallDeps, version: string, name: string): Promise<Uint8Array> {
  const url = `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${name}`
  const failed = (error: unknown) =>
    new Error(
      `could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
    )
  let response: Response
  try {
    // GitHub answers a release asset URL with a redirect to its storage host.
    response = await deps.fetch(url, { redirect: "follow" })
  } catch (error) {
    throw failed(error)
  }
  if (response.status === 404) {
    throw new Error(`the release v${version} has no ${name} (${url} returned 404)`)
  }
  if (!response.ok) throw new Error(`downloading ${url} returned HTTP ${response.status}`)
  try {
    return await response.bytes()
  } catch (error) {
    throw failed(error)
  }
}

async function expectedSum(sums: string, asset: string): Promise<string> {
  const matches = sums
    .split("\n")
    .map((line) => SUM_LINE.exec(line))
    .filter((match) => match?.[2] === asset)
  if (matches.length > 1) throw new Error(`SHA256SUMS lists ${asset} more than once`)
  const sum = matches[0]?.[1]
  if (sum === undefined) throw new Error(`SHA256SUMS has no line for ${asset}`)
  return sum
}

/** Downloads, verifies and installs a release under `releases/v<version>/iter8`; returns its path. */
export async function installRelease(
  dataDir: string,
  version: string,
  deps: InstallDeps,
): Promise<string> {
  if (!isReleaseVersion(version)) {
    throw new Error(`${JSON.stringify(version)} is not a release version`)
  }
  const releaseDir = join(dataDir, "releases", `v${version}`)
  const binary = join(releaseDir, "iter8")
  const lock = join(releaseDir, ".lock")
  await mkdir(releaseDir, { recursive: true })
  await acquireLock(lock, deps, version)
  try {
    if (await isExecutableFile(binary)) return binary
    const asset = `iter8-${deps.platform}`
    const scratch = await mkdtemp(join(releaseDir, ".download-"))
    try {
      const sums = new TextDecoder().decode(await download(deps, version, "SHA256SUMS"))
      const sum = await expectedSum(sums, asset)
      const bytes = await download(deps, version, asset)
      if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== sum) {
        throw new Error(`the downloaded ${asset} does not match SHA256SUMS`)
      }
      const downloaded = join(scratch, asset)
      await writeFile(downloaded, bytes)
      await chmod(downloaded, 0o755)
      const smoke = await run(deps, [downloaded, "--version"])
      const expected = `iter8 ${version}`
      if (smoke.code !== 0 || (smoke.stdout !== expected && smoke.stdout !== `${expected}\n`)) {
        throw new Error(
          `the downloaded ${asset} --version printed ${JSON.stringify(smoke.stdout.trim())} instead of "${expected}"`,
        )
      }
      await rename(downloaded, binary)
      return binary
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  } finally {
    await releaseLock(lock)
  }
}
