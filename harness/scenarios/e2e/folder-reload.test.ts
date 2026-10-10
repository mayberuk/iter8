import { expect, test } from "bun:test"
import { cp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Locator } from "playwright"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, scratchDir } from "../../rig/scratch"
import { openThroughProxy, type RunningService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { pickAndNote, startBuiltService } from "./steps"

const UI_TIMEOUT_MS = 10_000

const PINS_BEFORE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>pins</title></head>
<body>
  <h1>Pins</h1>
  <main>
    <button type="button">Keep me</button>
    <button type="button">Drop me</button>
    <a href="/">Elsewhere</a>
    <p>Version one</p>
  </main>
</body>
</html>
`

const PINS_AFTER = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>pins</title></head>
<body>
  <h1>Pins</h1>
  <main>
    <button type="button">Keep me</button>
    <a href="/">Elsewhere</a>
    <p>Version two</p>
  </main>
</body>
</html>
`

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

const appears = (label: string, locator: Locator) =>
  waitFor(label, async () => ((await locator.count()) > 0 ? true : null), {
    timeoutMs: UI_TIMEOUT_MS,
  })

test("an edited mock reloads the open page, keeps both drafts and marks the one whose element is gone as moved", async () => {
  const disposers: (() => Promise<unknown>)[] = []
  let service: RunningService | undefined
  try {
    service = await startBuiltService()
    const running = service

    const copy = await scratchDir(`${SCRATCH_ROOT}e2e-folder-reload-`)
    disposers.push(copy.dispose)
    await cp(fixtureDir("static"), copy.path, { recursive: true })
    await writeFile(join(copy.path, "pins.html"), PINS_BEFORE)

    const browser = await launchChromium()
    disposers.push(() => browser.close())
    const opened = await newPage(browser)
    disposers.push(opened.close)
    const { page } = opened

    const session = await startAgentSession(running)
    disposers.push(() => session.exit())

    const { open } = await openThroughProxy(running, page, copy.path, { session })
    await page.goto(new URL("/pins.html", open.url).href)

    const keep = page.getByRole("button", { name: "Keep me", exact: true })
    const drop = page.getByRole("button", { name: "Drop me", exact: true })
    const keptBody = "Keep: this button needs more padding"
    const droppedBody = "Drop: this button should be a link"
    await pickAndNote(page, keep, { intent: "fix", body: keptBody })
    await pickAndNote(page, drop, { intent: "change", body: droppedBody })

    await writeFile(join(copy.path, "pins.html"), PINS_AFTER)

    await appears("the edited text to show with no manual reload", page.getByText("Version two"))
    await appears(
      "the removed element's note to be marked moved",
      page.getByRole("list", { name: "Moved notes" }),
    )

    const keptPin = page.getByRole("button", { name: /^Note \d+, / })
    await appears("the kept note's pin to appear", keptPin)
    await waitFor(
      "the kept note's pin to sit on its element",
      async () => {
        const [pinBox, keepBox] = [await keptPin.boundingBox(), await keep.boundingBox()]
        if (pinBox === null || keepBox === null) return null
        const dx = pinBox.x + pinBox.width / 2 - keepBox.x
        const dy = pinBox.y + pinBox.height / 2 - keepBox.y
        return Math.hypot(dx, dy) <= 6 ? true : null
      },
      { timeoutMs: UI_TIMEOUT_MS },
    )

    expect(await keptPin.count()).toBe(1)

    const moved = page.getByRole("list", { name: "Moved notes" })
    expect(await moved.getByText(droppedBody).count()).toBe(1)
    expect(await moved.getByText(keptBody).count()).toBe(0)
    expect(await moved.getByText("Moved", { exact: true }).count()).toBe(1)

    await page.getByRole("button", { name: "Open round sheet" }).click()
    const drafts = page.getByRole("list", { name: "Notes in this round" })
    await appears("the round sheet to list the drafts", drafts)
    expect(await drafts.getByText(keptBody).count()).toBe(1)
    expect(await drafts.getByText(droppedBody).count()).toBe(1)
  } finally {
    await teardown([() => service?.stop(), ...disposers.reverse()])
  }
}, 60_000)
