import { mkdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

export const BUILD_OUTPUTS: { bin: string; overlayDir: string } = {
  bin: "dist/iter8",
  overlayDir: "dist/overlay",
}

export const ASSET_PREFIX = "/__iter8/assets/"

const repoRoot = resolve(import.meta.dir, "..")

export async function buildOverlayBundles(
  options: { root?: string; outDir?: string } = {},
): Promise<string[]> {
  const root = resolve(options.root ?? repoRoot)
  const outdir = resolve(root, options.outDir ?? BUILD_OUTPUTS.overlayDir)
  const overlayEntry = resolve(root, "apps/overlay/src/main.tsx")
  if (!(await Bun.file(overlayEntry).exists())) {
    throw new Error(`Missing overlay entry: ${overlayEntry}`)
  }

  const entries = [{ entry: overlayEntry, name: "overlay" }]
  const sourceEntry = resolve(root, "packages/source/src/index.ts")
  if (await Bun.file(sourceEntry).exists()) entries.push({ entry: sourceEntry, name: "source" })

  await mkdir(outdir, { recursive: true })
  const files: string[] = []
  for (const { entry, name } of entries) {
    const result = await Bun.build({
      entrypoints: [entry],
      outdir,
      target: "browser",
      format: "esm",
      splitting: false,
      minify: true,
      publicPath: ASSET_PREFIX,
      naming: `${name}.[ext]`,
    })
    if (!result.success) {
      throw new Error(`Bundle failed for ${entry}:\n${result.logs.join("\n")}`)
    }
    files.push(...result.outputs.map((output) => output.path))
  }
  return [...new Set(files)].sort()
}

export async function compileBinary(options: {
  root: string
  entry: string
  target: string
  outfile: string
  assetDir: string
}): Promise<void> {
  const root = resolve(options.root)
  const entry = resolve(root, options.entry)
  if (!(await Bun.file(entry).exists())) throw new Error(`Missing binary entry: ${entry}`)
  const outfile = resolve(root, options.outfile)
  await mkdir(dirname(outfile), { recursive: true })
  const assetDir = `./${relative(root, resolve(root, options.assetDir))}`
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      `--target=${options.target}`,
      "--asset",
      assetDir,
      "--outfile",
      outfile,
      entry,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(
      `Compile failed for ${entry} (${options.target}, exit ${exitCode}):\n${stdout}${stderr}`,
    )
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || (args[0] !== undefined && args[0] !== "overlay")) {
      throw new Error("Usage: bun scripts/build.ts [overlay]")
    }
    await buildOverlayBundles()
    if (args[0] !== "overlay") {
      await compileBinary({
        root: repoRoot,
        entry: "apps/iter8/src/main.ts",
        target: `bun-${process.platform}-${process.arch}`,
        outfile: BUILD_OUTPUTS.bin,
        assetDir: BUILD_OUTPUTS.overlayDir,
      })
    }
  } catch (error) {
    console.error(`Build failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
