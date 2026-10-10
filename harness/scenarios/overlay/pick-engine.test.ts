import { afterAll, beforeAll, expect, test } from "bun:test"
import { join } from "node:path"
import type { Browser, Page, Route } from "playwright"
import { launchChromium, newPage } from "../../rig/browser"
import { buildBrowserBundle } from "../../rig/bundle"
import { fixtureDir } from "../../rig/fixtures"
import type { Scratch } from "../../rig/scratch"
import { waitFor } from "../../rig/wait"
import type { PickEngine } from "./pick-engine.entry"

type EngineWindow = Window & { __iter8PickEngine: PickEngine }

const ORIGIN = "http://engine.localhost"

const SHADOW_PAGE = `<!doctype html>
<html><head><title>nested shadow</title></head><body>
<main>
  <outer-host><template shadowrootmode="open">
    <div><span>Decoy</span><inner-host><template shadowrootmode="open">
      <p><button>Other</button></p>
    </template></inner-host></div>
    <div><inner-host><template shadowrootmode="open">
      <p><button>Deep</button><button>Deeper</button></p>
      <section><p><button>Nested decoy</button></p></section>
    </template></inner-host></div>
  </template></outer-host>
  <div style="height: 3000px"></div>
</main>
</body></html>`

const IDS_PAGE = `<!doctype html>
<html><head><title>ids</title></head><body>
<main>
  <div id=":r1:"><button id="«r2»">Generated one</button></div>
  <div id="_r_3_"><button>Generated two</button></div>
  <div id="stable"><span><button>Stable</button></span></div>
  <div data-testid="card"><button>Test id</button></div>
  <div data-testid="row"><button>Row one</button></div>
  <div data-testid="row"><button>Row two</button></div>
  <div id="twice"><button>Twice one</button></div>
  <div id="twice"><button>Twice two</button></div>
</main>
</body></html>`

const SHADOW_IDS_PAGE = `<!doctype html>
<html><head><title>shadow ids</title></head><body>
<main>
  <div id="shared"><button>Light shared</button></div>
  <x-host><template shadowrootmode="open">
    <div id="stable"><span><button>Shadow stable</button></span></div>
    <div data-testid="card"><button>Shadow test id</button></div>
    <div data-testid="row"><button>Shadow row one</button></div>
    <div data-testid="row"><button>Shadow row two</button></div>
    <div id="twice"><button>Shadow twice one</button></div>
    <div id="twice"><button>Shadow twice two</button></div>
    <div id="a.b:c d"><button>Shadow escaped id</button></div>
    <div data-testid='say "hi" [x]'><button>Shadow escaped test id</button></div>
    <div id="shared"><button>Shared in first</button></div>
    <x-inner><template shadowrootmode="open">
      <div id="shared"><button>Shared in nested</button></div>
    </template></x-inner>
  </template></x-host>
  <x-host><template shadowrootmode="open">
    <div id="shared"><button>Shared in second</button></div>
  </template></x-host>
</main>
</body></html>`

const PAGES: Record<string, string> = {
  "/shadow.html": SHADOW_PAGE,
  "/ids.html": IDS_PAGE,
  "/shadow-ids.html": SHADOW_IDS_PAGE,
}

let browser: Browser | undefined
let bundle: Scratch | undefined
let close: (() => Promise<void>) | undefined
let page: Page

async function serve(route: Route, bundleDir: string): Promise<void> {
  const { pathname } = new URL(route.request().url())
  if (pathname === "/overlay.js")
    return route.fulfill({ path: join(bundleDir, "overlay.js"), contentType: "text/javascript" })
  if (pathname.startsWith("/static/"))
    return route.fulfill({ path: join(fixtureDir("static"), pathname.slice("/static/".length)) })
  const body = PAGES[pathname]
  if (body === undefined) return route.fulfill({ status: 404 })
  return route.fulfill({ body, contentType: "text/html; charset=utf-8" })
}

beforeAll(async () => {
  bundle = await buildBrowserBundle(
    Bun.fileURLToPath(new URL("./pick-engine.entry.ts", import.meta.url)),
  )
  browser = await launchChromium()
  const opened = await newPage(browser)
  close = opened.close
  page = opened.page
  const bundleDir = bundle.path
  await page.route(`${ORIGIN}/**`, (route) => serve(route, bundleDir))
})

afterAll(async () => {
  await close?.()
  await browser?.close()
  await bundle?.dispose()
})

async function open(path: string): Promise<void> {
  await page.goto(`${ORIGIN}${path}`)
  await page.addScriptTag({ url: "/overlay.js", type: "module" })
  await waitFor(
    "the pick engine on the test page",
    () => page.evaluate(() => ("__iter8PickEngine" in window ? true : null)),
    { timeoutMs: 5000 },
  )
}

test("a selector through two nested open shadow roots resolves back to the same element", async () => {
  await open("/shadow.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    window.scrollTo(0, 500)
    const outer = document.querySelector("outer-host")?.shadowRoot
    const inner = outer?.querySelectorAll("inner-host")[1]?.shadowRoot
    const target = inner?.querySelector("button")
    const innerTop = inner?.querySelector("p")
    const innerHost = outer?.querySelectorAll("inner-host")[1]
    if (!target || !innerTop || !innerHost) throw new Error("the nested shadow page is incomplete")
    const anchor = engine.snapshotElement(target, 7)
    const back = engine.resolveSelector(anchor.selector)
    const resolved = engine.resolveAnchor(anchor)
    const rect = target.getBoundingClientRect()
    return {
      anchor,
      keys: Object.keys(anchor),
      resolvesToTarget: back.length === 1 && back[0] === target,
      anchorsToTarget: resolved.kind === "anchored" && resolved.el === target,
      expectedBox: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
      scrollY: window.scrollY,
      parentOfTarget: engine.parentAcrossShadow(target) === target.parentElement,
      parentOfShadowTop: engine.parentAcrossShadow(innerTop) === innerHost,
      parentOfRoot: engine.parentAcrossShadow(document.documentElement),
    }
  })
  expect(result.anchor.selector).toHaveLength(3)
  expect(result.resolvesToTarget).toBe(true)
  expect(result.anchorsToTarget).toBe(true)
  expect(result.anchor).toMatchObject({ role: "button", text: "Deep", renderGeneration: 7 })
  expect(result.keys).not.toContain("name")
  expect(result.scrollY).toBe(500)
  expect(result.anchor.box).toEqual(result.expectedBox)
  expect(result.parentOfTarget).toBe(true)
  expect(result.parentOfShadowTop).toBe(true)
  expect(result.parentOfRoot).toBeNull()
})

test("the static fixture's shadow label round-trips through its shadow root", async () => {
  await open("/static/index.html")
  const result = await page.evaluate(async () => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    await customElements.whenDefined("fixture-shadow-label")
    const target = document
      .querySelector("fixture-shadow-label")
      ?.shadowRoot?.querySelector('[data-fixture="shadow-label"]')
    if (!target) throw new Error("the static fixture has no shadow label")
    const anchor = engine.snapshotElement(target, 0)
    const back = engine.resolveSelector(anchor.selector)
    return { anchor, resolvesToTarget: back.length === 1 && back[0] === target }
  })
  expect(result.anchor.selector).toHaveLength(2)
  expect(result.resolvesToTarget).toBe(true)
  expect(result.anchor.text).toBe("Shadow label in static")
})

test("generated ids are skipped while stable ids and unique test ids end the selector", async () => {
  await open("/ids.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    return Array.from(document.querySelectorAll("button"), (button) => {
      const anchor = engine.snapshotElement(button, 0)
      const back = engine.resolveSelector(anchor.selector)
      return {
        text: button.textContent,
        selector: anchor.selector.join(" "),
        resolvesToButton: back.length === 1 && back[0] === button,
      }
    })
  })
  const byText = new Map(result.map((row) => [row.text, row]))
  for (const row of result) expect(row.resolvesToButton).toBe(true)
  for (const text of ["Generated one", "Generated two"]) {
    expect(byText.get(text)?.selector).not.toMatch(/#|r1|r2|r_3/)
    expect(byText.get(text)?.selector).toStartWith("body")
  }
  expect(byText.get("Stable")?.selector).toContain("#stable")
  expect(byText.get("Stable")?.selector).not.toContain("body")
  expect(byText.get("Test id")?.selector).toContain('[data-testid="card"]')
  expect(byText.get("Test id")?.selector).not.toContain("body")
  expect(byText.get("Row two")?.selector).toContain('[data-testid="row"]')
  expect(byText.get("Row two")?.selector).toStartWith("body")
  expect(byText.get("Twice two")?.selector).not.toContain("#twice")
})

test("inside shadow roots, ids and test ids stop the selector only when unique within their own root", async () => {
  await open("/shadow-ids.html")
  const rows = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const buttons: HTMLButtonElement[] = []
    const collect = (root: Document | ShadowRoot) => {
      buttons.push(...root.querySelectorAll("button"))
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) collect(el.shadowRoot)
    }
    collect(document)
    return buttons.map((button) => {
      const anchor = engine.snapshotElement(button, 0)
      const back = engine.resolveSelector(anchor.selector)
      const resolved = engine.resolveAnchor(anchor)
      return {
        text: button.textContent ?? "",
        selector: anchor.selector,
        resolvesToButton: back.length === 1 && back[0] === button,
        anchorsToButton: resolved.kind === "anchored" && resolved.el === button,
      }
    })
  })
  const byText = new Map(rows.map((row) => [row.text, row]))
  expect(rows).toHaveLength(12)
  for (const row of rows) {
    expect(row.resolvesToButton).toBe(true)
    expect(row.anchorsToButton).toBe(true)
  }
  const inner = (text: string) => byText.get(text)?.selector.at(-1)

  expect(byText.get("Shadow stable")?.selector).toHaveLength(2)
  expect(inner("Shadow stable")).toBe("div#stable > span:nth-of-type(1) > button:nth-of-type(1)")
  expect(inner("Shadow test id")).toBe('div[data-testid="card"] > button:nth-of-type(1)')

  expect(inner("Shadow row two")).toStartWith(":host > ")
  expect(inner("Shadow row two")).toContain(":nth-of-type(4)")
  expect(inner("Shadow twice one")).toStartWith(":host > ")
  expect(inner("Shadow twice one")).not.toContain("#twice")
  expect(inner("Shadow twice two")).not.toContain("#twice")
  expect(inner("Shadow twice one")).not.toBe(inner("Shadow twice two"))

  expect(inner("Light shared")).toBe("div#shared > button:nth-of-type(1)")
  expect(byText.get("Light shared")?.selector).toHaveLength(1)
})

test("the same id in different roots resolves each element through its own host path", async () => {
  await open("/shadow-ids.html")
  const rows = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const hosts = document.querySelectorAll("x-host")
    const first = hosts[0]?.shadowRoot
    const second = hosts[1]?.shadowRoot
    const nested = first?.querySelector("x-inner")?.shadowRoot
    const targets = {
      inFirst: first?.querySelector("div#shared > button"),
      inNested: nested?.querySelector("div#shared > button"),
      inSecond: second?.querySelector("div#shared > button"),
    }
    return Object.entries(targets).map(([name, button]) => {
      if (!button) throw new Error(`the ${name} shared button is missing`)
      const anchor = engine.snapshotElement(button, 0)
      const back = engine.resolveSelector(anchor.selector)
      return {
        name,
        selector: anchor.selector,
        resolvesToButton: back.length === 1 && back[0] === button,
      }
    })
  })
  const byName = new Map(rows.map((row) => [row.name, row]))
  for (const row of rows) {
    expect(row.resolvesToButton).toBe(true)
    expect(row.selector.at(-1)).toBe("div#shared > button:nth-of-type(1)")
  }
  expect(byName.get("inFirst")?.selector).toHaveLength(2)
  expect(byName.get("inSecond")?.selector).toHaveLength(2)
  expect(byName.get("inNested")?.selector).toHaveLength(3)
  expect(byName.get("inFirst")?.selector[0]).not.toBe(byName.get("inSecond")?.selector[0])
})

test("ids and test ids with CSS-special characters are escaped and still round-trip", async () => {
  await open("/shadow-ids.html")
  const rows = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const root = document.querySelector("x-host")?.shadowRoot
    const byId = root?.getElementById("a.b:c d")?.querySelector("button")
    const byTestId = root?.querySelector("[data-testid='say \"hi\" [x]']")?.querySelector("button")
    return [byId, byTestId].map((button) => {
      if (!button) throw new Error("an escaped-value button is missing")
      const anchor = engine.snapshotElement(button, 0)
      const back = engine.resolveSelector(anchor.selector)
      return {
        selector: anchor.selector,
        escapedId: CSS.escape("a.b:c d"),
        escapedTestId: CSS.escape('say "hi" [x]'),
        resolvesToButton: back.length === 1 && back[0] === button,
      }
    })
  })
  const [byId, byTestId] = rows
  expect(byId?.resolvesToButton).toBe(true)
  expect(byTestId?.resolvesToButton).toBe(true)
  expect(byId?.escapedId).toBe("a\\.b\\:c\\ d")
  expect(byId?.selector.at(-1)).toBe("div#a\\.b\\:c\\ d > button:nth-of-type(1)")
  expect(byTestId?.escapedTestId).toBe('say\\ \\"hi\\"\\ \\[x\\]')
  expect(byTestId?.selector.at(-1)).toBe(
    'div[data-testid="say\\ \\"hi\\"\\ \\[x\\]"] > button:nth-of-type(1)',
  )
})

test("an anchor with only a selector resolves to the one element it matches, and is lost when it matches none or several", async () => {
  await open("/static/index.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const card = document.querySelector('[data-source-target="card"]')
    if (!card) throw new Error("the static fixture has no card")
    const bare = (selector: string) => ({
      selector: [selector],
      box: { x: 0, y: 0, width: 0, height: 0 },
      renderGeneration: 0,
    })
    const one = engine.resolveAnchor(bare('[data-source-target="card"]'))
    const none = engine.resolveAnchor(bare("#no-such-element"))
    const several = engine.resolveAnchor(bare("button"))
    return {
      one: one.kind === "anchored" && one.el === card,
      none: none.kind,
      several: several.kind,
      buttons: document.querySelectorAll("button").length,
    }
  })
  expect(result.buttons).toBeGreaterThan(1)
  expect(result).toMatchObject({ one: true, none: "lost", several: "lost" })
})

test("a node replaced by an identical re-render re-anchors to the new node", async () => {
  await open("/static/index.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const card = document.querySelector('[data-source-target="card"]')
    const save = document.querySelectorAll("button")[1]
    if (!card || !save) throw new Error("the static fixture has no card or second Save")
    const cardAnchor = engine.snapshotElement(card, 0)
    const saveAnchor = engine.snapshotElement(save, 0)

    const freshCard = card.cloneNode(true)
    card.replaceWith(freshCard)
    const freshSave = save.cloneNode(true)
    save.replaceWith(freshSave)
    const card1 = engine.resolveAnchor(cardAnchor)
    const save1 = engine.resolveAnchor(saveAnchor)

    const wrapper = document.createElement("div")
    freshCard.parentNode?.insertBefore(wrapper, freshCard)
    const wrappedCard = freshCard.cloneNode(true)
    wrapper.append(wrappedCard)
    freshCard.parentNode?.removeChild(freshCard)
    const card2 = engine.resolveAnchor(cardAnchor)

    return {
      cardReanchored: card1.kind === "anchored" && card1.el === freshCard && card1.el !== card,
      saveReanchored: save1.kind === "anchored" && save1.el === freshSave && save1.el !== save,
      restructuredReanchored: card2.kind === "anchored" && card2.el === wrappedCard,
    }
  })
  expect(result).toEqual({
    cardReanchored: true,
    saveReanchored: true,
    restructuredReanchored: true,
  })
})

test("a removed node is lost as missing", async () => {
  await open("/static/index.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const card = document.querySelector('[data-source-target="card"]')
    if (!card) throw new Error("the static fixture has no card")
    const anchor = engine.snapshotElement(card, 0)
    card.remove()
    return engine.resolveAnchor(anchor)
  })
  expect(result).toEqual({ kind: "lost", reason: "missing" })
})

test("three identical Save buttons with the stored box equidistant are ambiguous", async () => {
  await open("/static/index.html")
  const result = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const saves = Array.from(document.querySelectorAll("button")).filter(
      (button) => button.textContent === "Save",
    )
    const [first, second] = saves
    if (saves.length !== 3 || !first || !second) throw new Error("the static fixture lacks 3 Saves")
    const anchor = engine.snapshotElement(second, 0)
    const centre = (button: Element) => {
      const box = engine.snapshotElement(button, 0).box
      return { x: box.x + box.width / 2, y: box.y + box.height / 2, box }
    }
    const a = centre(first)
    const b = centre(second)
    const width = Math.abs(b.x - a.x) + 2 * a.box.width
    const height = Math.abs(b.y - a.y) + 2 * a.box.height
    const midway = {
      x: (a.x + b.x) / 2 - width / 2,
      y: (a.y + b.y) / 2 - height / 2,
      width,
      height,
    }
    const staleSelector = ["body > main:nth-of-type(1) > section:nth-of-type(9) > button"]
    const tied = engine.resolveAnchor({ ...anchor, selector: staleSelector, box: midway })
    const onSecond = engine.resolveAnchor({ ...anchor, selector: staleSelector })
    return {
      tied,
      onSecond: onSecond.kind === "anchored" && onSecond.el === second,
    }
  })
  expect(result.tied).toEqual({ kind: "lost", reason: "ambiguous" })
  expect(result.onSecond).toBe(true)
})

test("the render generation counts mutation batches until disposed", async () => {
  await open("/static/index.html")
  const counts = await page.evaluate(async () => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    const generation = engine.createRenderGeneration()
    const seen = [generation.current()]
    document.body.append(document.createElement("div"), document.createElement("div"))
    await Promise.resolve()
    seen.push(generation.current())
    document.querySelector("main")?.append(document.createElement("p"))
    await Promise.resolve()
    seen.push(generation.current())
    generation.dispose()
    document.body.append(document.createElement("div"))
    await Promise.resolve()
    seen.push(generation.current())
    return seen
  })
  expect(counts).toEqual([0, 1, 2, 2])
})

test("a region target is in page coordinates with the viewport it was drawn in", async () => {
  await open("/shadow.html")
  const target = await page.evaluate(() => {
    const engine = (window as unknown as EngineWindow).__iter8PickEngine
    window.scrollTo(0, 400)
    return engine.regionTarget(new DOMRect(40, 20, -30, 40))
  })
  expect(target).toEqual({
    kind: "region",
    box: { x: 10, y: 420, width: 30, height: 40 },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  })
})
