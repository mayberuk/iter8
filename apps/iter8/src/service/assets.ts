import { isAbsolute, relative, resolve, sep } from "node:path"
import { ENV } from "@iter8/protocol"

export function resolveOverlayDir(
  env: Record<string, string | undefined>,
  embeddedDir: string,
  repoDir: string,
  standalone: boolean = Bun.isStandaloneExecutable,
): string {
  return env[ENV.overlayDir] || (standalone ? embeddedDir : repoDir)
}

/**
 * `pathname` is the still-encoded path below the asset prefix. A missing file is a 404, which the
 * overlay reads as source lookup being unavailable.
 */
export async function serveAsset(overlayDir: string, pathname: string): Promise<Response> {
  const notFound = new Response(null, { status: 404 })
  const root = resolve(overlayDir)
  let path: string
  try {
    path = resolve(root, decodeURIComponent(pathname))
  } catch {
    return notFound
  }
  const fromRoot = relative(root, path)
  if (
    !fromRoot ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    path.includes("\0")
  ) {
    return notFound
  }
  const file = Bun.file(path)
  if (!(await file.exists())) return notFound
  // The overlay changes with the service version, so a cached copy must be revalidated.
  return new Response(file, { headers: { "content-type": file.type, "cache-control": "no-cache" } })
}
