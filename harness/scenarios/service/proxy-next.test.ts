import { afterAll, beforeAll, expect, test } from "bun:test"
import type { Browser, WebSocket } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const PROBE_ENTRY = Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url))
const CLIENT_TEXT = "Client in next-turbopack and next-webpack"

let bundle: Scratch
let service: RunningService
let session: AgentSession
let fixture: RunningFixture
let browser: Browser

beforeAll(async () => {
  bundle = await buildBrowserBundle(PROBE_ENTRY)
  try {
    service = await startService({ overlayDir: bundle.path })
    session = await startAgentSession(service)
    fixture = await startFixture("next-turbopack")
    browser = await launchChromium()
  } catch (error) {
    await teardown()
    throw error
  }
}, 240_000)

async function teardown() {
  await browser?.close()
  await fixture?.stop()
  await session?.exit()
  await service?.stop()
  await bundle?.dispose()
}

afterAll(teardown)

test("the Next Turbopack fixture loads through the service with the overlay mounted and its HMR socket open", async () => {
  const { page, errors, close } = await newPage(browser)
  try {
    const sockets: WebSocket[] = []
    page.on("websocket", (socket) => sockets.push(socket))

    const { open } = await openThroughProxy(service, page, fixture.origin, { session })
    expect(new URL(page.url()).hostname).toBe(`${open.page.id}.localhost`)

    await page.getByText(CLIENT_TEXT).waitFor()
    await waitFor("the probe's hello", () =>
      page.evaluate((global) => {
        const hello = (Reflect.get(window, global) as Iter8Probe | undefined)?.hello
        return hello?.outcome === "accepted" ? hello : null
      }, PROBE_GLOBAL),
    )
    await waitFor("Next's HMR socket to be open", async () =>
      sockets.some((socket) => new URL(socket.url()).pathname.includes("hmr") && !socket.isClosed())
        ? true
        : null,
    )

    expect(errors.filter((message) => /hmr|origin|websocket|blocked/i.test(message))).toEqual([])
  } finally {
    await close()
  }
}, 180_000)
