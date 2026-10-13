import { defineConfig } from "vite"
import { sveltekit } from "@sveltejs/kit/vite"

const outDir = process.env.ITER8_SVELTEKIT_OUT_DIR

export default defineConfig({
  plugins: [sveltekit({ outDir: outDir ?? ".svelte-kit" })],
  // Concurrent starts with different outDirs hash differently and would re-optimize into, and invalidate, one shared dep cache.
  ...(outDir ? { cacheDir: `${outDir}/vite-cache` } : {}),
})
