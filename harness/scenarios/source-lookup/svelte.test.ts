import { afterAll, beforeAll, expect, test } from "bun:test"
import { MANIFEST, type RunningFixture, startFixture } from "../../rig/fixtures"
import { expectedSite, lookupInPage, resolveInPage, startSourceRig } from "./lookup"

const RIG_TIMEOUT_MS = 120_000

const confidence = MANIFEST.find((entry) => entry.name === "sveltekit")?.confidence
if (confidence === undefined) throw new Error("fixtures/manifest.json has no sveltekit entry")

let fixture: RunningFixture | undefined
let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined

beforeAll(async () => {
  fixture = await startFixture("sveltekit")
  rig = await startSourceRig()
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  try {
    await rig?.stop()
  } finally {
    await fixture?.stop()
  }
}, RIG_TIMEOUT_MS)

test(
  "a marked element in a Svelte 5 component resolves to its opening tag",
  async () => {
    if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
    const site = await expectedSite("sveltekit", "card")
    const view = await rig.open(fixture)
    try {
      const selector = '[data-source-target="card"]'
      await view.page.waitForFunction(
        (selector) => Reflect.has(document.querySelector(selector) ?? {}, "__svelte_meta"),
        selector,
      )
      const lead = await lookupInPage(view, selector)
      if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
      expect(await resolveInPage(view, lead)).toMatchObject({
        confidence,
        framework: "svelte",
        component: "Card",
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
  "a page reporting Svelte 4 is approximate, and the highest of several versions decides",
  async () => {
    if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
    const site = await expectedSite("sveltekit", "card")
    const view = await rig.open(fixture)
    try {
      const selector = '[data-source-target="card"]'
      await view.page.waitForFunction(
        (selector) => Reflect.has(document.querySelector(selector) ?? {}, "__svelte_meta"),
        selector,
      )
      const confidenceFor = async (versions: string[]) => {
        await view.page.evaluate((versions) => {
          Reflect.set(window, "__svelte", { v: new Set(versions) })
        }, versions)
        const lead = await lookupInPage(view, selector)
        if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
        return lead
      }

      const four = await confidenceFor(["4"])
      expect(four).toMatchObject({ confidence: "approximate", framework: "svelte" })
      expect(await resolveInPage(view, four)).toMatchObject({
        confidence: "approximate",
        framework: "svelte",
        file: site.file,
        line: site.line,
      })
      expect(await confidenceFor(["4", "5"])).toMatchObject({ confidence: "exact" })
      expect(await confidenceFor(["5", "4"])).toMatchObject({ confidence: "exact" })
    } finally {
      await view.close()
    }
  },
  RIG_TIMEOUT_MS,
)
