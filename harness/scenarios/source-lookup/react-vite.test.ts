import { afterAll, beforeAll, expect, test } from "bun:test"
import { MANIFEST, type RunningFixture, startFixture } from "../../rig/fixtures"
import { expectedSite, lookupInPage, resolveInPage, startSourceRig } from "./lookup"

const RIG_TIMEOUT_MS = 120_000

const confidence = MANIFEST.find((entry) => entry.name === "vite-react")?.confidence
if (confidence === undefined) throw new Error("fixtures/manifest.json has no vite-react entry")

let fixture: RunningFixture | undefined
let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined

beforeAll(async () => {
  fixture = await startFixture("vite-react")
  rig = await startSourceRig()
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  try {
    await rig?.stop()
  } finally {
    await fixture?.stop()
  }
}, RIG_TIMEOUT_MS)

function started() {
  if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
  return { fixture, rig }
}

test.each(["card", "hookless"])(
  "a marked element in the %s component resolves to its opening tag",
  async (target) => {
    const { fixture, rig } = started()
    const site = await expectedSite("vite-react", target)
    const view = await rig.open(fixture)
    try {
      const selector = `[data-source-target="${target}"]`
      await view.page.waitForSelector(selector)
      const lead = await lookupInPage(view, selector)
      if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
      expect(await resolveInPage(view, lead)).toMatchObject({
        confidence,
        framework: "react",
        file: site.file,
        line: site.line,
      })
    } finally {
      await view.close()
    }
  },
  RIG_TIMEOUT_MS,
)

test(
  "a lookup on a page with no devtools hook leaves it without one",
  async () => {
    const { fixture, rig } = started()
    const view = await rig.open(fixture)
    try {
      const selector = '[data-source-target="card"]'
      await view.page.waitForSelector(selector)
      // Vite's React Fast Refresh runtime installs the hook itself, so the page drops it before
      // the bundle loads; React keeps the reference it took at startup and still renders.
      const hookBefore = await view.page.evaluate(() =>
        Reflect.deleteProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__"),
      )
      expect(hookBefore).toBe(true)
      expect(await view.page.evaluate(() => "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window)).toBe(false)
      expect(await lookupInPage(view, selector)).toMatchObject({ confidence, framework: "react" })
      expect(await view.page.evaluate(() => "__REACT_DEVTOOLS_GLOBAL_HOOK__" in window)).toBe(false)
    } finally {
      await view.close()
    }
  },
  RIG_TIMEOUT_MS,
)
