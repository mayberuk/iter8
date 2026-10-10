import { cp, mkdtemp } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"
import { SourceConfidence } from "@iter8/protocol"
import { z } from "zod"
import { nextPort, WORKER } from "./ports"
import { waitFor } from "./wait"

const REPO = Bun.fileURLToPath(new URL("../../", import.meta.url))

export const FixtureName = z.enum([
  "static",
  "vite-react",
  "next-turbopack",
  "next-webpack",
  "sveltekit",
  "vue",
  "astro",
])
export type FixtureName = z.infer<typeof FixtureName>

const Fixture = z.object({
  name: FixtureName,
  dir: z.string().startsWith("fixtures/"),
  kind: z.enum(["folder", "server"]),
  devArgs: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  readyPath: z.string().startsWith("/"),
  heavyPath: z.string().startsWith("/").nullable(),
  targets: z.array(z.string().min(1)).min(1),
  confidence: SourceConfidence,
})
export type Fixture = z.infer<typeof Fixture>

export const FixtureManifest = z.array(Fixture)

export const MANIFEST = FixtureManifest.parse(
  await Bun.file(join(REPO, "fixtures/manifest.json")).json(),
)

function fixture(name: FixtureName): Fixture {
  const found = MANIFEST.find((entry) => entry.name === name)
  if (!found) throw new Error(`fixtures/manifest.json has no ${name} entry`)
  return found
}

export function fixtureDir(name: FixtureName): string {
  return join(REPO, fixture(name).dir)
}

const heavyPath = fixture("vite-react").heavyPath
if (heavyPath === null) throw new Error("fixtures/manifest.json gives vite-react no heavyPath")
export const HEAVY_PAGE: string = heavyPath

// A cold start measured 0.8–2.4 s (next-webpack slowest); the ceiling is for a machine loaded by
// parallel workers, and a miss still fails with the dev log.
const READY_TIMEOUT_MS = 120_000
const STOP_TIMEOUT_MS = 10_000

// Astro 7 detaches `astro dev` into an untracked daemon when it detects an AI agent in the
// environment, and allows one dev server per project through a lock file; `--ignore-lock` turns
// both off, so the server stays in the rig's process group and parallel workers can each run one.
const EXTRA_DEV_ARGS: Partial<Record<FixtureName, string[]>> = { astro: ["--ignore-lock"] }

export type RunningFixture = {
  name: FixtureName
  dir: string
  origin: string
  port: number
  url: (path?: string) => string
  stop: () => Promise<void>
}

export async function startFixture(name: FixtureName): Promise<RunningFixture> {
  const entry = fixture(name)
  const dir = fixtureDir(name)
  const port = await nextPort()
  const origin = `http://127.0.0.1:${port}`
  const url = (path = "/") => new URL(path, origin).href
  if (entry.kind === "folder") {
    const server = serveFolder(dir, port)
    return { name, dir, origin, port, url, stop: () => server.stop(true) }
  }

  const logs = await mkdtemp(`/tmp/iter8-w${WORKER}-${name}-`)
  const log = { out: join(logs, "stdout.log"), err: join(logs, "stderr.log") }
  const child = Bun.spawn(
    [
      "bun",
      "run",
      "dev",
      ...entry.devArgs.map((arg) => arg.replaceAll("{port}", String(port))),
      ...(EXTRA_DEV_ARGS[name] ?? []),
    ],
    {
      cwd: dir,
      env: { ...process.env, ...entry.env },
      detached: true,
      stdin: "ignore",
      stdout: Bun.file(log.out),
      stderr: Bun.file(log.err),
    },
  )
  const stop = () => stopGroup(child)
  try {
    await waitFor(
      `${name} to answer ${entry.readyPath} on port ${port}`,
      async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`${name} dev server exited early:\n${await tail(log)}`)
        }
        const response = await fetch(url(entry.readyPath), {
          signal: AbortSignal.timeout(READY_TIMEOUT_MS),
        }).catch(() => null)
        await response?.body?.cancel()
        return response?.status === 200 ? true : null
      },
      { timeoutMs: READY_TIMEOUT_MS, everyMs: 250 },
    )
  } catch (cause) {
    await stop()
    throw new Error(`${name} did not become ready; dev log:\n${await tail(log)}`, { cause })
  }
  return { name, dir, origin, port, url, stop }
}

function serveFolder(dir: string, port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const path = resolve(dir, `.${pathname}`)
      if (path !== dir && !path.startsWith(dir + sep)) return new Response(null, { status: 404 })
      const file = Bun.file(extname(path) === "" ? join(path, "index.html") : path)
      return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 })
    },
  })
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

// The whole group is signalled because `bun run` leaves the dev server as a grandchild.
async function stopGroup(child: Bun.Subprocess): Promise<void> {
  const signal = (name: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-child.pid, name)
    } catch {}
  }
  signal("SIGTERM")
  try {
    await waitFor(
      `process group ${child.pid} to exit`,
      async () => (groupAlive(child.pid) ? null : true),
      { timeoutMs: STOP_TIMEOUT_MS },
    )
  } catch {
    signal("SIGKILL")
    await waitFor(
      `process group ${child.pid} to exit after SIGKILL`,
      async () => (groupAlive(child.pid) ? null : true),
      { timeoutMs: STOP_TIMEOUT_MS },
    )
  }
  await child.exited
}

async function tail(log: { out: string; err: string }): Promise<string> {
  const read = (path: string) =>
    Bun.file(path)
      .text()
      .catch(() => "")
  const [out, err] = await Promise.all([read(log.out), read(log.err)])
  return `${out.slice(-3000)}\n${err.slice(-3000)}`
}

// Only these fixtures build to a folder of static files; the others need a server to render.
const STATIC_BUILD_TOOL: Partial<Record<FixtureName, string>> = {
  "vite-react": "vite",
  vue: "vite",
  astro: "astro",
}

export async function buildFixture(name: FixtureName): Promise<string> {
  const dir = fixtureDir(name)
  const out = await mkdtemp(`/tmp/iter8-w${WORKER}-${name}-build-`)
  if (fixture(name).kind === "folder") {
    await cp(dir, out, { recursive: true })
    return out
  }
  const tool = STATIC_BUILD_TOOL[name]
  if (!tool) throw new Error(`${name} has no static build, so the mock service cannot serve it`)
  const child = Bun.spawn([join(dir, "node_modules/.bin", tool), "build", "--outDir", out], {
    cwd: dir,
    env: { ...process.env, ...fixture(name).env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`${name} build exited ${code}:\n${stdout}\n${stderr}`)
  return out
}
