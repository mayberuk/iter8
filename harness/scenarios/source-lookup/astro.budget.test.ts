import { afterAll, beforeAll, expect, test } from "bun:test"
import { MAX_SERVED_HTML_BYTES } from "../../../packages/source/src/astro"
import { type RunningFixture, startFixture } from "../../rig/fixtures"
import { waitFor } from "../../rig/wait"
import { type LookupView, startSourceRig } from "./lookup"

const RIG_TIMEOUT_MS = 120_000
const TYPING_BUDGET_MS = 250

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

async function withStrippedPage(check: (view: LookupView) => Promise<void>): Promise<void> {
  if (fixture === undefined || rig === undefined) throw new Error("the rig never started")
  const view = await rig.open(fixture)
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

test(
  "a served page at the size cap parses inside the typing budget",
  async () => {
    await withStrippedPage(async (view) => {
      const timing = await view.page.evaluate(async (capBytes) => {
        const html = await (await fetch(location.href, { cache: "no-store" })).text()
        const parse = (text: string) => {
          const started = performance.now()
          new DOMParser().parseFromString(text, "text/html")
          return performance.now() - started
        }
        const bytes = (text: string) => new TextEncoder().encode(text).byteLength
        const body = html.slice(
          html.indexOf(">", html.indexOf("<body")) + 1,
          html.lastIndexOf("</body>"),
        )
        const copies = Math.floor((capBytes - bytes(html)) / bytes(body))
        const atCap = html.replace("</body>", `${body.repeat(copies)}</body>`)
        return {
          pageBytes: bytes(html),
          pageMs: parse(html),
          capBytes: bytes(atCap),
          capMs: parse(atCap),
        }
      }, MAX_SERVED_HTML_BYTES)
      expect(timing.capBytes).toBeLessThanOrEqual(MAX_SERVED_HTML_BYTES)
      expect(timing.capMs).toBeLessThanOrEqual(TYPING_BUDGET_MS)
    })
  },
  RIG_TIMEOUT_MS,
)
