import { realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ResolvedSourceLead, type SourceFrame, type SourceLead } from "@iter8/protocol"
import { FlattenMap, originalPositionFor, type TraceMap } from "@jridgewell/trace-mapping"

export type SymbolicateScope = {
  projectRoot: string
  pageOrigin: string
  upstream: string | null
  folderRoot: string | null
}

export type Symbolicator = {
  resolve(lead: SourceLead, scope: SymbolicateScope): Promise<ResolvedSourceLead>
}

const reactServerPrefix =
  /^(?:rsc|about):\/\/React\/Server\/(?=file:\/\/\/|webpack-internal:\/\/\/)/

const excluded = new Set([
  "node_modules",
  ".next",
  ".svelte-kit",
  ".astro",
  ".vite",
  ".turbo",
  ".output",
  "dist",
  "build",
])

function inside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function hasExcludedSegment(root: string, path: string): boolean {
  return (
    inside(root, path) &&
    relative(root, path)
      .split(sep)
      .some((s) => excluded.has(s))
  )
}

function mapComment(script: string): string | null {
  let last: string | null = null
  for (const match of script.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/g)) {
    last = match[1] ?? null
  }
  return last
}

function sourcePath(source: string, scope: SymbolicateScope): string {
  let path = source
    .replace(/^webpack:\/\/[^/]*\//, "")
    .replace(/^turbopack:\/\/\/\[project\]\//, "")
    .replace(/^\[project\]\//, "")
  if (path.startsWith("file://")) path = fileURLToPath(path)
  else if (/^https?:\/\//.test(path)) path = decodeURIComponent(new URL(path).pathname)
  path = path.replace(/^\/@fs\/?/, "/")
  return isAbsolute(path) ? path : resolve(scope.projectRoot, path)
}

export function createSymbolicator(deps: {
  fetch: typeof fetch
  readFile: (path: string) => Promise<string | null>
}): Symbolicator {
  const maps = new Map<string, Promise<TraceMap | null>>()

  async function loadMap(scriptUrl: URL): Promise<TraceMap | null> {
    let script: string | null
    let reference: string | null
    if (scriptUrl.protocol === "file:") {
      const path = fileURLToPath(scriptUrl)
      script = await deps.readFile(path)
      if (script === null) return null
      reference = mapComment(script) ?? `${scriptUrl.pathname}.map`
    } else {
      const response = await deps.fetch(scriptUrl)
      if (!response.ok) return null
      script = await response.text()
      reference =
        response.headers.get("SourceMap") ??
        response.headers.get("X-SourceMap") ??
        mapComment(script)
    }
    if (!reference) return null
    reference = reference.trim()
    if (reference.startsWith("data:")) {
      const match = /^data:application\/json(?:;[^,]*)?;base64,(.*)$/s.exec(reference)
      if (!match?.[1]) return null
      return new FlattenMap(Buffer.from(match[1], "base64").toString("utf8"), scriptUrl.href)
    }
    const mapUrl = new URL(reference, scriptUrl)
    let text: string | null
    if (mapUrl.protocol === "file:") {
      text = await deps.readFile(fileURLToPath(mapUrl))
    } else {
      const response = await deps.fetch(mapUrl)
      if (!response.ok) return null
      text = await response.text()
    }
    return text === null ? null : new FlattenMap(text, mapUrl.href)
  }

  function cachedMap(scriptUrl: URL): Promise<TraceMap | null> {
    const key = scriptUrl.protocol === "file:" ? fileURLToPath(scriptUrl) : scriptUrl.href
    const cached = maps.get(key)
    if (cached) return cached
    const pending: Promise<TraceMap | null> = loadMap(scriptUrl)
      .catch(() => null)
      .then((map) => {
        if (map === null && maps.get(key) === pending) maps.delete(key)
        return map
      })
    maps.set(key, pending)
    if (maps.size > 64) {
      const oldest = maps.keys().next().value
      if (oldest !== undefined) maps.delete(oldest)
    }
    return pending
  }

  async function frameSource(frame: SourceFrame, scope: SymbolicateScope) {
    if (frame.kind === "source") return frame
    const reactServer = reactServerPrefix.exec(frame.file)
    const location = reactServer ? frame.file.slice(reactServer[0].length) : frame.file
    if (location.startsWith("webpack-internal:///")) {
      return {
        ...frame,
        file: location.replace(/^webpack-internal:\/\/\/(?:\([^/]*\)\/)?/, "").replace(/\?.*$/, ""),
      }
    }

    let scriptUrl: URL
    if (reactServer) {
      scriptUrl = new URL(location)
      scriptUrl.search = ""
      scriptUrl.hash = ""
    } else {
      const pageUrl = new URL(frame.file)
      if (pageUrl.origin !== new URL(scope.pageOrigin).origin) return null
      if (scope.upstream) {
        scriptUrl = new URL(`${new URL(scope.upstream).origin}${pageUrl.pathname}${pageUrl.search}`)
      } else if (scope.folderRoot) {
        const folderRoot = await realpath(scope.folderRoot)
        const path = await realpath(join(folderRoot, decodeURIComponent(pageUrl.pathname)))
        if (!inside(folderRoot, path)) return null
        scriptUrl = pathToFileURL(path)
      } else return null
    }
    if (frame.line === undefined) return null
    const map = await cachedMap(scriptUrl)
    if (!map) return null
    const original = originalPositionFor(map, {
      line: frame.line,
      column: (frame.column ?? 1) - 1,
    })
    if (original.source === null) return null
    const source = map.sources[map.resolvedSources.indexOf(original.source)]
    let file = original.source
    if (source?.startsWith("[project]/")) file = source
    else if (source && map.sourceRoot?.startsWith("[project]/") && !isAbsolute(source)) {
      file = `${map.sourceRoot.replace(/\/?$/, "/")}${source}`
    }
    return { ...frame, file, line: original.line, column: original.column + 1 }
  }

  return {
    async resolve(lead, scope) {
      if (lead.confidence === "none") {
        return ResolvedSourceLead.parse({ confidence: "none", reason: "no-framework" })
      }
      const projectRoot = await realpath(scope.projectRoot).catch(() => null)
      let rejected = false
      if (projectRoot) {
        for (const frame of lead.frames) {
          try {
            const source = await frameSource(frame, scope)
            if (!source) continue
            let path = sourcePath(source.file, scope)
            let canonical = await realpath(path).catch(() => null)
            if (canonical === null && isAbsolute(path) && !inside(scope.projectRoot, path)) {
              path = join(scope.projectRoot, path)
              canonical = await realpath(path).catch(() => null)
            }
            if (canonical === null) continue
            const file = relative(projectRoot, canonical).split(sep).join("/")
            if (
              !file ||
              !inside(projectRoot, canonical) ||
              hasExcludedSegment(scope.projectRoot, path) ||
              hasExcludedSegment(projectRoot, path) ||
              hasExcludedSegment(projectRoot, canonical)
            ) {
              rejected = true
              continue
            }
            return ResolvedSourceLead.parse({
              confidence: lead.confidence,
              framework: lead.framework,
              component: lead.component,
              file,
              ...(lead.confidence === "file-only"
                ? {}
                : {
                    ...(source.line === undefined ? {} : { line: source.line }),
                    ...(source.column === undefined ? {} : { column: source.column }),
                  }),
            })
          } catch {
            // A missing or malformed map must not hide a later usable frame.
          }
        }
      }
      return ResolvedSourceLead.parse({
        confidence: "none",
        reason: rejected ? "outside-project" : "no-frames-resolved",
      })
    },
  }
}
