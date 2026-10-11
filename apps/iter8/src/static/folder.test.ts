import { afterEach, describe, expect, test } from "bun:test"
import { watch } from "node:fs"
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { folderFile, serveFolder, watchFolder } from "./folder"

const directories: string[] = []
const stops: (() => void)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) stop()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "iter8-"))
  directories.push(path)
  return path
}

function request(path: string): Request {
  const req = new Request("http://mock.localhost/")
  // Request construction normalizes traversal before the serving boundary sees it.
  Object.defineProperty(req, "url", { value: `http://mock.localhost${path}` })
  return req
}

async function waitUntil(label: string, ready: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!ready()) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(`Timed out waiting for ${label}`)
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(5, remaining)))
  }
}

async function remainsUnchanged(
  read: () => number,
  expected: number,
  durationMs = 250,
): Promise<void> {
  const deadline = performance.now() + durationMs
  await waitUntil("the change observation deadline", () => {
    expect(read()).toBe(expected)
    return performance.now() >= deadline
  })
}

describe("folderFile", () => {
  test.each([
    ["/", "index.html"],
    ["/sub/", "sub/index.html"],
    ["/second.html?x=1#y", "second.html"],
  ])("resolves the served file at %s", async (url, file) => {
    const root = await folder()
    await mkdir(join(root, "sub"))
    for (const name of ["index.html", "sub/index.html", "second.html"]) {
      await writeFile(join(root, name), `<body>${name}</body>`)
    }
    expect(await folderFile(root, `http://mock.localhost${url}`)).toBe(
      await realpath(join(root, file)),
    )
    expect(await (await serveFolder(request(url), root)).text()).toBe(`<body>${file}</body>`)
  })

  test.each([
    "/../secret.html",
    "/%2e%2e/secret.html",
    "/link.html",
    "/missing.html",
    "/\0",
    "/%00",
  ])("refuses an unserved file at %s", async (url) => {
    const parent = await folder()
    const root = join(parent, "page")
    await mkdir(root)
    await writeFile(join(parent, "secret.html"), "outside")
    await symlink(join(parent, "secret.html"), join(root, "link.html"))
    expect(await folderFile(root, `http://mock.localhost${url}`)).toBeNull()
  })
})

describe("serveFolder", () => {
  test.each(["/", "/docs", "/docs/", "/docs.v1", "/docs.v1/"])(
    "serves a directory's own index.html at %s without injection",
    async (path) => {
      const root = await folder()
      await mkdir(join(root, "docs"))
      await mkdir(join(root, "docs.v1"))
      const html = `<html><head></head><body>${path}</body></html>`
      const directory = path === "/" ? root : join(root, path.split("/")[1] ?? "")
      await writeFile(join(directory, "index.html"), html)
      const response = await serveFolder(request(path), root)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toStartWith("text/html")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.text()).toBe(html)
    },
  )

  test("decodes filenames, ignores queries, and serves the file's MIME type", async () => {
    const root = await folder()
    await writeFile(join(root, "style sheet.css"), "body { color: red }")
    const response = await serveFolder(request("/style%20sheet.css?v=2"), root)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith("text/css")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe("body { color: red }")
    expect(response.headers.has("etag")).toBe(false)
  })

  test("serves an existing extensionless file", async () => {
    const root = await folder()
    await writeFile(join(root, "LICENSE"), "license text")
    const response = await serveFolder(request("/LICENSE"), root)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("license text")
  })

  test.each(["/missing", "/missing.html", "/empty", "/empty/", "/%00", "/bad%ZZ"])(
    "returns 404 without a listing or SPA fallback at %s",
    async (path) => {
      const root = await folder()
      await writeFile(join(root, "index.html"), "root page")
      await mkdir(join(root, "empty"))
      expect((await serveFolder(request(path), root)).status).toBe(404)
    },
  )

  test.each(["../", "%2e%2e/", "%2E%2E%2f", "..%2f"])(
    "rejects traversal using %s to an existing sibling file",
    async (dots) => {
      const parent = await folder()
      const root = join(parent, "page")
      await mkdir(root)
      await mkdir(join(parent, "page-neighbor"))
      await writeFile(join(parent, "page-neighbor", "secret.html"), "outside")
      const response = await serveFolder(request(`/${dots}page-neighbor/secret.html`), root)
      expect(response.status).toBe(404)
    },
  )

  test("rejects a symlink to /etc", async () => {
    const root = await folder()
    await symlink("/etc", join(root, "system"))
    expect((await serveFolder(request("/system/passwd"), root)).status).toBe(404)
  })

  test("rejects a directory index that is a symlink outside the root", async () => {
    const parent = await folder()
    const root = join(parent, "page")
    await mkdir(root)
    await writeFile(join(parent, "secret.html"), "outside")
    await symlink(join(parent, "secret.html"), join(root, "index.html"))
    expect((await serveFolder(request("/"), root)).status).toBe(404)
  })

  test("accepts symlinks that stay inside the root and a symlinked root", async () => {
    const parent = await folder()
    const root = join(parent, "page")
    await mkdir(root)
    await writeFile(join(root, "index.html"), "inside")
    await symlink(root, join(parent, "alias"))
    await symlink(join(root, "index.html"), join(root, "linked.html"))
    const response = await serveFolder(request("/linked.html"), join(parent, "alias"))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("inside")
  })
})

describe("watchFolder", () => {
  test("reports a change in a nested subdirectory", async () => {
    const root = await folder()
    const nested = join(root, "one", "two")
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, "index.html"), "before")
    let calls = 0
    stops.push(watchFolder(root, () => calls++))
    await writeFile(join(nested, "index.html"), "after")
    await waitUntil("a nested file change", () => calls > 0)
    expect(calls).toBe(1)
    await remainsUnchanged(() => calls, 1)
  })

  test("debounces five writes and waits for the trailing quiet window", async () => {
    const root = await folder()
    let calls = 0
    let calledAt = 0
    stops.push(
      watchFolder(root, () => {
        calls++
        calledAt = performance.now()
      }),
    )
    let lastFile: string | null = null
    let observedAt = 0
    const witness = watch(root, (_event, filename) => {
      lastFile = filename
      observedAt = performance.now()
    })
    stops.push(() => witness.close())
    for (let i = 0; i < 5; i++) {
      const file = `file-${i}.html`
      await writeFile(join(root, file), String(i))
      await waitUntil(`the filesystem event for ${file}`, () => lastFile === file)
      if (i < 4) await remainsUnchanged(() => calls, 0, 15)
    }
    await waitUntil("the debounced write burst", () => calls > 0)
    expect(calls).toBe(1)
    expect(calledAt - observedAt).toBeGreaterThanOrEqual(70)
    await remainsUnchanged(() => calls, 1)
  })

  test("reports an editor save that writes a temporary file and renames it", async () => {
    const root = await folder()
    await writeFile(join(root, "index.html"), "before")
    let calls = 0
    stops.push(watchFolder(root, () => calls++))
    await writeFile(join(root, ".index.html.tmp"), "after")
    await rename(join(root, ".index.html.tmp"), join(root, "index.html"))
    await waitUntil("an editor save", () => calls > 0)
    expect(calls).toBe(1)
    await remainsUnchanged(() => calls, 1)
  })

  test("stop cancels a pending call and ignores subsequent changes", async () => {
    const root = await folder()
    let calls = 0
    const stop = watchFolder(root, () => calls++)
    stops.push(stop)
    let observed = false
    const witness = watch(root, () => {
      observed = true
    })
    stops.push(() => witness.close())
    await writeFile(join(root, "pending.html"), "pending")
    await waitUntil("the filesystem event before stopping", () => observed)
    expect(calls).toBe(0)
    stop()
    stop()
    await writeFile(join(root, "later.html"), "later")
    await remainsUnchanged(() => calls, 0)
  })
})
