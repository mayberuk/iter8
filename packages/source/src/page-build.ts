import type { SourceBuild } from "@iter8/protocol"

export function detectBuild(page: {
  globals: Record<string, unknown>
  scriptSources: readonly string[]
}): SourceBuild {
  if (page.globals.TURBOPACK !== undefined) return "next-turbopack"
  if (page.globals.webpackChunk_N_E !== undefined) return "next-webpack"
  if (page.scriptSources.some((source) => source.includes("/@vite/client"))) return "vite"
  return "unknown"
}
