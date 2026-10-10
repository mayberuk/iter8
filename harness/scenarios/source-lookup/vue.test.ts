import { afterAll, beforeAll, expect, test } from "bun:test"
import { MANIFEST, type RunningFixture, startFixture } from "../../rig/fixtures"
import { expectedSite, lookupInPage, resolveInPage, startSourceRig } from "./lookup"

const RIG_TIMEOUT_MS = 120_000

const confidence = MANIFEST.find((entry) => entry.name === "vue")?.confidence
if (confidence === undefined) throw new Error("fixtures/manifest.json has no vue entry")

let fixture: RunningFixture | undefined
let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined

beforeAll(async () => {
  fixture = await startFixture("vue")
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
  "a marked element in a Vue component resolves to its file and no line",
  async () => {
    if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
    const site = await expectedSite("vue", "card")
    const view = await rig.open(fixture)
    try {
      const selector = '[data-source-target="card"]'
      await view.page.waitForSelector(selector)
      const lead = await lookupInPage(view, selector)
      if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
      const resolved = await resolveInPage(view, lead)
      expect(resolved).toMatchObject({
        confidence,
        framework: "vue",
        file: site.file,
      })
      expect(resolved).not.toHaveProperty("line")
    } finally {
      await view.close()
    }
  },
  RIG_TIMEOUT_MS,
)
