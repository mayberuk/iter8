import { defineConfig } from "vite"
import { sveltekit } from "@sveltejs/kit/vite"

export default defineConfig({
  plugins: [sveltekit({ outDir: process.env.ITER8_SVELTEKIT_OUT_DIR ?? ".svelte-kit" })],
})
