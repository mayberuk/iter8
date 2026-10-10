import { WORKER } from "./ports"
import { type Scratch, scratchDir } from "./scratch"

/** Bundles a browser entry to `overlay.js` in a fresh directory, servable as an overlay build. */
export async function buildBrowserBundle(entry: string): Promise<Scratch> {
  const outdir = await scratchDir(`/tmp/iter8-w${WORKER}-bundle-`)
  try {
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: outdir.path,
      target: "browser",
      format: "esm",
      naming: "overlay.js",
    })
    if (!result.success) {
      throw new Error(`Bundling ${entry} failed:\n${result.logs.map(String).join("\n")}`)
    }
  } catch (error) {
    await outdir.dispose()
    throw error
  }
  return outdir
}
