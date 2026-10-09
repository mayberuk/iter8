import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { BUILD_OUTPUTS, buildOverlayBundles, compileBinary } from "./build"

export const RELEASE_ASSETS = ["iter8-linux-x64", "iter8-darwin-arm64", "SHA256SUMS"] as const

const repoRoot = resolve(import.meta.dir, "..")
const packageVersion = z.object({ version: z.string().min(1) })

export async function validateReleaseTag(tag: string, root = repoRoot): Promise<void> {
  const { version } = packageVersion.parse(await Bun.file(resolve(root, "package.json")).json())
  if (tag !== `v${version}`) {
    throw new Error(`Release tag ${tag} does not match package.json version: expected v${version}`)
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    const { values } = parseArgs({
      args: args[0] === "--" ? args.slice(1) : args,
      options: { tag: { type: "string" }, out: { type: "string" } },
      strict: true,
      allowPositionals: false,
    })
    if (!values.tag || !values.out) {
      throw new Error("Usage: bun run release -- --tag vX.Y.Z --out DIR")
    }
    await validateReleaseTag(values.tag)
    await buildOverlayBundles()
    const outdir = resolve(repoRoot, values.out)
    await mkdir(outdir, { recursive: true })
    const sums: string[] = []
    for (const name of RELEASE_ASSETS.slice(0, 2)) {
      const outfile = resolve(outdir, name)
      await compileBinary({
        root: repoRoot,
        entry: "apps/iter8/src/main.ts",
        target: `bun-${name.slice("iter8-".length)}`,
        outfile,
        assetDir: BUILD_OUTPUTS.overlayDir,
      })
      const hash = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(outfile).arrayBuffer())
        .digest("hex")
      sums.push(`${hash}  ${name}\n`)
    }
    await Bun.write(resolve(outdir, "SHA256SUMS"), sums.join(""))
  } catch (error) {
    console.error(`Release failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
