import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp } from "node:fs/promises"
import { join } from "node:path"
import { Note, OVERLAY_ROUTES, ServiceStatus, TOKEN_HEADER } from "@iter8/protocol"
import type { Locator, Page } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { childEnv } from "../../rig/cli"
import { fixtureDir } from "../../rig/fixtures"
import { reapWithParent } from "../../rig/reap"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { pickAndNote, startBuiltService } from "../e2e/steps"

const UI_TIMEOUT_MS = 10_000
const RESTART_TIMEOUT_MS = 30_000
const TERM_GRACE_MS = 5_000

async function teardown(steps: (() => Promise<unknown> | undefined)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

const appears = (label: string, locator: Locator, timeoutMs = UI_TIMEOUT_MS) =>
  waitFor(label, async () => ((await locator.count()) > 0 ? true : null), { timeoutMs })

const disappears = (label: string, locator: Locator, timeoutMs = UI_TIMEOUT_MS) =>
  waitFor(label, async () => ((await locator.count()) === 0 ? true : null), { timeoutMs })

async function storedDrafts(page: Page, token: string): Promise<Note[]> {
  const listed = await page.evaluate(
    async ([path, header, value]) => (await fetch(path, { headers: { [header]: value } })).json(),
    [OVERLAY_ROUTES.listDrafts.path, TOKEN_HEADER, token] as const,
  )
  return Note.array().parse(listed)
}

async function restart(service: RunningService): Promise<Bun.Subprocess> {
  const child = Bun.spawn([...(service.env.command ?? []), "serve"], {
    cwd: service.home,
    env: childEnv(service.env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  reapWithParent(child)
  await waitFor(
    "the restarted service to report ready",
    async () => {
      if (child.exitCode !== null) throw new Error(`serve exited with code ${child.exitCode}`)
      const run = await service.cli(["status", "--json"])
      if (run.exitCode !== 0) return null
      const status = ServiceStatus.safeParse(JSON.parse(run.stdout))
      return status.success && status.data.state === "ready" ? true : null
    },
    { timeoutMs: RESTART_TIMEOUT_MS, everyMs: 100 },
  )
  return child
}

async function stopChild(child: Bun.Subprocess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const grace = Bun.sleep(TERM_GRACE_MS).then(() => "grace-passed" as const)
  if ((await Promise.race([child.exited, grace])) === "grace-passed") child.kill("SIGKILL")
  await child.exited
}

test("a draft edited while the service is down is saved when it returns, and shows after a reload", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  let service: RunningService | undefined
  try {
    service = await startBuiltService()
    const running = service

    const copy = await scratchDir(`${SCRATCH_ROOT}overlay-draft-restart-`)
    disposers.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })

    const browser = await launchChromium()
    disposers.push(() => browser.close())
    const opened = await newPage(browser)
    disposers.push(opened.close)
    const { page } = opened

    const session = await startAgentSession(running)
    disposers.push(() => session.exit())

    const { token } = await openThroughProxy(running, page, copy.path, { session })

    const original = `Original wording ${crypto.randomUUID()}`
    const edited = `Edited while the service was down ${crypto.randomUUID()}`
    await pickAndNote(page, page.getByRole("heading", { name: "Overview" }), {
      intent: "fix",
      body: original,
    })
    expect((await storedDrafts(page, token)).map((note) => note.body)).toEqual([original])

    const control = join(running.home, "control.sock")
    const drained = await fetch("http://localhost/drain", { method: "POST", unix: control })
    expect(drained.ok).toBe(true)
    await waitFor(
      "the service to stop",
      async () => (existsSync(join(running.home, "service.lock")) ? null : true),
      {
        timeoutMs: UI_TIMEOUT_MS,
      },
    )

    await appears(
      "the dock to say the service is unreachable",
      page.getByText("Can't reach the iter8 service"),
    )

    await page.getByRole("button", { name: "Open round sheet" }).click()
    await page.getByRole("button", { name: "Edit note 1" }).click()
    const dialog = page.getByRole("dialog", { name: "Edit note" })
    await dialog.getByRole("textbox", { name: "Note" }).fill(edited)
    await dialog.getByRole("button", { name: "Update note" }).click()
    await disappears("the composer to close after the edit", dialog)

    const child = await restart(running)
    disposers.push(() => stopChild(child))

    await disappears(
      "the dock to stop saying the service is unreachable",
      page.getByText("Can't reach the iter8 service"),
      RESTART_TIMEOUT_MS,
    )
    await waitFor(
      "the service to hold the edited text",
      async () => ((await storedDrafts(page, token))[0]?.body === edited ? true : null),
      { timeoutMs: UI_TIMEOUT_MS },
    )

    await appears("the edited draft in the sheet before any reload", page.getByText(edited))
    expect(await page.getByText(original).count()).toBe(0)

    await page.reload()
    await page.getByRole("button", { name: "Open round sheet" }).click()
    await appears("the edited draft in the round sheet", page.getByText(edited))
    expect(await page.getByText(original).count()).toBe(0)
    expect((await storedDrafts(page, token)).map((note) => note.body)).toEqual([edited])
  } finally {
    await teardown([...disposers.reverse(), () => service?.stop()])
  }
}, 120_000)
