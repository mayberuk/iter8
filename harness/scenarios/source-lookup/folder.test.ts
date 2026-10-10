import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { SOURCE_BUNDLE_PATH, SourceLead } from "@iter8/protocol"
import type { lookupSource } from "../../../packages/source/src/index"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import {
  expectedSite,
  type LookupView,
  lookupInPage,
  resolveInPage,
  startSourceRig,
} from "./lookup"
import { CRLF_PAGE, INDEX_PAGE, NESTED_PAGE, SHIFTED_PAGE, SUB_PAGE } from "./markup-pages"

const RIG_TIMEOUT_MS = 120_000

let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined
let pages: Scratch | undefined
let elsewhere: Scratch | undefined

const crlfPage = CRLF_PAGE.replaceAll("\n", "\r\n")

beforeAll(async () => {
  rig = await startSourceRig()
  pages = await scratchDir(`${SCRATCH_ROOT}folder-pages-`)
  elsewhere = await scratchDir(`${SCRATCH_ROOT}folder-elsewhere-`)
  await mkdir(`${pages.path}/sub`)
  await Promise.all([
    writeFile(`${pages.path}/index.html`, INDEX_PAGE),
    writeFile(`${pages.path}/shifted.html`, SHIFTED_PAGE),
    writeFile(`${pages.path}/sub/index.html`, SUB_PAGE),
    writeFile(`${pages.path}/crlf.html`, crlfPage),
    writeFile(`${pages.path}/nested.html`, NESTED_PAGE),
  ])
}, RIG_TIMEOUT_MS)

afterAll(async () => {
  try {
    await rig?.stop()
  } finally {
    try {
      await pages?.dispose()
    } finally {
      await elsewhere?.dispose()
    }
  }
}, RIG_TIMEOUT_MS)

function started() {
  if (rig === undefined || pages === undefined || elsewhere === undefined) {
    throw new Error("the rig never started")
  }
  return { rig, pages: pages.path, elsewhere: elsewhere.path }
}

async function withFolderPage(
  folder: string,
  path: string,
  check: (view: LookupView) => Promise<void>,
  cwd = folder,
): Promise<void> {
  const view = await started().rig.openFolder(folder, { cwd, path })
  try {
    await check(view)
  } finally {
    await view.close()
  }
}

async function lookedUp(view: LookupView, selector: string, within?: string) {
  const lead = await lookupInPage(view, selector, within === undefined ? {} : { within })
  if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
  return { lead, resolved: await resolveInPage(view, lead) }
}

async function lookedUpThroughShadowRoots(view: LookupView, hosts: string[], selector: string) {
  const lead = await view.page.evaluate(
    async ({ bundlePath, hosts, selector }) => {
      const bundle: { lookupSource: typeof lookupSource } = await import(
        new URL(bundlePath, location.origin).href
      )
      let scope: Document | ShadowRoot = document
      for (const host of hosts) {
        const root: ShadowRoot | null | undefined = scope.querySelector(host)?.shadowRoot
        if (root === null || root === undefined) throw new Error(`No open shadow root on ${host}`)
        scope = root
      }
      const element = scope.querySelector(selector)
      if (element === null) throw new Error(`No element matches ${selector}`)
      return await bundle.lookupSource(element, new AbortController().signal)
    },
    { bundlePath: SOURCE_BUNDLE_PATH, hosts, selector },
  )
  const parsed = SourceLead.parse(lead)
  return { lead: parsed, resolved: await resolveInPage(view, parsed) }
}

function lineHolding(text: string, needle: string): { index: number; text: string } {
  const lines = text.split("\n")
  const holding = lines.flatMap((line, index) =>
    line.includes(needle) ? [{ index, text: line }] : [],
  )
  const [only, ...others] = holding
  if (only === undefined || others.length > 0) {
    throw new Error(`${holding.length} lines hold ${needle}, not one`)
  }
  return only
}

function startTagAt(text: string, needle: string): { line: number; column: number } {
  const { index, text: line } = lineHolding(text, needle)
  return { line: index + 1, column: line.lastIndexOf("<", line.indexOf(needle)) + 1 }
}

const marker = (name: string) => `data-source-target="${name}"`

const TRICKY = [
  ["a td under an implied tbody", "implied-tbody"],
  ["a div after the p it auto-closes", "auto-closed"],
  ["an element after a comment holding a div", "after-comment"],
  ["an element after an inline script whose text holds a p", "after-script"],
  ["an element with a start tag over several lines", "multi-line"],
  ["an element after non-ASCII text on its line", "after-non-ascii"],
  ["an element after a template holding a p", "after-template"],
] as const

test(
  "the static fixture's card sends a none lead with its markup path and resolves exact to its marked line",
  async () => {
    const dir = fixtureDir("static")
    const site = await expectedSite("static", "card")
    const text = await Bun.file(`${dir}/${site.file}`).text()
    const { column } = startTagAt(text, marker("card"))
    await withFolderPage(dir, "/", async (view) => {
      const { lead, resolved } = await lookedUp(view, '[data-source-target="card"]')
      expect(lead).toEqual({
        confidence: "none",
        markup: {
          url: view.page.url(),
          steps: [
            { tag: "main", index: 0 },
            { tag: "section", index: 0 },
            { tag: "p", index: 0 },
          ],
          id: null,
          className: null,
          text: "Card in static",
          onPickedElement: true,
        },
      })
      expect(resolved).toEqual({
        confidence: "exact",
        framework: "html",
        component: null,
        file: "index.html",
        line: site.line,
        column,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "an element inside a shadow root is described by its host and resolves approximate at the host's start tag",
  async () => {
    const dir = fixtureDir("static")
    const text = await Bun.file(`${dir}/index.html`).text()
    const host = startTagAt(text, "<fixture-shadow-label")
    await withFolderPage(dir, "/", async (view) => {
      const { lead, resolved } = await lookedUp(view, "span", "fixture-shadow-label")
      expect(lead).toMatchObject({
        confidence: "none",
        markup: {
          steps: [
            { tag: "main", index: 0 },
            { tag: "fixture-shadow-label", index: 0 },
          ],
          id: null,
          className: null,
          text: "",
          url: view.page.url(),
          onPickedElement: false,
        },
      })
      expect(resolved).toEqual({
        confidence: "approximate",
        framework: "html",
        component: null,
        file: "index.html",
        ...host,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "an element in a shadow root inside another shadow root is described by the outermost light-DOM host",
  async () => {
    const { pages } = started()
    const host = startTagAt(NESTED_PAGE, 'id="outer-host"')
    await withFolderPage(pages, "/nested.html", async (view) => {
      const { lead, resolved } = await lookedUpThroughShadowRoots(
        view,
        ["#outer-host", "#inner-host"],
        "span",
      )
      expect(lead).toEqual({
        confidence: "none",
        markup: {
          url: view.page.url(),
          steps: [
            { tag: "main", index: 0 },
            { tag: "section", index: 0 },
          ],
          id: "outer-host",
          className: "shell",
          text: "Outer host text",
          onPickedElement: false,
        },
      })
      expect(resolved).toEqual({
        confidence: "approximate",
        framework: "html",
        component: null,
        file: "nested.html",
        ...host,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a second page in the folder resolves its own file",
  async () => {
    const dir = fixtureDir("static")
    const text = await Bun.file(`${dir}/second.html`).text()
    const paragraph = startTagAt(text, "This is the second page in static.")
    await withFolderPage(dir, "/second.html", async (view) => {
      expect((await lookedUp(view, "main > p")).resolved).toEqual({
        confidence: "exact",
        framework: "html",
        component: null,
        file: "second.html",
        ...paragraph,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test.each(TRICKY)(
  "%s resolves exact at its start tag's line and column",
  async (_label, name) => {
    const { pages } = started()
    const expected = startTagAt(INDEX_PAGE, marker(name))
    await withFolderPage(pages, "/", async (view) => {
      expect((await lookedUp(view, `[${marker(name)}]`)).resolved).toEqual({
        confidence: "exact",
        framework: "html",
        component: null,
        file: "index.html",
        ...expected,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a none lead carries the picked element's id and class exactly as authored",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/", async (view) => {
      const { lead } = await lookedUp(view, `[${marker("multi-line")}]`)
      expect(lead).toMatchObject({
        confidence: "none",
        markup: { id: "side-note", className: "note", onPickedElement: true },
      })
    })
    await withFolderPage(fixtureDir("static"), "/", async (view) => {
      const { lead } = await lookedUp(view, "#overview-heading")
      expect(lead).toMatchObject({
        confidence: "none",
        markup: { id: "overview-heading", className: null },
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "an element a script pushed down by inserting a sibling is never reported exact",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/shifted.html", async (view) => {
      expect(await view.page.locator("body > p").count()).toBe(3)
      expect((await lookedUp(view, `[${marker("shifted")}]`)).resolved).toEqual({
        confidence: "approximate",
        framework: "html",
        component: null,
        file: "shifted.html",
        line: expect.any(Number),
        column: expect.any(Number),
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a directory URL resolves its index.html in that directory",
  async () => {
    const { pages } = started()
    const expected = startTagAt(SUB_PAGE, marker("sub-target"))
    await withFolderPage(pages, "/sub/", async (view) => {
      expect((await lookedUp(view, `[${marker("sub-target")}]`)).resolved).toEqual({
        confidence: "exact",
        framework: "html",
        component: null,
        file: "sub/index.html",
        ...expected,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a file with CRLF line endings reports the same lines as an editor shows",
  async () => {
    const { pages } = started()
    expect(crlfPage).toContain("\r\n")
    const expected = startTagAt(crlfPage, marker("crlf-target"))
    await withFolderPage(pages, "/crlf.html", async (view) => {
      expect((await lookedUp(view, `[${marker("crlf-target")}]`)).resolved).toEqual({
        confidence: "exact",
        framework: "html",
        component: null,
        file: "crlf.html",
        ...expected,
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a folder opened from a directory that does not contain it resolves outside-project",
  async () => {
    const { pages, elsewhere } = started()
    await withFolderPage(
      pages,
      "/",
      async (view) => {
        expect((await lookedUp(view, `[${marker("after-script")}]`)).resolved).toEqual({
          confidence: "none",
          reason: "outside-project",
        })
      },
      elsewhere,
    )
  },
  RIG_TIMEOUT_MS,
)

test(
  "picking leaves the page's DOM unchanged",
  async () => {
    const dir = fixtureDir("static")
    await withFolderPage(dir, "/", async (view) => {
      const snapshot = () =>
        view.page.evaluate(() => {
          const clone = document.documentElement.cloneNode(true) as Element
          clone.querySelector("iter8-overlay")?.remove()
          return clone.outerHTML
        })
      const before = await snapshot()
      await lookedUp(view, '[data-source-target="card"]')
      await lookedUp(view, "span", "fixture-shadow-label")
      expect(await snapshot()).toBe(before)
    })
  },
  RIG_TIMEOUT_MS,
)
