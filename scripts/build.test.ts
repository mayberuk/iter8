import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { ASSET_PREFIX, BUILD_OUTPUTS, buildOverlayBundles, compileBinary } from "./build"
import { validateReleaseTag } from "./release"

async function standInRoot() {
  return mkdtemp("/tmp/iter8-build-")
}

async function writeEntry(root: string, path: string, contents: string | Uint8Array) {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await Bun.write(file, contents)
}

test("overlay bundles mount and emits a font beside the module under the asset prefix", async () => {
  const root = await standInRoot()
  expect(ASSET_PREFIX).toBe("/__iter8/assets/")
  const font = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3])
  await writeEntry(root, "apps/overlay/src/font.woff2", font)
  await writeEntry(
    root,
    "apps/overlay/src/main.tsx",
    'import font from "./font.woff2"; export function mount() { return font }',
  )
  const files = await buildOverlayBundles({ root, outDir: "custom/bundles" })
  const outdir = join(root, "custom/bundles")
  const code = await Bun.file(join(outdir, "overlay.js")).text()
  const fontNames = (await readdir(outdir)).filter((file) => file.endsWith(".woff2"))
  expect(fontNames).toHaveLength(1)
  const fontName = fontNames[0]
  if (!fontName) throw new Error("No font was emitted")
  expect(fontName).toMatch(/^font-[a-z0-9]+\.woff2$/)
  expect(new Uint8Array(await Bun.file(join(outdir, fontName)).arrayBuffer())).toEqual(font)
  expect(code).toContain(`${ASSET_PREFIX}${fontName}`)
  const imports = new Bun.Transpiler({ loader: "js" }).scanImports(code)
  expect(imports.filter(({ path }) => !path.startsWith(".") && !path.startsWith("/"))).toEqual([])
  const bundle = await import(pathToFileURL(join(outdir, "overlay.js")).href)
  expect(typeof bundle.mount).toBe("function")
  expect(bundle.mount()).toBe(`${ASSET_PREFIX}${fontName}`)
  expect(files.sort()).toEqual([join(outdir, fontName), join(outdir, "overlay.js")].sort())
  expect(await Bun.file(join(outdir, "source.js")).exists()).toBe(false)
})

test("source.js is built only when the source entry exists", async () => {
  const root = await standInRoot()
  await writeEntry(root, "apps/overlay/src/main.tsx", "export function mount() {}")
  expect(await buildOverlayBundles({ root })).toEqual([join(root, "dist/overlay/overlay.js")])
  expect(await Bun.file(join(root, "dist/overlay/source.js")).exists()).toBe(false)
  await writeEntry(root, "packages/source/src/index.ts", 'export const framework = "stand-in"')
  expect(await buildOverlayBundles({ root })).toEqual([
    join(root, "dist/overlay/overlay.js"),
    join(root, "dist/overlay/source.js"),
  ])
  const source = await import(pathToFileURL(join(root, "dist/overlay/source.js")).href)
  expect(source.framework).toBe("stand-in")
})

test("a missing overlay entry names apps/overlay/src/main.tsx", async () => {
  const root = await standInRoot()
  await expect(buildOverlayBundles({ root })).rejects.toThrow(
    join(root, "apps/overlay/src/main.tsx"),
  )
})

test("a missing binary entry names apps/iter8/src/main.ts", async () => {
  const root = await standInRoot()
  await expect(
    compileBinary({
      root,
      entry: "apps/iter8/src/main.ts",
      target: `bun-${process.platform}-${process.arch}`,
      outfile: "dist/iter8",
      assetDir: "dist/overlay",
    }),
  ).rejects.toThrow(join(root, "apps/iter8/src/main.ts"))
})

test("slow: a compiled host binary reads embedded overlay relative to import.meta.dir", async () => {
  const root = await standInRoot()
  const bytes = new TextEncoder().encode('export const bundled = "embedded overlay ✓";\n')
  await writeEntry(root, "dist/overlay/overlay.js", bytes)
  await writeEntry(
    root,
    "apps/iter8/src/main.ts",
    'await Bun.write(Bun.stdout, Bun.file(import.meta.dir + "/overlay/overlay.js"))',
  )
  await compileBinary({
    root,
    entry: "apps/iter8/src/main.ts",
    target: `bun-${process.platform}-${process.arch}`,
    outfile: "dist/iter8",
    assetDir: "dist/overlay",
  })
  await unlink(join(root, "dist/overlay/overlay.js"))
  const child = Bun.spawn([join(root, "dist/iter8")], {
    cwd: await standInRoot(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode, stderr).toBe(0)
  expect(new Uint8Array(stdout)).toEqual(bytes)
}, 120_000)

test("release refuses v9.9.9 when package.json is version 0.1.0", async () => {
  const root = await standInRoot()
  await writeEntry(root, "package.json", '{"version":"0.1.0"}')
  await expect(validateReleaseTag("v9.9.9", root)).rejects.toThrow("expected v0.1.0")
  await expect(validateReleaseTag("v0.1.0", root)).resolves.toBeUndefined()
})

test("the release entry point refuses a mismatched tag before building anything", async () => {
  const repoRoot = resolve(import.meta.dir, "..")
  const { version } = (await Bun.file(join(repoRoot, "package.json")).json()) as {
    version: string
  }
  const out = await standInRoot()
  const child = Bun.spawn(
    ["bun", join(repoRoot, "scripts/release.ts"), "--tag", "v9.9.9", "--out", out],
    { cwd: await standInRoot(), stdout: "pipe", stderr: "pipe" },
  )
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain(`expected v${version}`)
  expect(stderr).not.toContain("Missing overlay entry")
  expect(await readdir(out)).toEqual([])
  expect(await Bun.file(join(repoRoot, BUILD_OUTPUTS.overlayDir, "overlay.js")).exists()).toBe(
    false,
  )
})
