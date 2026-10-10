import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import type { Browser, Page } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import type { PickEngine } from "./pick-engine.entry"

type EngineWindow = Window & { __iter8PickEngine: PickEngine }

const ORIGIN = "http://engine.localhost"
const MIN_HEAVY_ELEMENTS = 20_000
const SNAPSHOT_BUDGET_MS = 5

function deepChain(depth: number): string {
  let html = "<button>Deep target</button>"
  for (let level = 0; level < depth; level++)
    html = `<div><span>Level ${level}</span><div></div>${html}</div>`
  return html
}

const HEAVY_PAGE = `<!doctype html>
<html><head><title>heavy</title></head><body>
<ul>${Array.from(
  { length: 2000 },
  (_, row) =>
    `<li><span>Row ${row}</span><a href="#r${row}">open</a><em>${row}</em><b>b</b><i>i</i>` +
    "<small>s</small><code>c</code><u>u</u><s>s</s></li>",
).join("")}</ul>
${deepChain(40)}
</body></html>`

let browser: Browser | undefined
let bundle: Scratch | undefined
let close: (() => Promise<void>) | undefined
let page: Page

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("./pick-engine.entry.ts", import.meta.url)),
  )
  browser = await launchChromium()
  const opened = await newPage(browser)
  close = opened.close
  page = opened.page
  const bundleDir = bundle.path
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url())
    if (pathname === "/overlay.js")
      return route.fulfill({ path: join(bundleDir, "overlay.js"), contentType: "text/javascript" })
    if (pathname === "/heavy.html")
      return route.fulfill({ body: HEAVY_PAGE, contentType: "text/html; charset=utf-8" })
    return route.fulfill({ status: 404 })
  })
}, 120_000)

afterAll(async () => {
  await close?.()
  await browser?.close()
  await bundle?.dispose()
})

test("snapshotting a deep node on a 20,000-node page takes under 5 ms", async () => {
  await page.goto(`${ORIGIN}/heavy.html`)
  await page.addScriptTag({ url: "/overlay.js", type: "module" })
  await waitFor(
    "the pick engine on the test page",
    () => page.evaluate(() => ("__iter8PickEngine" in window ? true : null)),
    { timeoutMs: 5000 },
  )
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const buttons = document.querySelectorAll("button")
    const target = buttons[buttons.length - 1]
    if (!target) throw new Error("the heavy page has no deep target")
    document.body.getBoundingClientRect()
    const started = performance.now()
    const anchor = engine.snapshotElement(target, 0)
    const elapsedMs = performance.now() - started
    let depth = 0
    for (let node: Element | null = target; node !== null; node = node.parentElement) depth += 1
    return {
      elapsedMs,
      depth,
      elements: document.querySelectorAll("*").length,
      resolves: engine.resolveSelector(anchor.selector)[0] === target,
    }
  })
  expect(result.elements).toBeGreaterThanOrEqual(MIN_HEAVY_ELEMENTS)
  expect(result.depth).toBeGreaterThan(40)
  expect(result.resolves).toBe(true)
  expect(result.elapsedMs).toBeLessThan(SNAPSHOT_BUDGET_MS)
}, 120_000)
