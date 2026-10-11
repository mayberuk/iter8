import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import type { SourceLead } from "@iter8/protocol"
import type { Browser } from "playwright"
import { buildOverlayBundles } from "../../../scripts/build"
import { launchChromium } from "../../rig/browser"
import { fixtureDir } from "../../rig/fixtures"
import { SCRATCH_ROOT, type Scratch, scratchDir } from "../../rig/scratch"
import { startService } from "../../rig/service"
import {
  expectedSite,
  type LookupView,
  lookupInPage,
  resolveInPage,
  startSourceRig,
} from "./lookup"
import {
  CRLF_PAGE,
  FRAMEWORK_PAGE,
  INDEX_PAGE,
  NESTED_PAGE,
  SHIFTED_PAGE,
  SUB_PAGE,
  TEXT_PAGE,
} from "./markup-pages"

const RIG_TIMEOUT_MS = 120_000

let rig: Awaited<ReturnType<typeof startSourceRig>> | undefined
let browser: Browser | undefined
let pages: Scratch | undefined
let elsewhere: Scratch | undefined

const crlfPage = CRLF_PAGE.replaceAll("\n", "\r\n")

beforeAll(async () => {
  rig = await startSourceRig({
    build: buildOverlayBundles,
    start: startService,
    launch: async (options) => {
      browser = await launchChromium(options)
      return browser
    },
  })
  pages = await scratchDir(`${SCRATCH_ROOT}folder-pages-`)
  elsewhere = await scratchDir(`${SCRATCH_ROOT}folder-elsewhere-`)
  await mkdir(`${pages.path}/sub`)
  await Promise.all([
    writeFile(`${pages.path}/index.html`, INDEX_PAGE),
    writeFile(`${pages.path}/shifted.html`, SHIFTED_PAGE),
    writeFile(`${pages.path}/sub/index.html`, SUB_PAGE),
    writeFile(`${pages.path}/crlf.html`, crlfPage),
    writeFile(`${pages.path}/nested.html`, NESTED_PAGE),
    writeFile(`${pages.path}/text.html`, TEXT_PAGE),
    writeFile(`${pages.path}/framework.html`, FRAMEWORK_PAGE),
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

async function lookedUp(view: LookupView, selector: string, within: string[] = []) {
  const lead = await lookupInPage(view, selector, { within })
  if ("rejected" in lead) throw new Error(`lookup rejected with ${lead.rejected}`)
  return { lead, resolved: await resolveInPage(view, lead) }
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
      const { lead, resolved } = await lookedUp(view, "span", ["fixture-shadow-label"])
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
      const { lead, resolved } = await lookedUp(view, "span", ["#outer-host", "#inner-host"])
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
      await lookedUp(view, "span", ["fixture-shadow-label"])
      expect(await snapshot()).toBe(before)
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a lookup records no mutation in the document or in any open shadow root",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/nested.html", async (view) => {
      await view.page.evaluate(() => {
        let delivered = 0
        const observer = new MutationObserver((records) => {
          delivered += records.length
        })
        const options = { subtree: true, childList: true, attributes: true, characterData: true }
        const outer = document.querySelector("#outer-host")?.shadowRoot
        const inner = outer?.querySelector("#inner-host")?.shadowRoot
        if (outer === null || outer === undefined)
          throw new Error("the outer shadow root is missing")
        if (inner === null || inner === undefined)
          throw new Error("the inner shadow root is missing")
        for (const target of [document, outer, inner]) observer.observe(target, options)
        Reflect.set(window, "mutationsSeen", () => delivered + observer.takeRecords().length)
      })
      await lookedUp(view, "span", ["#outer-host", "#inner-host"])
      await lookedUp(view, "#outer-host")
      expect(await view.page.evaluate(() => Reflect.get(window, "mutationsSeen")())).toBe(0)
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "framework evidence on the picked element or on an ancestor gives that framework's lead and no markup",
  async () => {
    const { pages } = started()
    const astro = (confidence: "exact" | "approximate"): SourceLead => ({
      confidence,
      framework: "astro",
      build: "vite",
      component: "index",
      frames: [{ kind: "source", file: "/work/site/src/pages/index.astro", line: 7, column: 12 }],
    })
    await withFolderPage(pages, "/framework.html", async (view) => {
      expect((await lookedUp(view, "section")).lead).toEqual(astro("exact"))
      expect((await lookedUp(view, "#inside")).lead).toEqual(astro("approximate"))
    })
  },
  RIG_TIMEOUT_MS,
)

const SPEC_MAX_STEPS = 256

async function nestedDivs(view: LookupView, depth: number) {
  await view.page.evaluate((depth) => {
    let parent: Element = document.body
    for (let level = 0; level < depth; level += 1) {
      const div = document.createElement("div")
      parent.append(div)
      parent = div
    }
    parent.id = "deepest"
  }, depth)
}

test(
  "a path of exactly 256 steps from the body keeps its markup",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/sub/", async (view) => {
      await nestedDivs(view, SPEC_MAX_STEPS)
      const lead = await lookupInPage(view, "#deepest")
      expect(lead).toMatchObject({
        confidence: "none",
        markup: {
          steps: Array.from({ length: SPEC_MAX_STEPS }, () => ({ tag: "div", index: 0 })),
          id: "deepest",
        },
      })
    })
  },
  RIG_TIMEOUT_MS,
)

test.each([
  ["a path of 257 steps from the body", "#deepest", {}],
  ["the body itself", "body", {}],
  ["an element in the head", "title", {}],
  ["an element removed from the page", "main", { detach: true }],
])(
  "%s gives the plain none lead with no markup",
  async (_label, selector, options) => {
    const { pages } = started()
    await withFolderPage(pages, "/sub/", async (view) => {
      if (selector === "#deepest") await nestedDivs(view, SPEC_MAX_STEPS + 1)
      expect(await lookupInPage(view, selector, options)).toEqual({ confidence: "none" })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "the text identity folds descendant text and leaves out template content, shadow text and text past the walk's cap",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/text.html", async (view) => {
      expect(await lookupInPage(view, "#folded")).toMatchObject({
        markup: { text: "Alpha beta gamma delta" },
      })
      expect(await lookupInPage(view, "#capped")).toMatchObject({ markup: { text: "" } })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a page that breaks markup collection still gives the plain none lead",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/", async (view) => {
      expect(
        await lookupInPage(view, `[${marker("after-script")}]`, { breakTreeWalker: "throw" }),
      ).toEqual({ confidence: "none" })
    })
  },
  RIG_TIMEOUT_MS,
)

test(
  "a lookup aborted during markup collection rejects instead of giving a lead",
  async () => {
    const { pages } = started()
    await withFolderPage(pages, "/", async (view) => {
      expect(
        await lookupInPage(view, `[${marker("after-script")}]`, { breakTreeWalker: "abort" }),
      ).toEqual({ rejected: "AbortError" })
    })
  },
  RIG_TIMEOUT_MS,
)

function contextCount() {
  if (browser === undefined) throw new Error("the rig never launched a browser")
  return browser.contexts().length
}

test(
  "an openFolder whose navigation fails leaves no page context behind",
  async () => {
    const { rig, pages } = started()
    const before = contextCount()
    await expect(
      rig.openFolder(pages, { cwd: pages, path: "http://127.0.0.1:1/" }),
    ).rejects.toThrow()
    expect(contextCount()).toBe(before)
  },
  RIG_TIMEOUT_MS,
)

test(
  "an openFolder whose folder the CLI refuses rejects with the exit code and makes no page context",
  async () => {
    const { rig, pages } = started()
    const before = contextCount()
    await expect(rig.openFolder(`${pages}/missing`, { cwd: pages })).rejects.toThrow(/exited [1-9]/)
    expect(contextCount()).toBe(before)
  },
  RIG_TIMEOUT_MS,
)
