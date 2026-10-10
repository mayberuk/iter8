import type { OverlayBoot } from "@iter8/protocol"
import { injectBoot } from "./inject"

export type ProxyTarget = {
  pageOrigin: string
  upstream: string
  /** Upstream origin to the page origin that serves it, for rewriting redirects. */
  originMap: ReadonlyMap<string, string>
  boot: OverlayBoot | null
}

export type ProxyDeps = { fetch: typeof fetch; onUpstreamFailure: (upstream: string) => void }

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade"]
const DECODED_BY_FETCH = new Set(["gzip", "x-gzip", "deflate", "br", "zstd"])
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

function withoutHopByHop(source: Headers): Headers {
  const headers = new Headers(source)
  const named = (source.get("connection") ?? "").split(",").map((name) => name.trim())
  for (const name of [...HOP_BY_HOP, ...named]) if (name !== "") headers.delete(name)
  for (const name of [...headers.keys()]) if (name.startsWith("proxy-")) headers.delete(name)
  return headers
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

export function failurePage(status: number, title: string, reason: string): Response {
  const body = `<!doctype html>
<html><head><meta charset="utf-8"><title>iter8: ${escapeHtml(title)}</title></head>
<body><h1>iter8: ${escapeHtml(title)}</h1><p>${escapeHtml(reason)}</p></body></html>
`
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  })
}

function upstreamRequest(req: Request, target: ProxyTarget): Request {
  const url = new URL(req.url)
  const upstream = new URL(target.upstream)
  const page = new URL(target.pageOrigin)
  // Concatenated, not resolved: a path starting with `//` would otherwise name another host.
  const destination = `${upstream.origin}${url.pathname}${url.search}`

  const headers = withoutHopByHop(req.headers)
  headers.set("host", upstream.host)
  headers.set("x-forwarded-host", page.host)
  headers.set("x-forwarded-proto", page.protocol.slice(0, -1))
  if (headers.get("origin") === page.origin) headers.set("origin", upstream.origin)
  const referer = URL.parse(headers.get("referer") ?? "")
  if (referer?.origin === page.origin) {
    headers.set("referer", `${upstream.origin}${referer.pathname}${referer.search}${referer.hash}`)
  }
  // An upstream 304 to a conditional navigation would let the browser reuse a cached copy
  // that was never injected.
  const navigation =
    headers.get("sec-fetch-dest") === "document" ||
    (headers.get("accept") ?? "").includes("text/html")
  if (navigation) {
    headers.delete("if-none-match")
    headers.delete("if-modified-since")
  }

  // Bun's RequestInit type lacks the standard `duplex` member that a streamed body requires.
  const init: RequestInit & { duplex: "half" } = {
    method: req.method,
    headers,
    body: req.body,
    duplex: "half",
    redirect: "manual",
    signal: req.signal,
  }
  return new Request(destination, init)
}

/** Forwards `req` to the target's upstream and injects the overlay boot into an HTML reply. */
export async function proxyHttp(
  req: Request,
  target: ProxyTarget,
  deps: ProxyDeps,
): Promise<Response> {
  const outbound = upstreamRequest(req, target)
  let res: Response
  try {
    res = await deps.fetch(outbound)
  } catch (error) {
    if (req.signal.aborted) return new Response(null, { status: 499 })
    deps.onUpstreamFailure(target.upstream)
    const reason = error instanceof Error ? error.message : String(error)
    return failurePage(502, "cannot reach the app", `${target.upstream} did not answer: ${reason}`)
  }

  const headers = withoutHopByHop(res.headers)
  const encoding = (headers.get("content-encoding") ?? "").trim().toLowerCase()
  if (DECODED_BY_FETCH.has(encoding)) {
    headers.delete("content-encoding")
    headers.delete("content-length")
  }
  const decoded = encoding === "" || encoding === "identity" || DECODED_BY_FETCH.has(encoding)

  const location = headers.get("location")
  if (location !== null) {
    const resolved = URL.parse(location, outbound.url)
    const mapped = resolved ? target.originMap.get(resolved.origin) : undefined
    if (resolved && mapped !== undefined) {
      headers.set("location", `${mapped}${resolved.pathname}${resolved.search}${resolved.hash}`)
    }
  }

  const body = NULL_BODY_STATUS.has(res.status) ? null : res.body
  const mediaType = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase()
  const inject = target.boot !== null && mediaType === "text/html" && body !== null
  if (inject && !decoded) {
    await body.cancel()
    return failurePage(
      502,
      "cannot inject into this response",
      `${target.upstream} sent HTML with content-encoding "${encoding}", which iter8 cannot decode, so the overlay cannot be added to it.`,
    )
  }
  const forwarded = new Response(body, { status: res.status, statusText: res.statusText, headers })
  return inject && target.boot ? injectBoot(forwarded, target.boot, target.pageOrigin) : forwarded
}
