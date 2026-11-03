import { readdirSync } from "node:fs"
import { join, resolve } from "node:path"

export type Notice = {
  name: string
  version: string
  license: string
  repository: string | null
  texts: { file: string; text: string }[]
}

type Deps = Record<string, string>
type LockEntry = [string, string, { dependencies?: Deps; optionalDependencies?: Deps }?]

const PERMISSIVE = /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|CC0-1\.0)$/
const LICENSE_FILE = /^(licen[sc]e|notice|copying)([-._].*)?$/i
const WORKSPACE = "@workspace:"

const repoRoot = resolve(import.meta.dir, "..")

/**
 * Name and version of each package `bun build --compile` can embed: the runtime closure of the
 * root `dependencies`, following workspace packages into their own `dependencies`.
 */
export async function bundledPackages(
  root = repoRoot,
): Promise<{ name: string; version: string }[]> {
  const manifest = (await Bun.file(join(root, "package.json")).json()) as { dependencies: Deps }
  const lock = Bun.JSONC.parse(await Bun.file(join(root, "bun.lock")).text()) as {
    packages: Record<string, LockEntry>
  }
  const found = new Map<string, { name: string; version: string }>()
  const seen = new Set<string>()

  const visit = async (name: string, parentKey: string): Promise<void> => {
    const key = [`${parentKey}/${name}`, name].find((k) => lock.packages[k] !== undefined)
    const entry = key === undefined ? undefined : lock.packages[key]
    if (key === undefined || entry === undefined || seen.has(key)) return
    seen.add(key)
    const [spec, , meta] = entry
    // Type-only packages carry no code into the binary.
    if (name.startsWith("@types/")) return
    let deps: Deps = { ...meta?.dependencies, ...meta?.optionalDependencies }
    if (spec.includes(WORKSPACE)) {
      const dir = spec.slice(spec.indexOf(WORKSPACE) + WORKSPACE.length)
      const pkg = (await Bun.file(join(root, dir, "package.json")).json()) as {
        dependencies?: Deps
      }
      deps = pkg.dependencies ?? {}
    } else {
      found.set(spec, { name, version: spec.slice(name.length + 1) })
    }
    for (const dep of Object.keys(deps)) await visit(dep, key)
  }

  for (const dep of Object.keys(manifest.dependencies)) await visit(dep, "")
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  )
}

function installedDir(root: string, name: string, version: string): string {
  const store = join(root, "node_modules/.bun")
  const prefix = `${name.replace("/", "+")}@${version}`
  const folder = readdirSync(store).find((f) => f === prefix || f.startsWith(`${prefix}+`))
  if (folder === undefined) throw new Error(`${prefix} is not installed; run bun install`)
  return join(store, folder, "node_modules", name)
}

export async function collectNotices(root = repoRoot): Promise<Notice[]> {
  const notices: Notice[] = []
  for (const { name, version } of await bundledPackages(root)) {
    const dir = installedDir(root, name, version)
    const pkg = await Bun.file(join(dir, "package.json")).json()
    const license: string =
      typeof pkg.license === "string"
        ? pkg.license
        : typeof pkg.license?.type === "string"
          ? pkg.license.type
          : (pkg.licenses?.map((l: { type: string }) => l.type).join(" OR ") ?? "UNKNOWN")
    const repository: string | null =
      typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? null)
    const files = readdirSync(dir)
      .filter((f) => LICENSE_FILE.test(f))
      .sort()
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: (await Bun.file(join(dir, file)).text()).trim() })),
    )
    if (texts.length === 0) {
      // Some packages publish without their LICENSE file; record the licence their manifest declares.
      texts.push({
        file: "package.json",
        text: `The package ships no licence file; its package.json declares the ${license} licence.`,
      })
    }
    notices.push({ name, version, license, repository, texts })
  }
  return notices
}

export function nonPermissive(notices: Notice[]): Notice[] {
  return notices.filter((n) => !PERMISSIVE.test(n.license))
}

export function renderNotices(notices: Notice[]): string {
  const rule = "=".repeat(78)
  const head = [
    "THIRD-PARTY NOTICES",
    "",
    "The iter8 binary and overlay bundle contain the open-source packages below.",
    "Each package is listed with its licence and the licence text it ships.",
    "Regenerate with: bun scripts/notices.ts",
  ].join("\n")
  const body = notices.map((n) => {
    const lines = [rule, `${n.name} ${n.version}`, `License: ${n.license}`]
    if (n.repository !== null) lines.push(`Source: ${n.repository}`)
    for (const { file, text } of n.texts) lines.push("", `--- ${file} ---`, text)
    return lines.join("\n")
  })
  return `${[head, ...body].join("\n\n")}\n`
}

if (import.meta.main) {
  const notices = await collectNotices()
  await Bun.write(join(repoRoot, "THIRD-PARTY-NOTICES"), renderNotices(notices))
  console.log(`wrote THIRD-PARTY-NOTICES for ${notices.length} packages`)
  for (const n of nonPermissive(notices)) {
    console.warn(`non-permissive licence: ${n.name}@${n.version} is ${n.license}`)
  }
}
