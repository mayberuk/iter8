import { expect, test } from "bun:test"
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ServiceStatus } from "@iter8/protocol"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { type CliEnv, childEnv, cliCommand, runCli } from "../../rig/cli"
import { nextPort, poolRange } from "../../rig/ports"
import { reapWithParent } from "../../rig/reap"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"

const REPO = join(import.meta.dir, "..", "..", "..")
const TRIGGER = join(REPO, "apps", "overlay", "src", `.dev-scenario-${process.pid}.txt`)
const READY_TIMEOUT_MS = 120_000
const REBUILD_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 30_000
const PAGE_URL = /^http:\/\/[a-z0-9-]+\.localhost:\d+\/$/m

const alive = (pid: number, group = false): boolean => {
  try {
    process.kill(group ? -pid : pid, 0)
    return true
  } catch {
    return false
  }
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(
    async (response) => {
      await response.body?.cancel()
      return true
    },
    () => false,
  )

async function recordedGroups(home: string): Promise<number[]> {
  const names = await readdir(join(home, "run")).catch(() => [])
  const groups: number[] = []
  for (const name of names.filter((entry) => entry.endsWith(".pid"))) {
    const record: unknown = JSON.parse(await readFile(join(home, "run", name), "utf8"))
    if (typeof record === "object" && record !== null && "pgid" in record) {
      if (typeof record.pgid === "number") groups.push(record.pgid)
    }
  }
  return groups
}

test("bun run dev serves the playground through a from-source iter8 and rebuilds the overlay when its sources change", async () => {
  const home = await scratchDir(SCRATCH_ROOT)
  const overlay = await scratchDir(`${SCRATCH_ROOT}overlay-`)
  const pool = await poolRange(4)
  const port = await nextPort()
  const env: CliEnv = {
    command: cliCommand(),
    home: home.path,
    pool,
    overlayDir: overlay.path,
    vars: { SSH_CONNECTION: "test" },
  }
  const bundle = join(overlay.path, "overlay.js")
  let browser: Browser | undefined
  let dev: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let output = ""
  try {
    dev = Bun.spawn([process.execPath, "scripts/dev.ts", "--port", String(port)], {
      cwd: REPO,
      env: childEnv(env),
      detached: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    reapWithParent(dev, { group: true })
    const decoder = new TextDecoder()
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
    }
    void drain(dev.stdout)
    void drain(dev.stderr)
    const running = dev

    const url = await waitFor(
      "dev to print the playground page URL",
      async () => {
        if (running.exitCode !== null) throw new Error("scripts/dev.ts exited early")
        return output.match(PAGE_URL)?.[0] ?? null
      },
      { timeoutMs: READY_TIMEOUT_MS, everyMs: 100 },
    )

    const status = (await runCli(env, ["status", "--json"])).json(ServiceStatus)
    expect(status.build).toBe("source")
    expect(status.overlay).toBe("present")
    expect(status.home).toBe(home.path)

    browser = await launchChromium()
    const { page, close } = await newPage(browser)
    try {
      await page.goto(url)
      await waitFor(
        "the overlay to mount with a shadow root",
        () =>
          page.evaluate(() => (document.querySelector("iter8-overlay")?.shadowRoot ? true : null)),
        { timeoutMs: 30_000, everyMs: 100 },
      )
    } finally {
      await close()
    }

    const before = (await stat(bundle)).mtimeMs
    await writeFile(TRIGGER, "")
    await waitFor(
      "the overlay bundle in the scratch dir to be rebuilt",
      async () => ((await stat(bundle)).mtimeMs > before ? true : null),
      { timeoutMs: REBUILD_TIMEOUT_MS, everyMs: 100 },
    )

    const groups = await recordedGroups(home.path)
    expect(groups).toHaveLength(1)
    dev.kill("SIGINT")
    await waitFor("dev to exit", async () => (dev?.exitCode === null ? null : true), {
      timeoutMs: EXIT_TIMEOUT_MS,
      everyMs: 100,
    })
    await waitFor(
      "every process dev started to be gone",
      async () =>
        alive(running.pid, true) || alive(status.pid) || groups.some((pgid) => alive(pgid, true))
          ? null
          : true,
      { timeoutMs: EXIT_TIMEOUT_MS, everyMs: 100 },
    )
    expect(await answers(port)).toBe(false)
  } catch (error) {
    throw new Error(`${(error as Error).message}\ndev output:\n${output}`, { cause: error })
  } finally {
    await rm(TRIGGER, { force: true })
    if (dev !== undefined && alive(dev.pid, true)) {
      process.kill(-dev.pid, "SIGKILL")
      await dev.exited
    }
    for (const pgid of await recordedGroups(home.path)) {
      if (alive(pgid, true)) process.kill(-pgid, "SIGKILL")
    }
    await browser?.close()
    await overlay.dispose()
    await home.dispose()
  }
}, 240_000)
