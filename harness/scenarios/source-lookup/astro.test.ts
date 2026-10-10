import { afterAll, beforeAll, expect, test } from "bun:test"
import { MANIFEST, type RunningFixture, startFixture } from "../../rig/fixtures"
import { waitFor } from "../../rig/wait"
import {
  expectedSite,
  type LookupView,
  lookupInPage,
  resolveInPage,
  startSourceRig,
} from "./lookup"

const RIG_TIMEOUT_MS = 120_000
const CARD = '[data-source-target="card"]'

const confidence = MANIFEST.find((entry) => entry.name === "astro")?.confidence
if (confidence === undefined) throw new Error("fixtures/manifest.json has no astro entry")

let fixture: RunningFixture | undefined
let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined

beforeAll(async () => {
  fixture = await startFixture("astro")
  rig = await startSourceRig()
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  try {
    await rig?.stop()
  } finally {
    await fixture?.stop()
  }
}, RIG_TIMEOUT_MS)

async function withStrippedPage(
  check: (view: LookupView) => Promise<void>,
  path?: string,
): Promise<void> {
  if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
  const view = await rig.open(fixture, path)
  try {
    await waitFor(
      "the dev toolbar to strip source attributes",
      async () =>
        (await view.page.evaluate(
          () => document.querySelector("[data-astro-source-file]") === null,
        ))
          ? true
          : null,
      { timeoutMs: 10_000 },
    )
    await check(view)
  } finally {
    await view.close()
  }
}

async function resolvedCard(view: LookupView, selector = CARD) {
  const lead = await lookupInPage(view, selector)
  if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
  return resolveInPage(view, lead)
}

test(
  "a marked element in an Astro component resolves to its opening tag after the toolbar strips it",
  async () => {
    const site = await expectedSite("astro", "card")
    await withStrippedPage(async (view) => {
      expect(await resolvedCard(view)).toMatchObject({
        confidence,
        framework: "astro",
        component: "Card",
        file: site.file,
        line: site.line,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

const MULTILINE = '[data-source-target="multiline"]'

async function multilineTag() {
  if (fixture === undefined) throw new Error("the rig never started")
  const site = await expectedSite("astro", "multiline")
  const lines = (await Bun.file(`${fixture.dir}/${site.file}`).text()).split("\n")
  const closing = lines.findIndex(
    (text, index) => index >= site.line && text.trimStart().startsWith(">"),
  )
  expect(lines[site.line - 1]?.trimStart().startsWith("<p")).toBe(true)
  expect(closing + 1).toBeGreaterThan(site.line + 1)
  return { site, openingLine: site.line, closingLine: closing + 1 }
}

test(
  "a multiline opening tag on a later line resolves to a line inside that tag, never line 1",
  async () => {
    const { site, openingLine, closingLine } = await multilineTag()
    expect(openingLine).toBeGreaterThan(1)
    await withStrippedPage(async (view) => {
      const resolved = await resolvedCard(view, MULTILINE)
      expect(resolved).toMatchObject({ confidence: "exact", framework: "astro", file: site.file })
      if (!("line" in resolved) || resolved.line === undefined) throw new Error("no line resolved")
      expect(resolved.line).toBeGreaterThanOrEqual(openingLine)
      expect(resolved.line).toBeLessThanOrEqual(closingLine)
    }, "/multiline")
  },
  RIG_TIMEOUT_MS,
)

test(
  "a multiline opening tag resolves to the line where Astro's compiler says the tag ends",
  async () => {
    const { site, closingLine } = await multilineTag()
    await withStrippedPage(async (view) => {
      expect(await resolvedCard(view, MULTILINE)).toMatchObject({
        confidence: "exact",
        framework: "astro",
        file: site.file,
        line: closingLine,
      })
    }, "/multiline")
  },
  RIG_TIMEOUT_MS,
)

test(
  "a picked element whose class differs from the served HTML is approximate",
  async () => {
    const site = await expectedSite("astro", "card")
    await withStrippedPage(async (view) => {
      await view.page.evaluate((selector) => {
        document.querySelector(selector)?.setAttribute("class", "changed-after-load")
      }, CARD)
      expect(await resolvedCard(view)).toMatchObject({
        confidence: "approximate",
        framework: "astro",
        file: site.file,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "source attributes still on the picked element win over the served HTML",
  async () => {
    if (fixture === undefined) throw new Error("the rig never started")
    const site = await expectedSite("astro", "card")
    const changedLine = site.line + 3
    await withStrippedPage(async (view) => {
      await view.page.evaluate(
        ({ selector, file, loc }) => {
          const card = document.querySelector(selector)
          card?.setAttribute("data-astro-source-file", file)
          card?.setAttribute("data-astro-source-loc", loc)
        },
        { selector: CARD, file: `${fixture?.dir}/${site.file}`, loc: `${changedLine}:1` },
      )
      expect(await resolvedCard(view)).toMatchObject({
        framework: "astro",
        file: site.file,
        line: changedLine,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "an Astro lookup whose signal aborts rejects with an AbortError",
  async () => {
    await withStrippedPage(async (view) => {
      expect(await lookupInPage(view, CARD, { abortAfterMs: 0 })).toEqual({
        rejected: "AbortError",
      })
    })
  },
  RIG_TIMEOUT_MS,
)
