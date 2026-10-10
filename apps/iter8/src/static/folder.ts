import { watch } from "node:fs"
import { realpath, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

function insideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

export async function folderFile(root: string, url: string): Promise<string | null> {
  try {
    // URL parsing would normalize dot segments before containment can reject them.
    const pathname = decodeURIComponent(
      url.replace(/^[^:]+:\/\/[^/?#]+/, "").split(/[?#]/, 1)[0] || "/",
    )
    if (pathname.includes("\0")) return null

    const realRoot = await realpath(root)
    const resolved = resolve(realRoot, `.${pathname}`)
    if (!insideRoot(resolved, realRoot)) return null

    let path = await realpath(resolved)
    if (!insideRoot(path, realRoot)) return null
    if ((await stat(path)).isDirectory()) {
      path = await realpath(join(path, "index.html"))
      if (!insideRoot(path, realRoot)) return null
    }
    if (!(await stat(path)).isFile()) return null

    return path
  } catch {
    return null
  }
}

export async function serveFolder(req: Request, root: string): Promise<Response> {
  const path = await folderFile(root, req.url)
  if (path === null) return new Response(null, { status: 404 })
  try {
    const file = Bun.file(path)
    return new Response(file, {
      headers: { "content-type": file.type, "cache-control": "no-store" },
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

export function watchFolder(root: string, onChange: () => void): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const watcher = watch(root, { recursive: true }, () => {
    if (stopped) return
    clearTimeout(pending)
    // Editor saves can write a temporary file and then rename it into place.
    pending = setTimeout(() => {
      pending = undefined
      if (!stopped) onChange()
    }, 75)
  })

  return () => {
    stopped = true
    watcher.close()
    clearTimeout(pending)
    pending = undefined
  }
}
