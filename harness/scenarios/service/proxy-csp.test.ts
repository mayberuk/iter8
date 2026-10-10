import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import type { Browser, Page } from "playwright"
import { type AgentSession, startAgentSession } from "../../rig/agent"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { nextPort } from "../../rig/ports"
import type { Scratch } from "../../rig/scratch"
import { openThroughProxy, type RunningService, startService } from "../../rig/service"
import { waitFor } from "../../rig/wait"
import { type Iter8Probe, PROBE_GLOBAL } from "../../stubs/probe-overlay"

const PROBE_ENTRY = Bun.fileURLToPath(new URL("../../stubs/probe-overlay.ts", import.meta.url))
const OWN_GLOBAL = "pageOwnScriptRan"

let bundle: Scratch
let service: RunningService
let session: AgentSession
let browser: Browser
let upstream: ReturnType<typeof Bun.serve> | null = null

beforeAll(async () => {
  bundle = await buildBrowserBundle(PROBE_ENTRY)
  try {
    service = await startService({ overlayDir: bundle.path })
    session = await startAgentSession(service)
    browser = await launchChromium()
  } catch (error) {
    await teardown()
    throw error
  }
}, 120_000)

async function teardown() {
  await browser?.close()
  await session?.exit()
  await service?.stop()
  await bundle?.dispose()
}

afterAll(teardown)

afterEach(async () => {
  await upstream?.stop(true)
  upstream = null
})

async function serve(html: string, headers: Record<string, string> = {}): Promise<string> {
  const port = await nextPort()
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => new Response(html, { headers: { "content-type": "text/html", ...headers } }),
  })
  return `http://127.0.0.1:${port}`
}

const page = (head: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>csp</title>${head}</head><body>${body}</body></html>`

const acceptedHello = (target: Page) =>
  waitFor("the probe's hello", () =>
    target.evaluate((global) => {
      const hello = (Reflect.get(window, global) as Iter8Probe | undefined)?.hello
      return hello?.outcome === "accepted" ? hello : null
    }, PROBE_GLOBAL),
  )

const violations = (errors: string[]) =>
  errors.filter((message) => /content security policy|refused to/i.test(message))

async function openAndMount(
  origin: string,
): Promise<{ errors: string[]; page: Page; close: () => Promise<void> }> {
  const opened = await newPage(browser)
  try {
    await openThroughProxy(service, opened.page, origin, { session })
    await acceptedHello(opened.page)
    return opened
  } catch (error) {
    await opened.close()
    throw error
  }
}

test("a strict nonce CSP header lets the overlay mount", async () => {
  const origin = await serve(page("", "<p>nonce page</p>"), {
    "content-security-policy": "script-src 'nonce-x' 'strict-dynamic'",
  })
  const { errors, close } = await openAndMount(origin)
  try {
    expect(violations(errors)).toEqual([])
  } finally {
    await close()
  }
}, 60_000)

test("a self-only CSP in a meta tag lets the overlay mount", async () => {
  const origin = await serve(
    page(
      `<meta http-equiv="Content-Security-Policy" content="script-src 'self'">`,
      "<p>meta page</p>",
    ),
  )
  const { errors, close } = await openAndMount(origin)
  try {
    expect(violations(errors)).toEqual([])
  } finally {
    await close()
  }
}, 60_000)

test("an unsafe-inline CSP keeps the page's own inline script running beside the overlay", async () => {
  const origin = await serve(
    page("", `<p>inline page</p><script>window.${OWN_GLOBAL} = "ran"</script>`),
    { "content-security-policy": "script-src 'self' 'unsafe-inline'" },
  )
  const { page: opened, errors, close } = await openAndMount(origin)
  try {
    expect(violations(errors)).toEqual([])
    expect(await opened.evaluate((name) => Reflect.get(window, name), OWN_GLOBAL)).toBe("ran")
  } finally {
    await close()
  }
}, 60_000)

test("a stopped upstream shows the iter8 failure page naming it", async () => {
  const origin = await serve(page("", "<p>about to go</p>"))
  const { page: opened, close } = await newPage(browser)
  try {
    const { open } = await openThroughProxy(service, opened, origin, { session })
    await upstream?.stop(true)
    upstream = null

    const response = await opened.goto(open.url)
    expect(response?.status()).toBe(502)
    expect(await opened.title()).toStartWith("iter8:")
    expect(await opened.locator("body").innerText()).toContain(origin)
  } finally {
    await close()
  }
}, 60_000)
