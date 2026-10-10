import {
  LandingFragment,
  OpenResult,
  OVERLAY_ROUTES,
  type PageToken,
  ResolvedSourceLead,
  SOURCE_BUNDLE_PATH,
  SourceLead,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import type { lookupSource } from "../../../packages/source/src/index"
import { buildOverlayBundles } from "../../../scripts/build"
import { launchChromium, newPage } from "../../rig/browser"
import { type FixtureName, fixtureDir, type RunningFixture } from "../../rig/fixtures"
import { WORKER } from "../../rig/ports"
import { scratchDir } from "../../rig/scratch"
import { type RunningService, startService } from "../../rig/service"

export type LookupView = { page: Page; token: PageToken; close(): Promise<void> }

/**
 * Serves the real overlay and source bundles. Pages open from the fixture's own directory, so
 * the service resolves paths against the fixture as its project root.
 */
export async function startSourceRig(
  steps: {
    build: typeof buildOverlayBundles
    start: typeof startService
    launch: typeof launchChromium
  } = { build: buildOverlayBundles, start: startService, launch: launchChromium },
): Promise<{
  open(fixture: RunningFixture, path?: string): Promise<LookupView>
  /** Runs `iter8 open <folder>` from `cwd`, so the folder is the project root only when `cwd` holds it. */
  openFolder(folder: string, options: { cwd: string; path?: string }): Promise<LookupView>
  stop(): Promise<void>
}> {
  const bundles = await scratchDir(`/tmp/iter8-w${WORKER}-source-bundles-`)
  let service: RunningService | undefined
  let browser: Browser
  try {
    await steps.build({ outDir: bundles.path })
    service = await steps.start({ overlayDir: bundles.path })
    browser = await steps.launch()
  } catch (error) {
    try {
      await service?.stop()
    } finally {
      await bundles.dispose()
    }
    throw error
  }
  const running = service

  const open = async (fixture: RunningFixture, path?: string): Promise<LookupView> => {
    const run = await running.cli(["open", fixture.origin, "--json"], { cwd: fixture.dir })
    if (run.exitCode !== 0) {
      throw new Error(`open ${fixture.origin} exited ${run.exitCode}:\n${run.stdout}${run.stderr}`)
    }
    const opened = run.json(OpenResult)
    const fragment = new URLSearchParams(new URL(opened.landingUrl).hash.slice(1))
    const { t: token } = LandingFragment.parse(Object.fromEntries(fragment))
    const { page, close } = await newPage(browser)
    try {
      await page.goto(new URL(path ?? "/", opened.url).href)
    } catch (error) {
      await close()
      throw error
    }
    return { page, token, close }
  }

  const openFolder = async (
    folder: string,
    options: { cwd: string; path?: string },
  ): Promise<LookupView> => {
    const run = await running.cli(["open", folder, "--json"], { cwd: options.cwd })
    if (run.exitCode !== 0) {
      throw new Error(`open ${folder} exited ${run.exitCode}:\n${run.stdout}${run.stderr}`)
    }
    const opened = run.json(OpenResult)
    const fragment = new URLSearchParams(new URL(opened.landingUrl).hash.slice(1))
    const { t: token } = LandingFragment.parse(Object.fromEntries(fragment))
    const { page, close } = await newPage(browser)
    try {
      await page.goto(new URL(options.path ?? "/", opened.url).href)
    } catch (error) {
      await close()
      throw error
    }
    return { page, token, close }
  }

  const stop = async () => {
    try {
      await browser.close()
    } finally {
      try {
        await running.stop()
      } finally {
        await bundles.dispose()
      }
    }
  }

  return { open, openFolder, stop }
}

/**
 * Imports the served source bundle into the page and looks up the first element `selector`
 * matches, in the open shadow root of the first element `within` matches when it is given.
 */
export async function lookupInPage(
  view: LookupView,
  selector: string,
  options: { abortAfterMs?: number; within?: string } = {},
): Promise<SourceLead | { rejected: string }> {
  const outcome = await view.page.evaluate(
    async ({ bundlePath, selector, abortAfterMs, within }) => {
      const bundle: { lookupSource: typeof lookupSource } = await import(
        new URL(bundlePath, location.origin).href
      )
      const scope = within === undefined ? document : document.querySelector(within)?.shadowRoot
      const element = scope?.querySelector(selector) ?? null
      if (element === null) throw new Error(`No element matches ${selector}`)
      const controller = new AbortController()
      const timer =
        abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), abortAfterMs)
      try {
        return { lead: await bundle.lookupSource(element, controller.signal) }
      } catch (error) {
        return { rejected: error instanceof Error ? error.name : String(error) }
      } finally {
        clearTimeout(timer)
      }
    },
    {
      bundlePath: SOURCE_BUNDLE_PATH,
      selector,
      abortAfterMs: options.abortAfterMs,
      within: options.within,
    },
  )
  return "rejected" in outcome ? { rejected: outcome.rejected } : SourceLead.parse(outcome.lead)
}

export async function resolveInPage(
  view: LookupView,
  lead: SourceLead,
): Promise<ResolvedSourceLead> {
  const body = await view.page.evaluate(
    async ({ method, path, header, token, lead }) => {
      const response = await fetch(path, {
        method,
        headers: { [header]: token, "content-type": "application/json" },
        body: JSON.stringify(lead),
      })
      if (!response.ok)
        throw new Error(`${path} answered ${response.status}: ${await response.text()}`)
      return (await response.json()) as unknown
    },
    {
      method: OVERLAY_ROUTES.symbolicate.method,
      path: OVERLAY_ROUTES.symbolicate.path,
      header: TOKEN_HEADER,
      token: view.token,
      lead,
    },
  )
  return ResolvedSourceLead.parse(body)
}

const UNSCANNED = new Set(["node_modules", ".next", ".svelte-kit", ".astro", "dist"])
const SOURCE_FILES = new Bun.Glob("**/*.{html,js,jsx,ts,tsx,svelte,vue,astro}")

/** The one line in the fixture's sources that carries `data-source-target="<target>"`, 1-based. */
export async function expectedSite(
  fixture: FixtureName,
  target: string,
): Promise<{ file: string; line: number }> {
  const dir = fixtureDir(fixture)
  const marker = `data-source-target="${target}"`
  const sites: { file: string; line: number }[] = []
  for await (const file of SOURCE_FILES.scan({ cwd: dir })) {
    if (file.split("/").some((part) => UNSCANNED.has(part))) continue
    const lines = (await Bun.file(`${dir}/${file}`).text()).split("\n")
    lines.forEach((text, index) => {
      if (text.includes(marker)) sites.push({ file, line: index + 1 })
    })
  }
  const [site, ...others] = sites
  if (site === undefined || others.length > 0) {
    throw new Error(`${fixture} has ${sites.length} lines marked ${marker}, not one`)
  }
  return site
}
