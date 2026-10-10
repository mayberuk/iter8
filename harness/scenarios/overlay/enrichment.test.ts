import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { type ResolvedSourceLead, Screenshot } from "@iter8/protocol"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import type { EnrichmentHarness, RunOptions, RunReport } from "./enrichment.entry"

const ORIGIN = "http://engine.localhost"
const FAKE_SOURCE_URL = `${ORIGIN}/fake-source.js`
const MISSING_SOURCE_URL = `${ORIGIN}/missing-source.js`
const MAX_SHOT_BYTES = 2 * 1024 * 1024
const LOOKUP_TIMEOUT_MS = 1500
const PROSE = "Lorem ipsum dolor sit amet, consectetur adipiscing."

const PAGE = `<!doctype html>
<html lang="en">
<head><title>enrichment</title></head>
<body>
  <div id="shot" style="width: 320px; height: 160px; background: #3a6">Shot</div>
  <div id="frame" style="width: 320px; height: 160px; background: #36a"><p id="framed">Framed</p></div>
  <nav aria-label="Primary"><ul><li><a id="home" href="#" style="letter-spacing: 3px">Home</a></li></ul></nav>
  <section aria-labelledby="pricing-title"><h2 id="pricing-title">Pricing plans</h2><p id="price">From $9</p></section>
  <main><div id="host"></div></main>
  <article data-fake-src><h3 id="card-title">Card</h3><p id="doomed">Going away</p></article>
  <aside data-fake-slow><p id="slow">Slow lookup</p></aside>
  <div id="crowd">${"<span>.</span>".repeat(399)}</div>
  <div id="shadow-crowd"></div>
  <div id="long">${`<p>${PROSE}</p>`.repeat(300)}<span id="in-long">end</span></div>
  <script>
    document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
      '<button id="deep">Deep</button>'
    document.getElementById("shadow-crowd").attachShadow({ mode: "open" }).innerHTML =
      "<span>.</span>".repeat(399)
  </script>
  <script type="module" src="/enrich.js"></script>
</body>
</html>`

let browser: Browser
let entry: Scratch
let fakeSource: Scratch
const openPages: (() => Promise<void>)[] = []

beforeAll(async () => {
  entry = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("./enrichment.entry.ts", import.meta.url)),
  )
  fakeSource = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("./fake-source.ts", import.meta.url)),
  )
  browser = await launchChromium()
})

afterEach(async () => {
  await Promise.all(openPages.splice(0).map((close) => close()))
})

afterAll(async () => {
  await browser?.close()
  await entry?.dispose()
  await fakeSource?.dispose()
})

async function openEngine(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors, close } = await newPage(browser)
  openPages.push(close)
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === "/") return route.fulfill({ body: PAGE, contentType: "text/html" })
    if (path === "/enrich.js") {
      return route.fulfill({ path: `${entry.path}/overlay.js`, contentType: "text/javascript" })
    }
    if (path === "/fake-source.js") {
      return route.fulfill({
        path: `${fakeSource.path}/overlay.js`,
        contentType: "text/javascript",
      })
    }
    return route.fulfill({ status: 404, body: "not found", contentType: "text/plain" })
  })
  await page.goto(`${ORIGIN}/`)
  await waitFor("the enrichment harness", () =>
    page.evaluate(() => (Reflect.has(window, "__iter8Enrich") ? true : null)),
  )
  return { page, errors }
}

function harness(page: Page) {
  return {
    run: (options: RunOptions): Promise<RunReport> =>
      page.evaluate(
        (options) => (Reflect.get(window, "__iter8Enrich") as EnrichmentHarness).run(options),
        options,
      ),
    describeContext: (path: string[]) =>
      page.evaluate(
        (path) => (Reflect.get(window, "__iter8Enrich") as EnrichmentHarness).describeContext(path),
        path,
      ),
    errors: (call: "startErrors" | "disposeErrors") =>
      page.evaluate(
        (call) => (Reflect.get(window, "__iter8Enrich") as EnrichmentHarness)[call](),
        call,
      ),
    recentErrors: () =>
      page.evaluate(() =>
        (Reflect.get(window, "__iter8Enrich") as EnrichmentHarness).recentErrors(),
      ),
  }
}

function resolved(report: RunReport) {
  if (report.result.outcome !== "resolved") {
    throw new Error(`enrich rejected with ${Bun.inspect(report.result.reason)}`)
  }
  return report.result.capture
}

test("the capture reports only the styles the target sets apart from its parent, and the page it was taken on", async () => {
  const { page } = await openEngine()
  const capture = resolved(
    await harness(page).run({ selector: "#home", sourceUrl: null, shot: false }),
  )

  expect(capture.computedStyles?.["letter-spacing"]).toBe("3px")
  expect(capture.computedStyles).not.toHaveProperty("font-family")
  expect(capture.completeness).toBe("complete")
  expect(capture.omittedParts).toEqual([])
  expect(capture.url).toBe(`${ORIGIN}/`)
  expect(capture.theme).toBe("light")
  expect(capture.viewport).toEqual({ width: 1280, height: 720, devicePixelRatio: 1 })
}, 30_000)

test("the landmark is named by role and accessible name, across a shadow root, and left out when there is none", async () => {
  const { page } = await openEngine()
  const engine = harness(page)

  expect((await engine.describeContext(["#home"])).landmark).toBe("navigation · Primary")
  expect((await engine.describeContext(["#price"])).landmark).toBe("region · Pricing plans")
  expect((await engine.describeContext(["#host", "#deep"])).landmark).toBe("main")
  expect(await engine.describeContext(["#in-long"])).not.toHaveProperty("landmark")
}, 30_000)

test("surrounding text stops at 600 characters however much text the parent holds", async () => {
  const { page } = await openEngine()
  const { surroundingText } = await harness(page).describeContext(["#in-long"])

  expect(surroundingText?.startsWith(PROSE)).toBe(true)
  expect(surroundingText?.length).toBeLessThanOrEqual(600)
}, 30_000)

test("a page error thrown after the buffer starts reaches the capture, and none is collected after dispose", async () => {
  const { page, errors } = await openEngine()
  const engine = harness(page)
  await engine.errors("startErrors")
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("thrown after mount")
    })
    void Promise.reject(new Error("rejected after mount"))
  })
  await waitFor("both errors in the buffer", async () =>
    (await engine.recentErrors()).length === 2 ? true : null,
  )

  const capture = resolved(await engine.run({ selector: "#home", sourceUrl: null, shot: false }))
  expect(capture.consoleErrors).toEqual([
    expect.objectContaining({ message: expect.stringContaining("thrown after mount") }),
    expect.objectContaining({ message: "rejected after mount" }),
  ])
  for (const entry of capture.consoleErrors ?? []) {
    expect(new Date(entry.at).toISOString()).toBe(entry.at)
  }

  await engine.errors("disposeErrors")
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("thrown after dispose")
    })
  })
  await waitFor("the page to report the error thrown after dispose", async () =>
    errors.some((message) => message.includes("thrown after dispose")) ? true : null,
  )
  expect((await engine.recentErrors()).map(({ message }) => message)).toEqual([
    expect.stringContaining("thrown after mount"),
    "rejected after mount",
  ])
}, 30_000)

test("a source bundle that fails to load gives a not-loaded lead without symbolicating", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#card-title",
    sourceUrl: MISSING_SOURCE_URL,
    shot: false,
  })

  expect(resolved(report).sourceLead).toEqual({ confidence: "none", reason: "not-loaded" })
  expect(resolved(report).completeness).toBe("complete")
  expect(report.symbolicated).toEqual([])
}, 30_000)

test("the bundle's lead is handed to symbolicate and only the resolved lead is stored", async () => {
  const { page } = await openEngine()
  const lead: ResolvedSourceLead = {
    confidence: "approximate",
    framework: "react",
    component: "Card",
    file: "src/components/Card.jsx",
    line: 4,
  }
  const report = await harness(page).run({
    selector: "#card-title",
    sourceUrl: FAKE_SOURCE_URL,
    resolved: lead,
    shot: false,
  })

  expect(report.symbolicated).toEqual([
    {
      confidence: "exact",
      framework: "react",
      build: "vite",
      component: "Card",
      frames: [{ kind: "source", file: "src/Card.jsx", line: 3 }],
    },
  ])
  expect(resolved(report).sourceLead).toEqual(lead)
}, 30_000)

test("a target removed mid-run gives a stale capture with no screenshot", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#doomed",
    sourceUrl: FAKE_SOURCE_URL,
    shot: true,
    removeTargetOnSymbolicate: true,
  })

  expect(resolved(report).completeness).toBe("stale")
  expect(resolved(report)).not.toHaveProperty("screenshot")
  expect(report.uploads).toEqual([])
}, 30_000)

test("a target removed while the screenshot renders gives a stale capture with no upload", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#framed",
    sourceUrl: null,
    shot: true,
    removeTargetOnRender: true,
  })

  expect(report.removals).toEqual(["render"])
  expect(resolved(report).completeness).toBe("stale")
  expect(resolved(report)).not.toHaveProperty("screenshot")
  expect(report.uploads).toEqual([])
}, 30_000)

test("a target removed while the screenshot uploads gives a stale capture without that screenshot", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#framed",
    sourceUrl: null,
    shot: true,
    removeTargetOnUpload: true,
  })

  expect(report.removals).toEqual(["upload"])
  expect(report.uploads).toHaveLength(1)
  expect(resolved(report).completeness).toBe("stale")
  expect(resolved(report)).not.toHaveProperty("screenshot")
}, 30_000)

test("an abort stops the run before the screenshot", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#shot",
    sourceUrl: null,
    shot: true,
    abortWhenIdleIsRead: true,
  })

  expect(report.result).toEqual({ outcome: "rejected", reason: "cancelled while waiting for idle" })
  expect(report.uploads).toEqual([])
}, 30_000)

test("aborting the caller's signal during a pending lookup is cancellation, not a failed lead", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#slow",
    sourceUrl: FAKE_SOURCE_URL,
    shot: true,
    abortAfterMs: 100,
  })

  expect(report.result).toEqual({ outcome: "rejected", reason: "cancelled by the test" })
  expect(report.elapsedMs).toBeLessThan(LOOKUP_TIMEOUT_MS)
  expect(report.symbolicated).toEqual([])
  expect(report.uploads).toEqual([])
}, 30_000)

test("a lookup still pending at the timeout, with the caller's signal live, gives a not-loaded lead", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#slow",
    sourceUrl: FAKE_SOURCE_URL,
    shot: false,
  })

  expect(resolved(report).sourceLead).toEqual({ confidence: "none", reason: "not-loaded" })
  expect(resolved(report).completeness).toBe("complete")
  expect(report.elapsedMs).toBeGreaterThanOrEqual(LOOKUP_TIMEOUT_MS)
  expect(report.symbolicated).toEqual([])
}, 30_000)

test("a target of 400 nodes omits the screenshot and marks the capture partial", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({ selector: "#crowd", sourceUrl: null, shot: true })

  expect(resolved(report).completeness).toBe("partial")
  expect(resolved(report).omittedParts).toEqual(["screenshot"])
  expect(resolved(report)).not.toHaveProperty("screenshot")
  expect(report.uploads).toEqual([])
}, 30_000)

test("a target whose open shadow root holds 400 nodes omits the screenshot too", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({ selector: "#shadow-crowd", sourceUrl: null, shot: true })

  expect(resolved(report).completeness).toBe("partial")
  expect(resolved(report).omittedParts).toEqual(["screenshot"])
  expect(report.uploads).toEqual([])
}, 30_000)

test("the screenshot waits until 400 ms have passed without a keystroke", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({
    selector: "#shot",
    sourceUrl: null,
    shot: true,
    typedAtStart: true,
  })

  expect(report.idleReads[0]).toBeLessThan(400)
  expect(report.idleReads.at(-1)).toBeGreaterThanOrEqual(400)
  expect(report.uploads).toHaveLength(1)
  expect(report.uploads[0]?.atMs).toBeGreaterThanOrEqual(400)
}, 30_000)

test("a 320x160 target uploads a PNG under 2 MiB of exactly that size at device pixel ratio 1", async () => {
  const { page } = await openEngine()
  const report = await harness(page).run({ selector: "#shot", sourceUrl: null, shot: true })

  expect(report.uploads).toHaveLength(1)
  const [upload] = report.uploads
  expect(upload?.type).toBe("image/png")
  expect(upload?.size).toBeLessThan(MAX_SHOT_BYTES)
  expect(upload).toMatchObject({ width: 320, height: 160 })
  expect(resolved(report).screenshot).toEqual(
    Screenshot.parse({ ref: "shot-1", width: 320, height: 160 }),
  )
  expect(resolved(report).completeness).toBe("complete")
}, 30_000)
