import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { type SourceFrame, SourceLead } from "@iter8/protocol"
import type { Server } from "bun"
import fc from "fast-check"
import { createSymbolicator, type SymbolicateScope } from "./symbolicate"

const pageOrigin = "http://cardinal.localhost:3990"
const marker = "iter8_unique_source_literal"
const cardSource = [
  "export function card(): string {",
  "  const before: number = 7",
  "  if (before < 0) return 'unused'",
  `  return "${marker}"`,
  "}",
  "",
].join("\n")

function lead(frames: SourceFrame[], confidence: "exact" | "approximate" | "file-only" = "exact") {
  return SourceLead.parse({
    confidence,
    framework: "react",
    build: "vite",
    component: "Card",
    frames,
  })
}

async function readText(path: string) {
  return readFile(path, "utf8").catch(() => null)
}

function mapText(source: string, sourceRoot = "") {
  return JSON.stringify({
    version: 3,
    sources: [source],
    sourceRoot,
    names: [],
    mappings: "KAGE",
  })
}

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0]) => handler(String(input)), {
    preconnect: fetch.preconnect,
  })
}

function position(text: string) {
  const index = text.indexOf(`"${marker}"`)
  expect(index).toBeGreaterThanOrEqual(0)
  const prefix = text.slice(0, index).split("\n")
  return { line: prefix.length, column: (prefix.at(-1)?.length ?? 0) + 1 }
}

describe("symbolication", () => {
  let scratch: string
  let projectRoot: string
  let scope: SymbolicateScope
  const servers: Server<undefined>[] = []

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "iter8-symbolicate-"))
    projectRoot = join(scratch, "project")
    await mkdir(join(projectRoot, "src"), { recursive: true })
    await writeFile(join(projectRoot, "src/Card.ts"), cardSource)
    scope = {
      projectRoot,
      pageOrigin,
      upstream: "http://127.0.0.1:5173",
      folderRoot: null,
    }
  })

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true)
    await rm(scratch, { recursive: true, force: true })
  })

  async function build(sourcemap: "external" | "inline") {
    await writeFile(
      join(projectRoot, "src/main.ts"),
      'import { card } from "./Card"\nconsole.log(card())\n',
    )
    const outdir = join(projectRoot, "output")
    const result = await Bun.build({
      entrypoints: [join(projectRoot, "src/main.ts")],
      outdir,
      sourcemap,
      target: "browser",
    })
    expect(result.success).toBe(true)
    const output = result.outputs.find((artifact) => artifact.kind === "entry-point")
    if (!output) throw new Error("Build did not produce an entry point")
    return { file: output.path, script: await output.text(), outdir }
  }

  test.each(["external", "inline"] as const)(
    "maps a proxy-origin frame through a real Bun %s source map",
    async (sourcemap) => {
      const built = await build(sourcemap)
      const counts = new Map<string, number>()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname
          counts.set(path, (counts.get(path) ?? 0) + 1)
          const text = await readText(join(built.outdir, basename(path)))
          if (text === null) return new Response(null, { status: 404 })
          const headers =
            sourcemap === "external" && path.endsWith(".js")
              ? { SourceMap: `${basename(built.file)}.map` }
              : {}
          return new Response(text, { headers })
        },
      })
      servers.push(server)
      const symbolicator = createSymbolicator({ fetch, readFile: readText })
      const frames: SourceFrame[] = [
        {
          kind: "generated",
          file: `${pageOrigin}/output/${basename(built.file)}`,
          ...position(built.script),
        },
      ]
      const serverScope = { ...scope, upstream: server.url.origin }
      const expected = {
        confidence: "exact",
        framework: "react",
        component: "Card",
        file: "src/Card.ts",
        ...position(cardSource),
      }
      expect<unknown>(await symbolicator.resolve(lead(frames), serverScope)).toEqual(expected)
      expect<unknown>(await symbolicator.resolve(lead(frames), serverScope)).toEqual(expected)
      expect(counts.get(`/output/${basename(built.file)}`)).toBe(1)
      if (sourcemap === "external") {
        expect(counts.get(`/output/${basename(built.file)}.map`)).toBe(1)
      }
    },
  )

  const inlineMapScript = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(mapText("/src/Card.ts")).toString("base64")}\n`
  const generatedAt = (url: string) => lead([{ kind: "generated", file: url, line: 1, column: 6 }])
  const resolvedCard = {
    confidence: "exact",
    framework: "react",
    component: "Card",
    file: "src/Card.ts",
    line: 4,
    column: 3,
  }

  test.each([
    "http://other.localhost:3990/chunk.js",
    "http://cardinal.localhost:3991/chunk.js",
    "https://cardinal.localhost:3990/chunk.js",
  ])("a generated frame from another origin is skipped without a fetch: %s", async (url) => {
    const fetched: string[] = []
    const symbolicator = createSymbolicator({
      fetch: fakeFetch((requested) => {
        fetched.push(requested)
        return new Response(inlineMapScript)
      }),
      readFile: readText,
    })
    expect(await symbolicator.resolve(generatedAt(url), scope)).toEqual({
      confidence: "none",
      reason: "no-frames-resolved",
    })
    expect(fetched).toEqual([])
    expect(
      await symbolicator.resolve(
        lead([
          { kind: "generated", file: url, line: 1, column: 6 },
          { kind: "source", file: "src/Card.ts", line: 4, column: 3 },
        ]),
        scope,
      ),
    ).toMatchObject({ confidence: "exact", file: "src/Card.ts" })
    expect(fetched).toEqual([])
  })

  describe("folder pages", () => {
    let folderRoot: string
    let reads: string[]

    beforeEach(async () => {
      folderRoot = join(projectRoot, "pages")
      await mkdir(folderRoot, { recursive: true })
      await writeFile(join(folderRoot, "ok.js"), inlineMapScript)
      await writeFile(join(projectRoot, "outside.js"), inlineMapScript)
      await symlink(join(projectRoot, "outside.js"), join(folderRoot, "link.js"))
      reads = []
    })

    const resolveInFolder = (path: string) =>
      createSymbolicator({
        fetch: fakeFetch(() => {
          throw new Error("Folder pages must not use fetch")
        }),
        readFile: async (file) => {
          reads.push(file)
          return readText(file)
        },
      }).resolve(generatedAt(`${pageOrigin}${path}`), { ...scope, upstream: null, folderRoot })

    test("a script inside the folder is read from it", async () => {
      expect(await resolveInFolder("/ok.js")).toMatchObject(resolvedCard)
    })

    test.each(["/..%2Foutside.js", "/%2E%2E%2Foutside.js"])(
      "a script path that climbs out of the folder is refused: %s",
      async (path) => {
        expect(await resolveInFolder(path)).toEqual({
          confidence: "none",
          reason: "no-frames-resolved",
        })
        expect(reads.filter((file) => file.endsWith("outside.js"))).toEqual([])
      },
    )

    test("a symlink that leaves the folder is refused", async () => {
      expect(await resolveInFolder("/link.js")).toEqual({
        confidence: "none",
        reason: "no-frames-resolved",
      })
      expect(reads.filter((file) => file.endsWith("outside.js"))).toEqual([])
    })
  })

  test.each(["comment", "sibling"] as const)(
    "maps an rsc disk chunk using its %s map",
    async (reference) => {
      const built = await build("external")
      if (reference === "comment") {
        await writeFile(
          built.file,
          `${built.script}\n//# sourceMappingURL=${basename(built.file)}.map\n`,
        )
      }
      const symbolicator = createSymbolicator({
        fetch: fakeFetch(() => {
          throw new Error("Disk chunks must not use fetch")
        }),
        readFile: readText,
      })
      expect(
        await symbolicator.resolve(
          lead([
            {
              kind: "generated",
              file: `rsc://React/Server/${pathToFileURL(built.file).href}?17`,
              ...position(built.script),
            },
          ]),
          scope,
        ),
      ).toEqual({
        confidence: "exact",
        framework: "react",
        component: "Card",
        file: "src/Card.ts",
        ...position(cardSource),
      })
    },
  )

  test("maps folder-page scripts and relative external maps from disk", async () => {
    const built = await build("external")
    await writeFile(
      built.file,
      `${built.script}\n//# sourceMappingURL=${basename(built.file)}.map\n`,
    )
    const symbolicator = createSymbolicator({
      fetch: fakeFetch(() => {
        throw new Error("Folder pages must not use fetch")
      }),
      readFile: readText,
    })
    expect(
      await symbolicator.resolve(
        lead([
          {
            kind: "generated",
            file: `${pageOrigin}/output/${basename(built.file)}`,
            ...position(built.script),
          },
        ]),
        { ...scope, upstream: null, folderRoot: projectRoot },
      ),
    ).toEqual({
      confidence: "exact",
      framework: "react",
      component: "Card",
      file: "src/Card.ts",
      ...position(cardSource),
    })
  })

  test.each(["(app-pages-browser)/./", "./", "(ssr)/"])(
    "keeps webpack-internal module positions with prefix %s",
    async (prefix) => {
      const symbolicator = createSymbolicator({ fetch, readFile: readText })
      expect(
        await symbolicator.resolve(
          lead(
            [
              {
                kind: "generated",
                file: `webpack-internal:///${prefix}src/Card.ts`,
                line: 11,
                column: 13,
              },
            ],
            "approximate",
          ),
          scope,
        ),
      ).toEqual({
        confidence: "approximate",
        framework: "react",
        component: "Card",
        file: "src/Card.ts",
        line: 11,
        column: 13,
      })
    },
  )

  test.each([
    "webpack://app/./src/Card.ts",
    "webpack:///./src/Card.ts",
    "turbopack:///[project]/src/Card.ts",
    "[project]/src/Card.ts",
    "/src/Card.ts",
    "src/Card.ts",
  ])("normalizes the source path %s", async (file) => {
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    expect(await symbolicator.resolve(lead([{ kind: "source", file }]), scope)).toEqual({
      confidence: "exact",
      framework: "react",
      component: "Card",
      file: "src/Card.ts",
    })
  })

  test("normalizes absolute file URLs and Vite filesystem paths", async () => {
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    for (const file of [
      pathToFileURL(join(projectRoot, "src/Card.ts")).href,
      `/@fs${join(projectRoot, "src/Card.ts")}`,
    ]) {
      expect(await symbolicator.resolve(lead([{ kind: "source", file }]), scope)).toMatchObject({
        confidence: "exact",
        file: "src/Card.ts",
      })
    }
  })

  test.each([
    "node_modules",
    ".next",
    ".svelte-kit",
    ".astro",
    ".vite",
    ".turbo",
    ".output",
    "dist",
    "build",
  ])("skips an existing %s frame in favor of the next source frame", async (directory) => {
    await mkdir(join(projectRoot, directory), { recursive: true })
    await writeFile(join(projectRoot, directory, "Card.ts"), "generated")
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    const excludedFrame: SourceFrame = { kind: "source", file: `${directory}/Card.ts` }
    expect(await symbolicator.resolve(lead([excludedFrame]), scope)).toEqual({
      confidence: "none",
      reason: "outside-project",
    })
    expect(
      await symbolicator.resolve(
        lead([excludedFrame, { kind: "source", file: "src/Card.ts", line: 4 }]),
        scope,
      ),
    ).toMatchObject({ confidence: "exact", file: "src/Card.ts", line: 4 })
  })

  test.each(["build", "dist", "node_modules"])(
    "excluded names count only below the project root, not in its ancestors: %s",
    async (ancestor) => {
      const nestedRoot = join(scratch, ancestor, "app")
      await mkdir(join(nestedRoot, "src"), { recursive: true })
      await mkdir(join(nestedRoot, "dist"), { recursive: true })
      await writeFile(join(nestedRoot, "src/Card.ts"), cardSource)
      await writeFile(join(nestedRoot, "dist/Card.ts"), "generated")
      const nestedScope = { ...scope, projectRoot: nestedRoot }
      const symbolicator = createSymbolicator({ fetch, readFile: readText })
      for (const file of [
        "src/Card.ts",
        "/src/Card.ts",
        join(nestedRoot, "src/Card.ts"),
        pathToFileURL(join(nestedRoot, "src/Card.ts")).href,
        `/@fs${join(nestedRoot, "src/Card.ts")}`,
      ]) {
        expect(
          await symbolicator.resolve(lead([{ kind: "source", file }]), nestedScope),
        ).toMatchObject({ confidence: "exact", file: "src/Card.ts" })
      }
      expect(
        await symbolicator.resolve(lead([{ kind: "source", file: "dist/Card.ts" }]), nestedScope),
      ).toEqual({ confidence: "none", reason: "outside-project" })
    },
  )

  test("rejects parent traversal, absolute outside paths, and symlinks escaping the root", async () => {
    const outside = join(scratch, "outside.ts")
    await writeFile(outside, "outside")
    await symlink(outside, join(projectRoot, "src/link.ts"))
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    for (const file of ["../outside.ts", outside, pathToFileURL(outside).href, "src/link.ts"]) {
      expect(await symbolicator.resolve(lead([{ kind: "source", file }]), scope)).toEqual({
        confidence: "none",
        reason: "outside-project",
      })
    }
    expect(
      await symbolicator.resolve(
        lead([
          { kind: "source", file: "missing.ts" },
          { kind: "source", file: "../outside.ts" },
        ]),
        scope,
      ),
    ).toEqual({ confidence: "none", reason: "outside-project" })
  })

  test("checks containment against the real project root", async () => {
    const alias = join(scratch, "alias")
    await symlink(projectRoot, alias)
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    expect(
      await symbolicator.resolve(lead([{ kind: "source", file: "src/Card.ts" }]), {
        ...scope,
        projectRoot: alias,
      }),
    ).toMatchObject({ confidence: "exact", file: "src/Card.ts" })
  })

  test("file-only leads omit line and column", async () => {
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    expect(
      await symbolicator.resolve(
        lead([{ kind: "source", file: "src/Card.ts", line: 4, column: 10 }], "file-only"),
        scope,
      ),
    ).toEqual({
      confidence: "file-only",
      framework: "react",
      component: "Card",
      file: "src/Card.ts",
    })
  })

  test("resolved leads preserve confidence, framework, component, and source positions", async () => {
    const symbolicator = createSymbolicator({ fetch, readFile: readText })
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("exact", "approximate", "file-only"),
        fc.constantFrom("react", "svelte", "vue", "astro"),
        fc.option(fc.string(), { nil: null }),
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        async (confidence, framework, component, line, column) => {
          const source = SourceLead.parse({
            confidence,
            framework,
            build: "unknown",
            component,
            frames: [{ kind: "source", file: "src/Card.ts", line, column }],
          })
          expect<unknown>(await symbolicator.resolve(source, scope)).toEqual({
            confidence,
            framework,
            component,
            file: "src/Card.ts",
            ...(confidence === "file-only" ? {} : { line, column }),
          })
        },
      ),
    )
  })

  test("none leads resolve without touching boundaries", async () => {
    const symbolicator = createSymbolicator({
      fetch: fakeFetch(() => {
        throw new Error("No framework has no script to fetch")
      }),
      readFile: async () => {
        throw new Error("No framework has no file to read")
      },
    })
    expect(
      await symbolicator.resolve({ confidence: "none" }, { ...scope, projectRoot: "/missing" }),
    ).toEqual({ confidence: "none", reason: "no-framework" })
  })

  test.each(["no map", "invalid map", "missing script", "unmapped position"])(
    "%s falls through to a later frame or returns no-frames-resolved",
    async (failure) => {
      const symbolicator = createSymbolicator({
        fetch: fakeFetch((url) => {
          if (failure === "missing script") return new Response(null, { status: 404 })
          if (url.endsWith(".map")) {
            return new Response(failure === "invalid map" ? "invalid" : mapText("/src/Card.ts"))
          }
          return new Response(
            failure === "no map" ? "console.log(1)" : "//# sourceMappingURL=chunk.js.map",
          )
        }),
        readFile: readText,
      })
      const generated: SourceFrame = {
        kind: "generated",
        file: `${pageOrigin}/chunk.js`,
        line: failure === "unmapped position" ? 99 : 1,
        column: 6,
      }
      expect(await symbolicator.resolve(lead([generated]), scope)).toEqual({
        confidence: "none",
        reason: "no-frames-resolved",
      })
      expect(
        await symbolicator.resolve(
          lead([generated, { kind: "source", file: "src/Card.ts" }]),
          scope,
        ),
      ).toMatchObject({ confidence: "exact", file: "src/Card.ts" })
    },
  )

  test.each(["SourceMap", "X-SourceMap", "last comment"])(
    "loads the map from %s and resolves sourceRoot relative to the map URL",
    async (location) => {
      const calls: string[] = []
      const symbolicator = createSymbolicator({
        fetch: fakeFetch((url) => {
          calls.push(url)
          if (url.endsWith("/maps/chunk.map")) {
            return new Response(mapText("Card.ts", "../../src/"))
          }
          const script =
            location === "last comment"
              ? "//# sourceMappingURL=wrong.map\n//# sourceMappingURL=../maps/chunk.map"
              : "//# sourceMappingURL=wrong.map"
          const headers =
            location === "last comment"
              ? {}
              : { "X-SourceMap": "wrong-header.map", [location]: "../maps/chunk.map" }
          return new Response(script, { headers })
        }),
        readFile: readText,
      })
      expect(
        await symbolicator.resolve(
          lead([
            { kind: "generated", file: `${pageOrigin}/output/chunk.js?v=3`, line: 1, column: 6 },
          ]),
          scope,
        ),
      ).toMatchObject({ file: "src/Card.ts", line: 4, column: 3 })
      expect(calls).toEqual([
        "http://127.0.0.1:5173/output/chunk.js?v=3",
        "http://127.0.0.1:5173/maps/chunk.map",
      ])
    },
  )

  test.each([
    ["webpack://app/./src/Card.ts", ""],
    ["turbopack:///[project]/src/Card.ts", ""],
    ["[project]/src/Card.ts", ""],
    ["Card.ts", "[project]/src/"],
  ])("normalizes mapped source %s with root %s", async (source, sourceRoot) => {
    const symbolicator = createSymbolicator({
      fetch: fakeFetch(
        (url) =>
          new Response(
            url.endsWith(".map")
              ? mapText(source, sourceRoot)
              : "//# sourceMappingURL=chunk.js.map",
          ),
      ),
      readFile: readText,
    })
    expect(
      await symbolicator.resolve(
        lead([{ kind: "generated", file: `${pageOrigin}/output/chunk.js`, line: 1, column: 6 }]),
        scope,
      ),
    ).toMatchObject({ confidence: "exact", file: "src/Card.ts", line: 4, column: 3 })
  })

  test.each(["a 500 reply", "a thrown fetch", "a missing map"] as const)(
    "a failed map load (%s) is retried on the next lookup, and a loaded map stays cached",
    async (failure) => {
      const counts = { script: 0, map: 0 }
      let healthy = false
      const symbolicator = createSymbolicator({
        fetch: fakeFetch((url) => {
          if (url.endsWith(".map")) {
            counts.map++
            if (healthy) return new Response(mapText("/src/Card.ts"))
            if (failure === "a thrown fetch") throw new Error("connection reset")
            return new Response(null, { status: failure === "a 500 reply" ? 500 : 404 })
          }
          counts.script++
          return new Response("//# sourceMappingURL=chunk.js.map")
        }),
        readFile: readText,
      })
      const frames = [
        { kind: "generated", file: `${pageOrigin}/chunk.js`, line: 1, column: 6 },
      ] as const
      const generated = lead([...frames])

      expect(await symbolicator.resolve(generated, scope)).toEqual({
        confidence: "none",
        reason: "no-frames-resolved",
      })
      expect(counts).toEqual({ script: 1, map: 1 })

      healthy = true
      const expected = { confidence: "exact", framework: "react", component: "Card" }
      expect(await symbolicator.resolve(generated, scope)).toMatchObject({
        ...expected,
        file: "src/Card.ts",
      })
      expect(counts).toEqual({ script: 2, map: 2 })

      healthy = false
      expect(await symbolicator.resolve(generated, scope)).toMatchObject(expected)
      expect(counts).toEqual({ script: 2, map: 2 })
    },
  )

  test("converts both column bases and caches concurrent resolutions", async () => {
    let fetches = 0
    const symbolicator = createSymbolicator({
      fetch: fakeFetch((url) => {
        fetches++
        return new Response(
          url.endsWith(".map") ? mapText("/src/Card.ts") : "//# sourceMappingURL=chunk.js.map",
        )
      }),
      readFile: readText,
    })
    const generated = (column: number) =>
      lead([{ kind: "generated", file: `${pageOrigin}/chunk.js`, line: 1, column }])
    const results = await Promise.all([
      symbolicator.resolve(generated(6), scope),
      symbolicator.resolve(generated(6), scope),
    ])
    for (const result of results) {
      expect(result).toMatchObject({ confidence: "exact", file: "src/Card.ts", line: 4, column: 3 })
    }
    expect(await symbolicator.resolve(generated(5), scope)).toEqual({
      confidence: "none",
      reason: "no-frames-resolved",
    })
    expect(fetches).toBe(2)
  })

  test("evicts the oldest cached map after 64 script entries", async () => {
    const counts = new Map<string, number>()
    const symbolicator = createSymbolicator({
      fetch: fakeFetch((url) => {
        counts.set(url, (counts.get(url) ?? 0) + 1)
        return new Response(
          `//# sourceMappingURL=data:application/json;base64,${Buffer.from(
            mapText("/src/Card.ts"),
          ).toString("base64")}`,
        )
      }),
      readFile: readText,
    })
    const resolveScript = (index: number) =>
      symbolicator.resolve(
        lead([{ kind: "generated", file: `${pageOrigin}/chunk-${index}.js`, line: 1, column: 6 }]),
        scope,
      )
    for (let index = 0; index < 64; index++) await resolveScript(index)
    await resolveScript(0)
    expect(counts.get("http://127.0.0.1:5173/chunk-0.js")).toBe(1)
    await resolveScript(64)
    await resolveScript(0)
    expect(counts.get("http://127.0.0.1:5173/chunk-0.js")).toBe(2)
    await resolveScript(63)
    expect(counts.get("http://127.0.0.1:5173/chunk-63.js")).toBe(1)
  })
})
