import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type FixtureName, MANIFEST, type RunningFixture, startFixture } from "../../rig/fixtures"
import { expectedSite, lookupInPage, resolveInPage, startSourceRig } from "./lookup"

const RIG_TIMEOUT_MS = 120_000

let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined

beforeAll(async () => {
  rig = await startSourceRig()
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  await rig?.stop()
}, RIG_TIMEOUT_MS)

const builds: { name: FixtureName; assertsLine: boolean }[] = [
  // Webpack dev reports lines in the generated module, so only the file is held to the marker.
  { name: "next-webpack", assertsLine: false },
  { name: "next-turbopack", assertsLine: true },
]

describe.each(builds)("$name", ({ name, assertsLine }) => {
  const confidence = MANIFEST.find((entry) => entry.name === name)?.confidence
  if (confidence === undefined) throw new Error(`fixtures/manifest.json has no ${name} entry`)
  let fixture: RunningFixture | undefined

  beforeAll(async () => {
    fixture = await startFixture(name)
  }, RIG_TIMEOUT_MS)

  afterAll(async () => {
    await fixture?.stop()
  }, RIG_TIMEOUT_MS)

  test.each(["client", "server"])(
    "a marked element in the %s component resolves to its source",
    async (target) => {
      if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
      const site = await expectedSite(name, target)
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
          ...(assertsLine ? { line: site.line } : {}),
        })
      } finally {
        await view.close()
      }
    },
    RIG_TIMEOUT_MS,
  )
})
