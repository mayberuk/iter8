import { cp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Browser, Locator, Page } from "playwright"
import { buildOverlayBundles } from "../../../scripts/build"
import { newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { WORKER } from "../../rig/ports"
import { type Scratch, scratchDir } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import {
  type MockService,
  type MockServiceOptions,
  startMockService,
} from "../../stubs/mock-service"

/** Builds the real overlay bundle, fonts included, into a fresh directory. */
export async function buildOverlay(): Promise<Scratch> {
  const scratch = await scratchDir(`/tmp/iter8-w${WORKER}-overlay-`)
  try {
    await buildOverlayBundles({ outDir: scratch.path })
  } catch (error) {
    await scratch.dispose()
    throw error
  }
  return scratch
}

/** Copies an overlay build and gives it no source bundle, or the fake one from `fake-source.ts`. */
export async function withSourceBundle(
  overlay: Scratch,
  bundle: "none" | "fake",
): Promise<Scratch> {
  const scratch = await scratchDir(`/tmp/iter8-w${WORKER}-overlay-source-`)
  try {
    await cp(overlay.path, scratch.path, { recursive: true })
    const source = join(scratch.path, "source.js")
    await rm(source, { force: true })
    if (bundle === "fake") {
      const fake = await buildBrowserBundle(join(import.meta.dir, "fake-source.ts"))
      try {
        await cp(join(fake.path, "overlay.js"), source)
      } finally {
        await fake.dispose()
      }
    }
  } catch (error) {
    await scratch.dispose()
    throw error
  }
  return scratch
}

export async function openOverlay(opts: {
  overlayDir: string
  folder: string
  path?: string
  mock?: Omit<MockServiceOptions, "folder" | "overlayDir">
  browser: Browser
}): Promise<{
  page: Page
  errors: string[]
  mock: MockService
  overlay: Locator
  close: () => Promise<void>
}> {
  const mock = await startMockService({
    ...opts.mock,
    folder: opts.folder,
    overlayDir: opts.overlayDir,
  })
  const opened = await newPage(opts.browser).catch(async (error) => {
    await mock.stop()
    throw error
  })
  const close = async () => {
    await opened.close()
    await mock.stop()
  }
  try {
    await opened.page.goto(mock.pageUrl(opts.path))
    const overlay = opened.page.locator("iter8-overlay")
    const toolbar = overlay.getByRole("toolbar")
    await waitFor("the dock to show", async () => ((await toolbar.isVisible()) ? true : null), {
      timeoutMs: 10_000,
    })
    return { page: opened.page, errors: opened.errors, mock, overlay, close }
  } catch (error) {
    await close()
    throw error
  }
}
