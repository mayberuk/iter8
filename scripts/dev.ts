import { watch } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ENV, ServiceStatus } from "@iter8/protocol"
import { buildOverlayBundles } from "./build"

const READY_LIMIT_MS = 30_000
const READY_POLL_MS = 200

/** The service drains itself after ten idle minutes; a clean exit sooner means another service holds the pool. */
export function afterServiceExit(code: number | null, ranMs: number): "restart" | "fail" {
  return code === 0 && ranMs >= READY_LIMIT_MS ? "restart" : "fail"
}

type Readiness = {
  status: (timeoutMs: number) => Promise<string | null>
  start: () => void
  now: () => number
  pause: (ms: number) => Promise<void>
  stopping: () => boolean
}

const statusSchema = ServiceStatus.pick({ state: true })

export async function startWhenReady({ status, start, now, pause, stopping }: Readiness) {
  const deadline = now() + READY_LIMIT_MS
  while (!stopping() && now() < deadline) {
    try {
      const text = await status(Math.max(1, deadline - now()))
      const report = text === null ? null : statusSchema.safeParse(JSON.parse(text))
      if (report?.success && report.data.state === "ready") {
        if (!stopping()) start()
        return
      }
    } catch {}
    if (stopping()) return
    await pause(Math.min(READY_POLL_MS, Math.max(0, deadline - now())))
  }
  if (stopping()) return
  throw new Error("The dev service did not become ready within 30 s.")
}

async function dev(): Promise<void> {
  const root = resolve(import.meta.dir, "..")
  const overlayDir = process.env[ENV.overlayDir]
  const buildOptions = overlayDir ? { outDir: overlayDir } : {}
  const launcher = resolve(root, "scripts/iter8-dev")
  const env = {
    ...process.env,
    ITER8_HOME: process.env.ITER8_HOME || resolve(homedir(), ".iter8-dev"),
    ITER8_POOL: process.env.ITER8_POOL || "3970-3973",
  }
  const children = new Set<Bun.Subprocess>()
  const watchers: ReturnType<typeof watch>[] = []
  let stopping = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setTimeout> | undefined
  let building: Promise<void> | null = null
  let dirty = false
  let finish = () => {}
  const stopped = new Promise<void>((resolve) => {
    finish = resolve
  })

  const stop = () => {
    if (stopping) return
    stopping = true
    clearTimeout(debounce)
    clearTimeout(poll)
    for (const watcher of watchers) watcher.close()
    for (const child of children) child.kill("SIGINT")
    finish()
  }
  const fail = (error: unknown) => {
    console.error(`Dev failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    stop()
  }
  const rebuild = () => {
    dirty = true
    if (building) return
    building = (async () => {
      while (dirty && !stopping) {
        dirty = false
        try {
          await buildOverlayBundles(buildOptions)
        } catch (error) {
          console.error(
            `Overlay build failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    })().finally(() => {
      building = null
    })
  }
  const start = (argv: string[], restartWhenIdle = false) => {
    const startedAt = Date.now()
    const child = Bun.spawn(argv, {
      cwd: root,
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    children.add(child)
    void child.exited.then((code) => {
      children.delete(child)
      if (stopping) return
      if (restartWhenIdle && afterServiceExit(code, Date.now() - startedAt) === "restart") {
        console.error("The dev service stopped while idle; starting it again.")
        start(argv, true)
        return
      }
      fail(`${argv.join(" ")} exited (${code})`)
    })
    return child
  }

  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    await buildOverlayBundles(buildOptions)
    if (stopping) return
    for (const path of ["apps/overlay/src", "packages/source/src"]) {
      const watcher = watch(resolve(root, path), { recursive: true }, () => {
        clearTimeout(debounce)
        debounce = setTimeout(rebuild, 100)
      })
      watcher.on("error", fail)
      watchers.push(watcher)
    }
    start([process.execPath, "--watch", "apps/iter8/src/main.ts", "serve"], true)
    await startWhenReady({
      status: async (timeoutMs) => {
        const probe = Bun.spawn([launcher, "status", "--json"], {
          cwd: root,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: timeoutMs,
          killSignal: "SIGKILL",
        })
        children.add(probe)
        try {
          const [text, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited])
          return code === 0 ? text : null
        } finally {
          children.delete(probe)
        }
      },
      start: () => {
        start([launcher, "run", "playground", ...process.argv.slice(2)])
      },
      now: Date.now,
      pause: (ms) =>
        Promise.race([
          stopped,
          new Promise<void>((resolve) => {
            poll = setTimeout(resolve, ms)
          }),
        ]),
      stopping: () => stopping,
    })
    await stopped
  } catch (error) {
    fail(error)
  } finally {
    stop()
    const kill = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL")
    }, 5_000)
    await Promise.all([...children].map((child) => child.exited))
    clearTimeout(kill)
    await building
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

if (import.meta.main) await dev()
