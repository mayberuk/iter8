import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { join } from "node:path"
import type { Browser } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { childEnv, cliCommand } from "../../rig/cli"
import { fixtureDir } from "../../rig/fixtures"
import { nextPort } from "../../rig/ports"
import { reapWithParent } from "../../rig/reap"
import type { RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "../e2e/steps"

const READY_TIMEOUT_MS = 90_000
const PAGE_URL = /^http:\/\/[a-z0-9-]+\.localhost:\d+\/$/m
const SETUP_LINE = `You're on SSH and no laptop is connected. On your laptop run: iter8 setup ${hostname()}`

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(
    async (response) => {
      await response.body?.cancel()
      return true
    },
    () => false,
  )

function startRun(service: RunningService, port: number) {
  const cli = Bun.spawn([...(service.env.command ?? cliCommand()), "run", "--port", String(port)], {
    cwd: fixtureDir("vite-react"),
    env: { ...childEnv(service.env), SSH_CONNECTION: "test" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  reapWithParent(cli)
  let output = ""
  const decoder = new TextDecoder()
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true })
  }
  void drain(cli.stdout)
  void drain(cli.stderr)
  return { cli, output: () => output }
}

type Run = ReturnType<typeof startRun>

async function pageUrl(run: Run, port: number): Promise<string> {
  await waitFor(
    "run to print the page URL and the SSH instruction",
    async () => {
      if (run.cli.exitCode !== null) throw new Error(`iter8 run exited early:\n${run.output()}`)
      return run.output().includes(SETUP_LINE) ? true : null
    },
    { timeoutMs: READY_TIMEOUT_MS, everyMs: 100 },
  )
  expect(run.output()).toStartWith(
    `Starting bun run dev --port ${port} --strictPort on port ${port}…\n`,
  )
  const url = run.output().match(PAGE_URL)?.[0]
  if (url === undefined) throw new Error(`no page URL in:\n${run.output()}`)
  expect(run.output()).toContain(`\n${url}\n${SETUP_LINE}\n`)
  return url
}

async function runRecords(home: string): Promise<string[]> {
  const names = await readdir(join(home, "run")).catch(() => [])
  return names.filter((name) => name.endsWith(".pid"))
}

/** Kills any dev server group a failed test left recorded, before the service removes its home. */
async function killRecordedGroups(home: string): Promise<void> {
  for (const name of await runRecords(home)) {
    const record: unknown = JSON.parse(await readFile(join(home, "run", name), "utf8"))
    const pgid = typeof record === "object" && record !== null && "pgid" in record ? record.pgid : 0
    if (typeof pgid === "number" && pgid > 0) {
      try {
        process.kill(-pgid, "SIGKILL")
      } catch {}
    }
  }
}

async function stopRun(run: Run | undefined): Promise<void> {
  if (run !== undefined && run.cli.exitCode === null) {
    run.cli.kill("SIGINT")
    await run.cli.exited
  }
}

test("iter8 run starts the Vite app behind a page that loads the overlay, and Ctrl-C stops the server", async () => {
  let service: RunningService | undefined
  let browser: Browser | undefined
  let run: Run | undefined
  try {
    service = await startBuiltService()
    const port = await nextPort()
    run = startRun(service, port)
    const url = await pageUrl(run, port)
    expect(await answers(port)).toBe(true)
    expect(await runRecords(service.home)).toHaveLength(1)

    browser = await launchChromium()
    const { page, errors, close } = await newPage(browser)
    try {
      await page.goto(url)
      await waitFor(
        "the overlay to mount with a shadow root",
        () =>
          page.evaluate(() => (document.querySelector("iter8-overlay")?.shadowRoot ? true : null)),
        { timeoutMs: 30_000, everyMs: 100 },
      )
      await page.getByText("Card in vite-react").waitFor()
      expect(errors).toEqual([])
    } finally {
      await close()
    }

    run.cli.kill("SIGINT")
    expect(await run.cli.exited).toBe(130)
    expect(await answers(port)).toBe(false)
    expect(await runRecords(service.home)).toEqual([])
  } catch (error) {
    throw new Error(`${(error as Error).message}\niter8 run output:\n${run?.output()}`, {
      cause: error,
    })
  } finally {
    await stopRun(run)
    if (service !== undefined) await killRecordedGroups(service.home)
    await browser?.close()
    await service?.stop()
  }
}, 180_000)

test("after the CLI is SIGKILLed, the next run stops the orphaned server and keeps the port and the page; SIGHUP stops it", async () => {
  let service: RunningService | undefined
  let first: Run | undefined
  let second: Run | undefined
  try {
    service = await startBuiltService()
    const port = await nextPort()
    first = startRun(service, port)
    const firstUrl = await pageUrl(first, port)

    first.cli.kill("SIGKILL")
    await first.cli.exited
    expect(await answers(port)).toBe(true)

    second = startRun(service, port)
    expect(await pageUrl(second, port)).toBe(firstUrl)
    expect(await answers(port)).toBe(true)

    second.cli.kill("SIGHUP")
    expect(await second.cli.exited).toBe(129)
    expect(await answers(port)).toBe(false)
    expect(await runRecords(service.home)).toEqual([])
  } catch (error) {
    throw new Error(
      `${(error as Error).message}\nfirst run output:\n${first?.output()}\nsecond run output:\n${second?.output()}`,
      { cause: error },
    )
  } finally {
    await stopRun(second)
    if (service !== undefined) await killRecordedGroups(service.home)
    await service?.stop()
  }
}, 180_000)
