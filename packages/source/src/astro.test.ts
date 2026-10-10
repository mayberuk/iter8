import { describe, expect, test } from "bun:test"
import { astroEvidence, MAX_SERVED_HTML_BYTES } from "./astro"

const FILE = "/work/fixtures/astro/src/pages/multiline.astro"
const PAGE_URL = "http://astro.localhost:4321/second?tab=2"

type FakeElement = {
  localName: string
  parentElement: FakeElement | null
  children: FakeElement[]
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  addEventListener(): void
}

type Calls = {
  fetches: { url: string; init: RequestInit }[]
  parses: { html: string }[]
  listeners: number
  observers: number
}

function world() {
  const calls: Calls = { fetches: [], parses: [], listeners: 0, observers: 0 }
  const el = (
    tag: string,
    attributes: Record<string, string> = {},
    ...kids: FakeElement[]
  ): FakeElement => {
    const element: FakeElement = {
      localName: tag,
      parentElement: null,
      children: kids,
      getAttribute: (name) => attributes[name] ?? null,
      hasAttribute: (name) => name in attributes,
      addEventListener: () => {
        calls.listeners += 1
      },
    }
    for (const kid of kids) kid.parentElement = element
    return element
  }
  return { calls, el }
}

const source = (file: string, loc: string) => ({
  "data-astro-source-file": file,
  "data-astro-source-loc": loc,
})

type Stage = {
  body: FakeElement
  picked: FakeElement
  served?: FakeElement | ((html: string) => FakeElement)
  respond?: (init: RequestInit & { signal: AbortSignal }, count: number) => Promise<Response>
  generator?: string | null
  toolbar?: boolean
  onParse?: () => void
}

const GLOBALS = [
  "document",
  "location",
  "fetch",
  "DOMParser",
  "MutationObserver",
  "IntersectionObserver",
  "ResizeObserver",
  "addEventListener",
]

async function lookup(
  calls: Calls,
  stage: Stage,
  context: { signal?: AbortSignal; depth?: number } = {},
) {
  const { generator = "Astro v7.3.8", toolbar = false } = stage
  const saved = GLOBALS.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  )
  const observer = class {
    constructor() {
      calls.observers += 1
    }
  }
  const stubs: Record<string, unknown> = {
    document: {
      body: stage.body,
      addEventListener: () => {
        calls.listeners += 1
      },
      querySelector: (selector: string) => {
        if (selector === 'meta[name="generator"]' && generator !== null) {
          return { getAttribute: (name: string) => (name === "content" ? generator : null) }
        }
        if (selector === "astro-dev-toolbar" && toolbar) return {}
        return null
      },
    },
    location: { href: PAGE_URL },
    fetch: (url: string, init: RequestInit & { signal: AbortSignal }) => {
      calls.fetches.push({ url, init })
      return stage.respond?.(init, calls.fetches.length) ?? Promise.resolve(new Response("<html>"))
    },
    DOMParser: class {
      parseFromString(html: string) {
        calls.parses.push({ html })
        stage.onParse?.()
        const served = typeof stage.served === "function" ? stage.served(html) : stage.served
        return { body: served ?? stage.body }
      }
    },
    MutationObserver: observer,
    IntersectionObserver: observer,
    ResizeObserver: observer,
    addEventListener: () => {
      calls.listeners += 1
    },
  }
  for (const [key, value] of Object.entries(stubs)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  try {
    return await astroEvidence(stage.picked as unknown as Element, {
      signal: context.signal ?? new AbortController().signal,
      depth: context.depth ?? 0,
    })
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
}

function simple() {
  const { calls, el } = world()
  const live = el("p")
  const body = el("body", {}, live)
  const served = el("body", {}, el("p", source(FILE, "3:4")))
  return { calls, el, stage: { body, picked: live, served } satisfies Stage }
}

describe("live attributes", () => {
  async function locatedAt(loc: string | undefined) {
    const { calls, el } = world()
    const live = el("p", {
      "data-astro-source-file": FILE,
      ...(loc === undefined ? {} : { "data-astro-source-loc": loc }),
    })
    return lookup(calls, { body: el("body", {}, live), picked: live })
  }

  test.each([
    ["16:6", 16, 6],
    ["1:30", 1, 30],
    ["12:9", 12, 9],
    ["10:7", 10, 7],
    ["204:1", 204, 1],
  ])(
    "a source location of %s reports line %i and column %i as given",
    async (loc, line, column) => {
      expect(await locatedAt(loc)).toEqual({
        framework: "astro",
        major: null,
        component: "multiline",
        frames: [{ kind: "source", file: FILE, line, column }],
        onPickedElement: true,
      })
    },
  )

  test.each([
    ["no location", undefined, {}],
    ["a location with no line", ":6", { column: 6 }],
    ["a line of zero", "0:6", { column: 6 }],
    ["a non-numeric line", "x:6", { column: 6 }],
    ["a location with no column", "16", { line: 16 }],
    ["an empty column", "16:", { line: 16 }],
    ["a column of zero", "16:0", { line: 16 }],
    ["a non-numeric column", "16:x", { line: 16 }],
  ])("%s leaves only the valid part on the frame", async (_label, loc, rest) => {
    expect((await locatedAt(loc))?.frames).toEqual([{ kind: "source", file: FILE, ...rest }])
  })

  test("a live file different from the served file wins, with its own line", async () => {
    const { calls, el, stage } = simple()
    const live = el("p", source("/work/src/Live.astro", "7:2"))
    const result = await lookup(calls, {
      ...stage,
      picked: live,
      body: el("body", {}, live),
    })
    expect(result).toMatchObject({
      component: "Live",
      frames: [{ kind: "source", file: "/work/src/Live.astro", line: 7, column: 2 }],
      onPickedElement: true,
    })
    expect(calls.fetches).toEqual([])
  })

  test("an annotated element at depth > 0 still yields its live attributes", async () => {
    const { calls, el } = world()
    const ancestor = el("section", source(FILE, "9:3"))
    const result = await lookup(
      calls,
      { body: el("body", {}, ancestor), picked: ancestor },
      { depth: 3 },
    )
    expect(result?.frames).toEqual([{ kind: "source", file: FILE, line: 9, column: 3 }])
    expect(calls.fetches).toEqual([])
  })

  test("an unannotated element at depth > 0 does no served-HTML work", async () => {
    const { calls, stage } = simple()
    expect(await lookup(calls, stage, { depth: 1 })).toBeNull()
    expect(calls.fetches).toEqual([])
  })
})

describe("Astro page recognition", () => {
  test.each([
    ["a generator starting with Astro and no toolbar", "Astro v7.3.8", false],
    ["a generator that is exactly Astro", "Astro", false],
    ["the dev toolbar and no generator", null, true],
    ["the dev toolbar and a foreign generator", "Gatsby 5.0", true],
  ])("%s is an Astro page", async (_label, generator, toolbar) => {
    const { calls, stage } = simple()
    const result = await lookup(calls, { ...stage, generator, toolbar })
    expect(result).toMatchObject({ onPickedElement: true, frames: [{ file: FILE, line: 3 }] })
    expect(calls.fetches).toHaveLength(1)
  })

  test.each([
    ["no generator and no toolbar", null],
    ["a generator that does not start with Astro", "My Astro site"],
    ["a foreign generator", "Gatsby 5.0"],
    ["a lowercase astro generator", "astro v7"],
    ["an empty generator", ""],
  ])("%s is not an Astro page: no fetch, no evidence", async (_label, generator) => {
    const { calls, stage } = simple()
    expect(await lookup(calls, { ...stage, generator, toolbar: false })).toBeNull()
    expect(calls.fetches).toEqual([])
  })
})

describe("the served-page request", () => {
  test("fetches location.href once with exactly the same-origin, uncached, abortable options", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    await lookup(calls, stage, { signal: controller.signal })
    expect(calls.fetches).toHaveLength(1)
    const [request] = calls.fetches
    expect(request?.url).toBe(PAGE_URL)
    expect(request?.init).toStrictEqual({
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    })
  })

  test("a failed response gives no evidence and is not parsed", async () => {
    const { calls, stage } = simple()
    const result = await lookup(calls, {
      ...stage,
      respond: async () => new Response("nope", { status: 500 }),
    })
    expect(result).toBeNull()
    expect(calls.parses).toEqual([])
  })

  test("a response with no body gives no evidence", async () => {
    const { calls, stage } = simple()
    const result = await lookup(calls, { ...stage, respond: async () => new Response(null) })
    expect(result).toBeNull()
    expect(calls.parses).toEqual([])
  })

  test("an element outside the body gives no evidence and no request", async () => {
    const { calls, el, stage } = simple()
    expect(await lookup(calls, { ...stage, picked: el("p") })).toBeNull()
    expect(calls.fetches).toEqual([])
  })
})

describe("the served-page size cap", () => {
  const text = (bytes: number) => "x".repeat(bytes)

  function streamed(pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void) {
    const state = { pulls: 0, cancelled: false }
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          state.pulls += 1
          pull(controller)
        },
        cancel: () => {
          state.cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    return { state, response: new Response(body) }
  }

  test("a body of exactly the cap is accepted", async () => {
    const { calls, stage } = simple()
    const result = await lookup(calls, {
      ...stage,
      respond: async () => new Response(text(MAX_SERVED_HTML_BYTES)),
    })
    expect(result?.frames).toEqual([{ kind: "source", file: FILE, line: 3, column: 4 }])
    expect(calls.parses.map((parse) => parse.html.length)).toEqual([MAX_SERVED_HTML_BYTES])
  })

  test("a body of exactly the cap arriving in several chunks is accepted", async () => {
    const { calls, stage } = simple()
    const chunk = new TextEncoder().encode(text(MAX_SERVED_HTML_BYTES / 4))
    let sent = 0
    const { response } = streamed((controller) => {
      if (sent === 4) return controller.close()
      sent += 1
      controller.enqueue(chunk)
    })
    const result = await lookup(calls, { ...stage, respond: async () => response })
    expect(result).not.toBeNull()
    expect(calls.parses.map((parse) => parse.html.length)).toEqual([MAX_SERVED_HTML_BYTES])
  })

  test("a body one byte over the cap is refused", async () => {
    const { calls, stage } = simple()
    const result = await lookup(calls, {
      ...stage,
      respond: async () => new Response(text(MAX_SERVED_HTML_BYTES + 1)),
    })
    expect(result).toBeNull()
    expect(calls.parses).toEqual([])
  })

  test("the cap counts bytes, not characters", async () => {
    const { calls, stage } = simple()
    const result = await lookup(calls, {
      ...stage,
      respond: async () => new Response("é".repeat(MAX_SERVED_HTML_BYTES / 2 + 1)),
    })
    expect(result).toBeNull()
    expect(calls.parses).toEqual([])
  })

  test("a streamed body that crosses the cap midway is refused without reading the rest", async () => {
    const { calls, stage } = simple()
    const chunk = new Uint8Array(400_000).fill(120)
    const { state, response } = streamed((controller) => controller.enqueue(chunk))
    const result = await lookup(calls, { ...stage, respond: async () => response })
    expect(result).toBeNull()
    expect(calls.parses).toEqual([])
    expect(state).toEqual({ pulls: 3, cancelled: true })
  })
})

describe("abort checkpoints", () => {
  const reason = new Error("the lookup was cancelled")

  test("an abort while the fetch is pending rejects with the signal's reason", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    const pending = lookup(
      calls,
      {
        ...stage,
        respond: (init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason))
            setTimeout(() => controller.abort(reason), 0)
          }),
      },
      { signal: controller.signal },
    )
    await expect(pending).rejects.toBe(reason)
    expect(calls.parses).toEqual([])
  })

  test("an abort once the fetch resolved rejects before the body is read", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    const state = { pulls: 0 }
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (stream) => {
          state.pulls += 1
          stream.close()
        },
      },
      { highWaterMark: 0 },
    )
    const pending = lookup(
      calls,
      {
        ...stage,
        respond: async () => {
          controller.abort(reason)
          return new Response(body)
        },
      },
      { signal: controller.signal },
    )
    await expect(pending).rejects.toBe(reason)
    expect(state.pulls).toBe(0)
    expect(calls.parses).toEqual([])
  })

  test("an abort that errors the streamed body rejects with the signal's reason", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (stream) => {
          controller.abort(reason)
          stream.error(controller.signal.reason)
        },
      },
      { highWaterMark: 0 },
    )
    const pending = lookup(
      calls,
      { ...stage, respond: async () => new Response(body) },
      { signal: controller.signal },
    )
    await expect(pending).rejects.toBe(reason)
    expect(calls.parses).toEqual([])
  })

  test("an abort as the last chunk arrives rejects before the page is parsed", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    let sent = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (stream) => {
          if (sent) return stream.close()
          sent = true
          controller.abort(reason)
          stream.enqueue(new TextEncoder().encode("<html>"))
        },
      },
      { highWaterMark: 0 },
    )
    const pending = lookup(
      calls,
      { ...stage, respond: async () => new Response(body) },
      { signal: controller.signal },
    )
    await expect(pending).rejects.toBe(reason)
    expect(calls.parses).toEqual([])
  })

  test("an abort during the parse rejects instead of returning evidence", async () => {
    const { calls, stage } = simple()
    const controller = new AbortController()
    const pending = lookup(
      calls,
      { ...stage, onParse: () => controller.abort(reason) },
      { signal: controller.signal },
    )
    await expect(pending).rejects.toBe(reason)
    expect(calls.parses).toHaveLength(1)
  })
})

describe("matching the picked element in the served page", () => {
  test("repeated same-tag siblings separated by other tags match by their same-tag index", async () => {
    const { calls, el } = world()
    const sections = [el("section"), el("section"), el("section")] as const
    const live = el("body", {}, sections[0], el("p"), sections[1], el("span"), sections[2])
    const served = el(
      "body",
      {},
      el("link"),
      el("section", source(FILE, "10:1")),
      el("p"),
      el("section", source(FILE, "20:1")),
      el("span"),
      el("section", source(FILE, "30:1")),
    )
    const lines = []
    for (const section of sections) {
      const result = await lookup(calls, { body: live, picked: section, served })
      lines.push(result?.frames[0]?.line)
    }
    expect(lines).toEqual([10, 20, 30])
  })

  test("indices count per tag at every level of the path", async () => {
    const { calls, el } = world()
    const target = el("div")
    const live = el("body", {}, el("main"), el("main", {}, el("div"), el("aside"), target))
    const served = el(
      "body",
      {},
      el("main", source(FILE, "1:1")),
      el(
        "main",
        source(FILE, "2:1"),
        el("div", source(FILE, "3:1")),
        el("aside", source(FILE, "4:1")),
        el("div", source(FILE, "5:1")),
      ),
    )
    const result = await lookup(calls, { body: live, picked: target, served })
    expect(result?.frames[0]?.line).toBe(5)
  })

  test("a node whose tag, id and class all agree is the picked element", async () => {
    const { calls, el } = world()
    const live = el("p", { id: "lead", class: "probe" })
    const served = el("body", {}, el("p", { id: "lead", class: "probe", ...source(FILE, "3:4") }))
    const result = await lookup(calls, { body: el("body", {}, live), picked: live, served })
    expect(result?.onPickedElement).toBe(true)
  })

  test("two elements with no id or class agree", async () => {
    const { calls, stage } = simple()
    expect((await lookup(calls, stage))?.onPickedElement).toBe(true)
  })

  test.each([
    ["a different id", { id: "lead", class: "probe" }, { id: "other", class: "probe" }],
    ["an id only the live element has", { id: "lead" }, {}],
    ["an id only the served element has", {}, { id: "lead" }],
    ["a different class", { class: "probe" }, { class: "other" }],
    ["a class removed from the live element", {}, { class: "probe" }],
    ["a class only the live element has", { class: "probe" }, {}],
  ])(
    "%s is approximate, with the served location",
    async (_label, liveAttributes, servedAttributes) => {
      const { calls, el } = world()
      const live = el("p", liveAttributes)
      const served = el("body", {}, el("p", { ...servedAttributes, ...source(FILE, "3:4") }))
      const result = await lookup(calls, { body: el("body", {}, live), picked: live, served })
      expect(result).toMatchObject({
        onPickedElement: false,
        frames: [{ kind: "source", file: FILE, line: 3, column: 4 }],
      })
    },
  )

  test("an unannotated node falls back to its nearest annotated ancestor", async () => {
    const { calls, el } = world()
    const live = el("p")
    const body = el("body", {}, el("main", {}, el("section", {}, live)))
    const served = el(
      "body",
      source("/work/Body.astro", "1:1"),
      el("main", source("/work/Main.astro", "5:1"), el("section", {}, el("p"))),
    )
    const result = await lookup(calls, { body, picked: live, served })
    expect(result).toMatchObject({
      component: "Main",
      onPickedElement: false,
      frames: [{ file: "/work/Main.astro", line: 5 }],
    })
  })

  test("a path that stops early falls back to the deepest annotated node reached", async () => {
    const { calls, el } = world()
    const live = el("div")
    const body = el("body", {}, el("main", {}, el("section", {}, el("div"), live)))
    const served = el(
      "body",
      source("/work/Body.astro", "1:1"),
      el(
        "main",
        source("/work/Main.astro", "5:1"),
        el("section", source("/work/Section.astro", "8:1"), el("div", source(FILE, "9:1"))),
      ),
    )
    const result = await lookup(calls, { body, picked: live, served })
    expect(result).toMatchObject({
      component: "Section",
      onPickedElement: false,
      frames: [{ file: "/work/Section.astro", line: 8 }],
    })
  })

  test("a body that is annotated is the fallback when the path leaves it at once", async () => {
    const { calls, el } = world()
    const live = el("aside")
    const body = el("body", {}, live)
    const served = el("body", source("/work/Body.astro", "2:1"), el("main"))
    const result = await lookup(calls, { body, picked: live, served })
    expect(result).toMatchObject({ onPickedElement: false, frames: [{ file: "/work/Body.astro" }] })
  })

  test("nothing annotated along the path gives no evidence", async () => {
    const { calls, el } = world()
    const live = el("p")
    const body = el("body", {}, el("main", {}, live))
    const served = el("body", {}, el("main", {}, el("p")))
    expect(await lookup(calls, { body, picked: live, served })).toBeNull()
  })

  test("a path that stops early with nothing annotated gives no evidence", async () => {
    const { calls, el } = world()
    const live = el("p")
    const body = el("body", {}, el("main", {}, el("p"), live))
    const served = el("body", {}, el("main", {}, el("p")), el("p", source(FILE, "3:4")))
    expect(await lookup(calls, { body, picked: live, served })).toBeNull()
  })
})

describe("non-goals", () => {
  test("a second lookup sees a changed served document", async () => {
    const { calls, el } = world()
    const live = el("p")
    const body = el("body", {}, live)
    const pages = ["first", "second"]
    const lines = []
    for (const [index, page] of pages.entries()) {
      const result = await lookup(calls, {
        body,
        picked: live,
        respond: async () => new Response(page),
        served: (html) =>
          el("body", {}, el("p", source(FILE, `${html === page ? (index + 1) * 10 : 0}:1`))),
      })
      lines.push(result?.frames[0]?.line)
    }
    expect(lines).toEqual([10, 20])
    expect(calls.fetches).toHaveLength(2)
  })

  test("a lookup leaves no listener and no observer on the page", async () => {
    const { calls, el, stage } = simple()
    await lookup(calls, stage)
    const live = el("p", source(FILE, "3:4"))
    await lookup(calls, { body: el("body", {}, live), picked: live })
    await lookup(calls, { ...stage, toolbar: true, generator: null })
    expect(calls.listeners).toBe(0)
    expect(calls.observers).toBe(0)
  })
})
