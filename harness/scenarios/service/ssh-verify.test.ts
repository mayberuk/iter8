import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

let browser: Browser
let bundle: Scratch
let fixture: RunningFixture
let serviceA: RunningService
let serviceB: RunningService
let session: AgentSession

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url)),
  )
  fixture = await startFixture("static")
  serviceA = await startService({ overlayDir: bundle.path })
  serviceB = await startService({ overlayDir: bundle.path })
  session = await startAgentSession(serviceA)
  browser = await launchChromium()
}, 90_000)

afterAll(async () => {
  await browser?.close()
  await session?.exit()
  await serviceB?.stop()
  await serviceA?.stop()
  await fixture?.stop()
  await bundle?.dispose()
})

const readHello = (page: Page) =>
  page.evaluate((global) => {
    const probe = Reflect.get(window, global) as Iter8Probe | undefined
    return probe?.hello ?? null
  }, PROBE_GLOBAL)

const landingStatus = (page: Page) =>
  page.evaluate(() => document.getElementById("status")?.textContent ?? null)

test("the landing page continues to the page when its own service answers and stops when another iter8 service does", async () => {
  const opener = await newPage(browser)
  const visitor = await newPage(browser)
  try {
    const { open } = await openThroughProxy(serviceA, opener.page, fixture.url(), { session })

    await visitor.page.goto(open.landingUrl)
    await waitFor("the landing page to continue to the page", async () =>
      visitor.page.url() === new URL(open.url).href ? true : null,
    )
    const hello = await waitFor("the probe's hello", () => readHello(visitor.page))
    expect(hello.outcome).toBe("accepted")

    const landing = new URL(open.landingUrl)
    const otherPort = serviceB.status.pool[0]
    if (otherPort === undefined) throw new Error("the second service bound no pool port")
    expect(serviceA.status.pool).not.toContain(otherPort)
    landing.port = String(otherPort)

    const refused = await newPage(browser)
    try {
      await refused.page.goto(landing.href)
      const message = await waitFor("the landing page's verdict", async () => {
        const text = await landingStatus(refused.page)
        return text?.startsWith("Port ") ? text : null
      })
      expect(message).toContain(
        `Port ${otherPort} on this computer is not the iter8 service that opened this page`,
      )
      expect(new URL(refused.page.url()).port).toBe(String(otherPort))
    } finally {
      await refused.close()
    }
  } finally {
    await visitor.close()
    await opener.close()
  }
}, 90_000)
