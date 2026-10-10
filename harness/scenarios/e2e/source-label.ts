import { expect } from "bun:test"
import { readdir } from "node:fs/promises"
import { extname, join, relative } from "node:path"
import { OpenResult, RoundsResult, ServiceStatus } from "@iter8/protocol"
import { startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { type FixtureName, fixtureDir, MANIFEST, startFixture } from "../../rig/fixtures"
import { waitFor } from "../../rig/wait"
import { sendRound, showRound, startBuiltService } from "./steps"

const LOOKUP_TIMEOUT_MS = 30_000
const UI_TIMEOUT_MS = 10_000
const SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".svelte",
  ".vue",
  ".astro",
])
const SKIPPED_DIRS = new Set(["node_modules", ".svelte-kit", ".astro", "dist"])
const skipped = (dir: string) => SKIPPED_DIRS.has(dir) || dir.startsWith(".next")

async function markerLines(dir: string, marker: string): Promise<{ file: string; line: number }[]> {
  const found: { file: string; line: number }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!skipped(entry.name)) found.push(...(await markerLines(path, marker)))
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      const lines = (await Bun.file(path).text()).split("\n")
      lines.forEach((text, index) => {
        if (text.includes(marker)) found.push({ file: path, line: index + 1 })
      })
    }
  }
  return found
}

async function expectedSite(
  name: FixtureName,
  target: string,
): Promise<{ file: string; line: number }> {
  const root = fixtureDir(name)
  const marker = `data-source-target="${target}"`
  const found = await markerLines(root, marker)
  const [only] = found
  if (found.length !== 1 || only === undefined) {
    throw new Error(`${name} has ${found.length} source lines marked ${marker}, expected one`)
  }
  return { file: relative(root, only.file), line: only.line }
}

export async function proveSourceLabels(name: FixtureName): Promise<void> {
  const entry = MANIFEST.find((candidate) => candidate.name === name)
  if (entry === undefined) throw new Error(`fixtures/manifest.json has no ${name} entry`)
  const sites = new Map(
    await Promise.all(
      entry.targets.map(async (target) => [target, await expectedSite(name, target)] as const),
    ),
  )

  const fixture = await startFixture(name)
  const cleanups: (() => Promise<unknown>)[] = []
  const failures: unknown[] = []
  try {
    const browser = await launchChromium()
    cleanups.push(() => browser.close())
    const service = await startBuiltService()
    cleanups.push(() => service.stop())
    const session = await startAgentSession(service)
    // `hook end` against a stopped service starts a fresh detached service, so the session leaves first.
    cleanups.unshift(() => session.exit())
    const { page } = await newPage(browser)
    const owner = (await session.run(["status", "--json"])).json(ServiceStatus).owner
    if (owner === null) throw new Error("the stub session is not paired")
    // Source paths resolve against open's cwd, so open runs where an agent in this project would.
    const opened = (
      await service.cli(["open", fixture.url(), "--json", "--owner", owner.owner], {
        cwd: fixture.dir,
      })
    ).json(OpenResult)
    await page.goto(opened.url, { waitUntil: "networkidle" })

    const chipLabels = new Map<string, string>()
    for (const target of entry.targets) {
      await page.getByRole("button", { name: "Pick element" }).click()
      await page.locator(`[data-source-target="${target}"]`).click()
      const composer = page.getByRole("dialog", { name: "New note" })
      const chip = composer.getByRole("status", { name: "Source confidence" })
      const label = await waitFor(
        `the source confidence label for ${target} on ${name}`,
        async () =>
          (await chip.count()) === 0 ? null : ((await chip.first().textContent()) ?? null),
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      )
      chipLabels.set(target, label.trim())
      const screenshot = composer.getByRole("img", { name: "Screenshot attached" })
      await waitFor(
        `the screenshot that ends enrichment for ${target} on ${name}`,
        async () => ((await screenshot.count()) > 0 ? true : null),
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      )
      await composer
        .getByRole("radiogroup", { name: "Intent" })
        .getByRole("radio", { name: "fix" })
        .check()
      await composer.getByRole("textbox", { name: "Note" }).fill(`source of ${target}`)
      await composer.getByRole("button", { name: "Save note" }).click()
      await waitFor(
        "the composer to close after saving",
        async () => ((await composer.count()) === 0 ? true : null),
        { timeoutMs: UI_TIMEOUT_MS },
      )
    }
    await sendRound(page)

    const listed = (await session.run(["rounds", "--json"])).json(RoundsResult)
    const [sent, ...others] = listed.rounds
    if (sent === undefined || others.length > 0) {
      throw new Error(`expected the one round just sent, found ${listed.rounds.length}`)
    }
    const shown = await showRound(session, sent.id)
    expect(shown.notes).toHaveLength(entry.targets.length)

    for (const target of entry.targets) {
      const note = shown.notes.find(
        (candidate) => candidate.authored.body === `source of ${target}`,
      )
      const lead = note?.untrustedCapture?.sourceLead
      if (lead === undefined) {
        throw new Error(
          `show returned no source lead for ${name} ${target}; capture: ${JSON.stringify(note?.untrustedCapture)}`,
        )
      }
      expect(lead).toMatchObject({ confidence: entry.confidence })
      expect(chipLabels.get(target)).toBe(lead.confidence)
      if (lead.confidence === "none") continue
      const site = sites.get(target)
      if (site === undefined) throw new Error(`no expected site for ${target}`)
      expect(lead.file === site.file || lead.file.endsWith(`/${site.file}`)).toBe(true)
      if (lead.confidence === "exact") expect(lead.line).toBe(site.line)
      else if (lead.confidence === "approximate") expect(lead.line).toBeDefined()
      else expect(lead.line).toBeUndefined()
    }
  } catch (error) {
    failures.push(error)
  } finally {
    for (const step of [...cleanups, () => fixture.stop()]) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, `${name} source label proof failed`)
}
