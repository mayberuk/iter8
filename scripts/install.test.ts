import { afterAll, expect, test } from "bun:test"
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const manifestSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
})
const installedSections = ["dependencies", "devDependencies", "optionalDependencies"] as const

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const manifestPaths = [
  "package.json",
  "packages/*/package.json",
  "harness/package.json",
  "fixtures/*/package.json",
]
  .flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })])
  .sort()

let checkout: string | undefined

afterAll(async () => {
  if (checkout !== undefined) await rm(checkout, { recursive: true, force: true })
})

// A checkout on another filesystem than bun's cache makes the install copy every package (870 MB,
// and /tmp is often RAM); beside the cache it hardlinks them.
async function makeCheckout(): Promise<string> {
  const cache = (await Bun.$`bun pm cache`.cwd(repoRoot).text()).trim()
  await mkdir(dirname(cache), { recursive: true })
  checkout = await mkdtemp(join(dirname(cache), "iter8-install-"))
  return checkout
}

async function readManifest(path: string) {
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
}

async function installedPath(workspaceDir: string, root: string, name: string) {
  for (const base of [workspaceDir, root]) {
    const candidate = join(base, "node_modules", name)
    if (
      await lstat(candidate).then(
        () => true,
        () => false,
      )
    )
      return candidate
  }
  return undefined
}

test("bun install --frozen-lockfile on a checkout without node_modules installs every pin and leaves bun.lock untouched", async () => {
  const root = await makeCheckout()
  for (const file of ["bun.lock", "bunfig.toml", ...manifestPaths]) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await cp(join(repoRoot, file), join(root, file))
  }
  const lockBefore = await readFile(join(root, "bun.lock"))

  const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(install.stdout).text(),
    new Response(install.stderr).text(),
    install.exited,
  ])
  expect(exitCode, `bun install --frozen-lockfile failed in ${root}\n${stdout}${stderr}`).toBe(0)

  const lockAfter = await readFile(join(root, "bun.lock"))
  expect(lockAfter.equals(lockBefore), "bun.lock changed during a frozen install").toBe(true)

  const manifests = await Promise.all(
    manifestPaths.map(async (path) => ({
      dir: join(root, dirname(path)),
      path,
      manifest: await readManifest(join(root, path)),
    })),
  )
  const workspaceDirs = new Map(
    manifests.flatMap(({ dir, manifest }) =>
      manifest.name ? [[manifest.name, dir] as const] : [],
    ),
  )

  const mismatches: string[] = []
  for (const { dir, path, manifest } of manifests) {
    for (const section of installedSections) {
      for (const [name, pin] of Object.entries(manifest[section] ?? {})) {
        const where = `${path}: ${section}.${name} pinned ${pin}`
        const installed = await installedPath(dir, root, name)
        if (!installed) {
          mismatches.push(`${where} but is not installed`)
        } else if (pin === "workspace:*") {
          const expectedDir = workspaceDirs.get(name)
          if (!expectedDir) {
            mismatches.push(`${where} but no workspace is named ${name}`)
          } else if (!(await lstat(installed)).isSymbolicLink()) {
            mismatches.push(`${where} but ${installed} is not a link`)
          } else if ((await realpath(installed)) !== (await realpath(expectedDir))) {
            mismatches.push(`${where} but ${installed} does not link to ${expectedDir}`)
          }
        } else {
          const { version } = await readManifest(join(installed, "package.json"))
          if (version !== pin) {
            mismatches.push(`${where} but installed ${version ?? "no version"}`)
          }
        }
      }
    }
  }
  expect(mismatches, mismatches.join("\n")).toEqual([])
}, 300_000)
