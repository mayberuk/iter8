import { mkdtemp } from "node:fs/promises"
import { WORKER } from "./ports"

/** Bundles a browser entry to `overlay.js` in a fresh directory, servable as an overlay build. */
export async function buildBrowserBundle(entry: string): Promise<string> {
  const outdir = await mkdtemp(`/tmp/iter8-w${WORKER}-bundle-`)
  const result = await Bun.build({
    entrypoints: [entry],
    outdir,
    target: "browser",
    format: "esm",
    naming: "overlay.js",
  })
  if (!result.success) {
    throw new Error(`Bundling ${entry} failed:\n${result.logs.map(String).join("\n")}`)
  }
  return outdir
}
