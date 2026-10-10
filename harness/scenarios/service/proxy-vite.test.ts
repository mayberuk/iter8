import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ResolvedSourceLead, type SourceLead } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { cliCommand } from "../../rig/cli"
import { fixtureDir, type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const PROBE_ENTRY = Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url))
const LITERAL = "Card in vite-react"

let bundle: Scratch
let service: RunningService
let session: AgentSession
let fixture: RunningFixture
let browser: Browser

beforeAll(async () => {
  bundle = await buildBrowserBundle(PROBE_ENTRY)
  try {
    service = await startService({ overlayDir: bundle.path })
    // The project root is the directory `open` runs in, so the agent session lives in the app.
    session = await startAgentSession(service, {
      cliCommand: [
        "sh",
        "-c",
        'cd "$0" && exec "$@"',
        fixtureDir("vite-react"),
        ...(service.env.command ?? cliCommand()),
      ],
    })
    fixture = await startFixture("vite-react")
    browser = await launchChromium()
  } catch (error) {
    await teardown()
    throw error
  }
}, 180_000)

async function teardown() {
  await browser?.close()
  await fixture?.stop()
  await session?.exit()
  await service?.stop()
  await bundle?.dispose()
}

afterAll(teardown)

const probeHello = (page: Page) =>
  page.evaluate(
    (global) => (Reflect.get(window, global) as Iter8Probe | undefined)?.hello ?? null,
    PROBE_GLOBAL,
  )

const mounted = (page: Page) =>
  waitFor("the probe's hello", async () => {
    const hello = await probeHello(page)
    return hello?.outcome === "accepted" ? hello : null
  })

test("the Vite and React fixture loads through the service with the overlay and HMR connected", async () => {
  const { page, errors, close } = await newPage(browser)
  try {
    const logs: string[] = []
    page.on("console", (message) => logs.push(message.text()))

    const { open } = await openThroughProxy(service, page, fixture.origin, { session })
    expect(new URL(page.url()).hostname).toBe(`${open.page.id}.localhost`)

    await mounted(page)
    await page.getByText(LITERAL).waitFor()
    await waitFor("Vite's HMR client to connect", async () =>
      logs.includes("[vite] connected.") ? true : null,
    )
    expect(errors).toEqual([])

    await page.evaluate(() => Reflect.set(window, "beforeReload", true))
    const reloaded = await page.reload()
    expect(reloaded?.status()).toBe(200)
    expect(await page.evaluate(() => Reflect.get(window, "beforeReload"))).toBeUndefined()
    await mounted(page)
    await page.getByText(LITERAL).waitFor()
  } finally {
    await close()
  }
}, 120_000)

test("symbolicating a generated frame of a Vite module returns the component's project file and line", async () => {
  const { page, close } = await newPage(browser)
  try {
    await openThroughProxy(service, page, fixture.origin, { session })
    await mounted(page)

    const moduleUrl = new URL("/src/Card.jsx", page.url()).href
    const text = await page.evaluate(
      (url) => fetch(url).then((response) => response.text()),
      moduleUrl,
    )
    const generated = text.split("\n")
    const generatedIndex = generated.findIndex((line) => line.includes(`"${LITERAL}"`))
    expect(generatedIndex).toBeGreaterThanOrEqual(0)
    const generatedLine = generated[generatedIndex] ?? ""

    const lead: SourceLead = {
      confidence: "exact",
      framework: "react",
      build: "vite",
      component: "Card",
      frames: [
        {
          kind: "generated",
          file: moduleUrl,
          line: generatedIndex + 1,
          column: generatedLine.indexOf(LITERAL) + 1,
        },
      ],
    }
    const reply = await page.evaluate(
      ([global, body]) =>
        (Reflect.get(window, global) as Iter8Probe).call("POST", "/__iter8/symbolicate", body),
      [PROBE_GLOBAL, lead] as const,
    )
    expect(reply.status).toBe(200)

    const source = (await readFile(join(fixtureDir("vite-react"), "src/Card.jsx"), "utf8")).split(
      "\n",
    )
    const sourceIndex = source.findIndex((line) => line.includes(LITERAL))
    expect(sourceIndex).toBeGreaterThanOrEqual(0)

    const resolved = ResolvedSourceLead.parse(reply.body)
    expect(resolved).toMatchObject({
      confidence: "exact",
      framework: "react",
      file: "src/Card.jsx",
      line: sourceIndex + 1,
    })
  } finally {
    await close()
  }
}, 120_000)
