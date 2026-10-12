import { watch } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { ENV, ServiceStatus } from "@iter8/protocol"
import { buildOverlayBundles } from "./build"

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
  const statusSchema = ServiceStatus.pick({ state: true })
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
  const start = (argv: string[]) => {
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
      if (!stopping) fail(`${argv.join(" ")} exited (${code})`)
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
    start([process.execPath, "--watch", "apps/iter8/src/main.ts", "serve"])
    const deadline = Date.now() + 30_000
    let ready = false
    while (!stopping && Date.now() < deadline) {
      const probe = Bun.spawn([launcher, "status", "--json"], {
        cwd: root,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: Math.max(1, deadline - Date.now()),
        killSignal: "SIGKILL",
      })
      children.add(probe)
      try {
        const [text, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited])
        if (code === 0) {
          const report = statusSchema.safeParse(JSON.parse(text))
          ready = report.success && report.data.state === "ready"
        }
      } catch {
      } finally {
        children.delete(probe)
      }
      if (ready || stopping) break
      await Promise.race([
        stopped,
        new Promise<void>((resolve) => {
          poll = setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now())))
        }),
      ])
    }
    if (stopping) return
    if (!ready) throw new Error("The dev service did not become ready within 30 s.")
    start([launcher, "run", "playground", ...process.argv.slice(2)])
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

await dev()
