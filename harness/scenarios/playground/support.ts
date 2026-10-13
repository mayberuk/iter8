import { OpenResult, type OwnerId, ServiceStatus } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { startFixture } from "../../rig/fixtures"
import type { RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { startBuiltService } from "../e2e/steps"

const MOUNT_TIMEOUT_MS = 30_000

async function teardown(steps: (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = []
  for (const step of steps.reverse()) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "teardown failed")
}

export type Rig = { page: Page; errors: string[]; service: RunningService; owner: OwnerId }

export async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const cleanups: (() => Promise<unknown>)[] = []
  try {
    const service = await startBuiltService()
    cleanups.push(() => service.stop())
    const session = await startAgentSession(service)
    // `hook end` against a stopped service starts a fresh detached service, so the session leaves first.
    cleanups.push(() => session.exit())
    const browser: Browser = await launchChromium()
    cleanups.push(() => browser.close())
    const opened = await newPage(browser)
    cleanups.push(opened.close)
    const owner = (await session.run(["status", "--json"])).json(ServiceStatus).owner
    if (owner === null) throw new Error("the stub session is not paired")
    await run({ page: opened.page, errors: opened.errors, service, owner: owner.owner })
  } finally {
    await teardown(cleanups)
  }
}

export async function withPlayground(
  run: (rig: Rig & { open: OpenResult }) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture("playground")
  try {
    await withRig(async (rig) => {
      const open = (
        await rig.service.cli(["open", fixture.url(), "--json", "--owner", rig.owner])
      ).json(OpenResult)
      await run({ ...rig, open })
    })
  } finally {
    await fixture.stop()
  }
}

export async function visit(page: Page, open: OpenResult, route: string, scrollY = 0) {
  await page.goto(new URL(route, open.url).href)
  await waitFor(
    `the overlay to mount on ${route}`,
    () => page.evaluate(() => (document.querySelector("iter8-overlay")?.shadowRoot ? true : null)),
    { timeoutMs: MOUNT_TIMEOUT_MS, everyMs: 100 },
  )
  await page.waitForTimeout(1000)
  await page.evaluate((y) => scrollTo(0, y), scrollY)
  await waitFor(
    "the scroll position",
    () => page.evaluate((y) => (window.scrollY === y ? true : null), scrollY),
    { timeoutMs: 5000 },
  )
}
