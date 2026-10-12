import { z } from "zod"

export const RUN_PORTS = { first: 4100, last: 4899 } as const

export type RunPlan =
  | {
      kind: "server"
      argv: string[]
      env: Record<string, string>
      port: number
      portVia: "flag" | "env"
    }
  | { kind: "folder"; root: string }
  | { kind: "nothing"; reason: string }

const PackageJson = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

/** FNV-1a 32-bit over the UTF-8 bytes of the text. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return hash
}

export function stablePort(projectRoot: string): number {
  return RUN_PORTS.first + (fnv1a(projectRoot) % (RUN_PORTS.last - RUN_PORTS.first + 1))
}

function packageManager(lockfiles: string[]): string {
  if (lockfiles.includes("bun.lock") || lockfiles.includes("bun.lockb")) return "bun"
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm"
  if (lockfiles.includes("yarn.lock")) return "yarn"
  return "npm"
}

function portFlags(deps: Record<string, string>, port: number): string[] | null {
  const has = (name: string) => Object.hasOwn(deps, name)
  if (has("next")) return ["-p", String(port)]
  if (has("astro")) return ["--port", String(port)]
  if (has("@sveltejs/kit") || (has("vite") && !has("@vue/cli-service"))) {
    return ["--port", String(port), "--strictPort"]
  }
  return null
}

export function planRun(input: {
  root: string
  packageJson: unknown
  lockfiles: string[]
  hasHtml: boolean
  command: string[] | null
  port: number
}): RunPlan {
  const env = { PORT: String(input.port) }
  if (input.command !== null && input.command.length > 0) {
    return { kind: "server", argv: input.command, env, port: input.port, portVia: "env" }
  }
  const manifest = PackageJson.parse(input.packageJson ?? {})
  const script = manifest.scripts?.dev ? "dev" : manifest.scripts?.start ? "start" : null
  if (script !== null) {
    const pm = packageManager(input.lockfiles)
    const flags = portFlags({ ...manifest.dependencies, ...manifest.devDependencies }, input.port)
    const extra = flags === null ? [] : pm === "npm" ? ["--", ...flags] : flags
    return {
      kind: "server",
      argv: [pm, "run", script, ...extra],
      env,
      port: input.port,
      portVia: flags === null ? "env" : "flag",
    }
  }
  if (input.hasHtml) return { kind: "folder", root: input.root }
  return {
    kind: "nothing",
    reason: `Nothing to run in ${input.root}: no dev or start script in package.json and no HTML files. Use iter8 run -- <command>.`,
  }
}
