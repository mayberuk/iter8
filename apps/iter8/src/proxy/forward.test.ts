import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { brotliCompressSync, constants, createGzip, zstdCompressSync } from "node:zlib"
import { OverlayBoot, renderBootScript } from "@iter8/protocol"
import { failurePage, type ProxyTarget, proxyHttp } from "./forward"

const PAGE = "http://larkspur.localhost:3990"
const boot = OverlayBoot.parse({
  protocolVersion: 1,
  pageId: "larkspur",
  machineId: "devbox-7f3a",
  machineName: "devbox",
  token: "q5Jx2lK9vT0wYbN3cR8mZ4hD1sF6gA7e",
  apiBase: "/__iter8",
  sourceBundleUrl: "/__iter8/assets/source.js",
})
const BOOT_TAG = `<script type="module">${renderBootScript(boot)}</script>`

type Seen = { method: string; url: string; headers: Record<string, string>; body: string }

let servers: Bun.Server<undefined>[] = []
afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop(true)))
  servers = []
})

function upstream(handle: (req: Request) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      seen.push({
        method: req.method,
        url: req.url,
        headers: Object.fromEntries(req.headers),
        body: await req.text(),
      })
      return handle(req)
    },
  })
  servers.push(server)
  const origin = server.url.origin
  const target: ProxyTarget = {
    pageOrigin: PAGE,
    upstream: origin,
    originMap: new Map([[origin, PAGE]]),
    boot,
  }
  return { origin, seen, target }
}

const failures: string[] = []
const deps = { fetch, onUpstreamFailure: (upstream: string) => failures.push(upstream) }
afterEach(() => {
  failures.length = 0
})

function pageRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${PAGE}${path}`, init)
}

async function moduleScripts(markup: string): Promise<string[]> {
  const texts: string[] = []
  let inModule = false
  await new HTMLRewriter()
    .on("script", {
      element(element) {
        inModule = element.getAttribute("type") === "module" && !element.hasAttribute("src")
        if (inModule) texts.push("")
      },
      text(chunk) {
        if (inModule) texts[texts.length - 1] += chunk.text
      },
    })
    .transform(new Response(markup))
    .text()
  return texts
}

describe("HTML responses", () => {
  test("gzip HTML streamed in two chunks arrives decoded, injected, and before the upstream finishes", async () => {
    let upstreamFinished = false
    const { target } = upstream(() => {
      const gzip = createGzip()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          gzip.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
          gzip.on("end", () => {
            upstreamFinished = true
            controller.close()
          })
          gzip.write("<html><head><title>t</title></head><body><p>one</p>")
          gzip.flush(constants.Z_SYNC_FLUSH)
          setTimeout(() => gzip.end("<p>two</p></body></html>"), 500)
        },
      })
      return new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" },
      })
    })

    const res = await proxyHttp(
      pageRequest("/", { headers: { accept: "text/html" } }),
      target,
      deps,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(res.headers.get("content-length")).toBeNull()

    const reader = res.body?.getReader()
    if (!reader) throw new Error("no body")
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(upstreamFinished).toBe(false)
    let text = decoder.decode(first.value, { stream: true })
    expect(text).toContain(BOOT_TAG)
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      text += decoder.decode(next.value, { stream: true })
    }
    expect(upstreamFinished).toBe(true)
    expect(text).toContain("<p>one</p><p>two</p>")
    const scripts = await moduleScripts(text)
    expect(scripts).toEqual([renderBootScript(boot)])
    const hash = createHash("sha256")
      .update(scripts[0] ?? "")
      .digest("base64")
    expect(hash).toBe(createHash("sha256").update(renderBootScript(boot)).digest("base64"))
  })

  test.each([
    ["gzip", (text: string) => Bun.gzipSync(text)],
    ["deflate", (text: string) => Bun.deflateSync(text)],
    ["br", (text: string) => brotliCompressSync(text)],
    ["zstd", (text: string) => zstdCompressSync(text)],
  ])(
    "%s HTML arrives decoded, injected, and without content-encoding or content-length",
    async (encoding, encode) => {
      const page = "<html><head></head><body>x</body></html>"
      const { target } = upstream(
        () =>
          new Response(encode(page), {
            headers: { "content-type": "text/html", "content-encoding": encoding },
          }),
      )
      const res = await proxyHttp(pageRequest("/"), target, deps)
      expect(res.headers.get("content-encoding")).toBeNull()
      expect(res.headers.get("content-length")).toBeNull()
      expect(await res.text()).toBe(`<html><head>${BOOT_TAG}</head><body>x</body></html>`)
    },
  )

  test("every Set-Cookie survives injection", async () => {
    const { target } = upstream(() => {
      const headers = new Headers({ "content-type": "text/html" })
      headers.append("set-cookie", "a=1; Path=/")
      headers.append("set-cookie", "b=2; Path=/; HttpOnly")
      return new Response("<head></head>", { headers })
    })
    const res = await proxyHttp(pageRequest("/"), target, deps)
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"])
  })

  test("an empty HTML document still gets the boot script", async () => {
    const { target } = upstream(
      () => new Response("", { headers: { "content-type": "text/html" } }),
    )
    const res = await proxyHttp(pageRequest("/"), target, deps)
    expect(await moduleScripts(await res.text())).toEqual([renderBootScript(boot)])
  })

  test("HTML in an encoding fetch cannot decode passes through when there is no boot", async () => {
    const { target } = upstream(
      () =>
        new Response("compressed bytes", {
          headers: { "content-type": "text/html", "content-encoding": "compress" },
        }),
    )
    const res = await proxyHttp(pageRequest("/"), { ...target, boot: null }, deps)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("compress")
    expect(await res.text()).toBe("compressed bytes")
  })

  test("an HTML response with no boot passes through uninjected", async () => {
    const page = "<html><head></head><body>x</body></html>"
    const { target } = upstream(
      () => new Response(page, { headers: { "content-type": "text/html" } }),
    )
    const res = await proxyHttp(pageRequest("/"), { ...target, boot: null }, deps)
    expect(await res.text()).toBe(page)
  })

  test("HTML in an encoding fetch cannot decode is refused, not passed on broken", async () => {
    const { target } = upstream(
      () =>
        new Response("compressed bytes", {
          headers: { "content-type": "text/html", "content-encoding": "compress" },
        }),
    )
    const res = await proxyHttp(pageRequest("/"), target, deps)
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toContain("cannot inject into this response")
    expect(text).toContain("compress")
    expect(failures).toEqual([])
  })
})

describe("request forwarding", () => {
  test("a navigation drops conditional headers, so an uninjected 304 is never served", async () => {
    const { seen, target } = upstream(
      () => new Response("<head></head>", { headers: { "content-type": "text/html" } }),
    )
    const conditional = {
      "if-none-match": '"v1"',
      "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
    }
    await proxyHttp(
      pageRequest("/", { headers: { ...conditional, "sec-fetch-dest": "document" } }),
      target,
      deps,
    )
    await proxyHttp(
      pageRequest("/about", { headers: { ...conditional, accept: "text/html,*/*" } }),
      target,
      deps,
    )
    await proxyHttp(
      pageRequest("/app.js", {
        headers: { ...conditional, "sec-fetch-dest": "script", accept: "*/*" },
      }),
      target,
      deps,
    )
    const [document, accepted, script] = seen
    expect(document?.headers["if-none-match"]).toBeUndefined()
    expect(document?.headers["if-modified-since"]).toBeUndefined()
    expect(accepted?.headers["if-none-match"]).toBeUndefined()
    expect(accepted?.headers["if-modified-since"]).toBeUndefined()
    expect(script?.headers["if-none-match"]).toBe('"v1"')
    expect(script?.headers["if-modified-since"]).toBe(conditional["if-modified-since"])
  })

  test.each([
    ["if-none-match", '"v1"'],
    ["if-modified-since", "Wed, 01 Jan 2025 00:00:00 GMT"],
  ])("a navigation carrying only %s drops it, and a subresource keeps it", async (name, value) => {
    const { seen, target } = upstream(
      () => new Response("<head></head>", { headers: { "content-type": "text/html" } }),
    )
    await proxyHttp(
      pageRequest("/", { headers: { [name]: value, "sec-fetch-dest": "document" } }),
      target,
      deps,
    )
    await proxyHttp(
      pageRequest("/about", { headers: { [name]: value, accept: "text/html,*/*" } }),
      target,
      deps,
    )
    await proxyHttp(
      pageRequest("/app.js", {
        headers: { [name]: value, "sec-fetch-dest": "script", accept: "*/*" },
      }),
      target,
      deps,
    )
    const [document, accepted, script] = seen
    expect(document?.headers[name]).toBeUndefined()
    expect(accepted?.headers[name]).toBeUndefined()
    expect(script?.headers[name]).toBe(value)
  })

  test("a request the client aborted is not an upstream failure", async () => {
    const { target } = upstream(async () => {
      await Bun.sleep(300)
      return new Response("late")
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    const res = await proxyHttp(pageRequest("/slow", { signal: controller.signal }), target, deps)
    expect(res.status).not.toBe(502)
    expect(await res.text()).not.toContain("did not answer")
    expect(failures).toEqual([])
  })

  test("headers are rewritten for the upstream and the body streams through", async () => {
    const { origin, seen, target } = upstream(() => new Response("ok"))
    const res = await proxyHttp(
      pageRequest("/api/save?x=1", {
        method: "POST",
        body: "payload",
        headers: {
          origin: PAGE,
          referer: `${PAGE}/edit?id=2#top`,
          connection: "keep-alive, x-private",
          "keep-alive": "timeout=5",
          "x-private": "secret",
          "proxy-authorization": "Basic Zm9v",
          te: "trailers",
          "x-app": "kept",
        },
      }),
      target,
      deps,
    )
    expect(await res.text()).toBe("ok")
    const [request] = seen
    expect(request?.method).toBe("POST")
    expect(request?.url).toBe(`${origin}/api/save?x=1`)
    expect(request?.body).toBe("payload")
    const headers = request?.headers ?? {}
    expect(headers.host).toBe(new URL(origin).host)
    expect(headers["x-forwarded-host"]).toBe("larkspur.localhost:3990")
    expect(headers["x-forwarded-proto"]).toBe("http")
    expect(headers.origin).toBe(origin)
    expect(headers.referer).toBe(`${origin}/edit?id=2#top`)
    expect(headers["x-app"]).toBe("kept")
    for (const dropped of ["keep-alive", "x-private", "proxy-authorization", "te"]) {
      expect(headers[dropped]).toBeUndefined()
    }
  })

  const outboundHeaders = async (req: Request, target: ProxyTarget) => {
    let sent: Headers | undefined
    const capture = async (input: Parameters<typeof fetch>[0]) => {
      sent = (input as Request).headers
      return new Response("ok")
    }
    await proxyHttp(req, target, {
      fetch: Object.assign(capture, { preconnect: fetch.preconnect }),
      onUpstreamFailure() {},
    })
    if (!sent) throw new Error("nothing was forwarded")
    return sent
  }

  test("every hop-by-hop request header is dropped, including the ones Connection names", async () => {
    const { target } = upstream(() => new Response("ok"))
    const sent = await outboundHeaders(
      pageRequest("/", {
        headers: {
          connection: "close, x-conn-named",
          "keep-alive": "timeout=5",
          "transfer-encoding": "chunked",
          te: "trailers",
          trailer: "x-checksum",
          upgrade: "websocket",
          "proxy-authorization": "Basic Zm9v",
          "proxy-connection": "keep-alive",
          "proxy-custom": "1",
          "x-conn-named": "secret",
          "x-app": "kept",
        },
      }),
      target,
    )
    for (const dropped of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "te",
      "trailer",
      "upgrade",
      "proxy-authorization",
      "proxy-connection",
      "proxy-custom",
      "x-conn-named",
    ]) {
      expect(sent.has(dropped)).toBe(false)
    }
    expect(sent.get("x-app")).toBe("kept")
  })

  test("X-Forwarded-Proto and Origin follow an https page", async () => {
    const httpsPage = "https://larkspur.localhost:3990"
    const { origin, target } = upstream(() => new Response("ok"))
    const sent = await outboundHeaders(
      new Request(`${httpsPage}/save`, { headers: { origin: httpsPage } }),
      { ...target, pageOrigin: httpsPage },
    )
    expect(sent.get("x-forwarded-proto")).toBe("https")
    expect(sent.get("x-forwarded-host")).toBe("larkspur.localhost:3990")
    expect(sent.get("origin")).toBe(origin)
  })

  test("the request body reaches the upstream before the client has finished sending it", async () => {
    let firstChunkSeen: () => void = () => {}
    const seenFirst = new Promise<void>((resolve) => {
      firstChunkSeen = resolve
    })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const reader = req.body?.getReader()
        const chunks: string[] = []
        const decoder = new TextDecoder()
        for (let next = await reader?.read(); next && !next.done; next = await reader?.read()) {
          chunks.push(decoder.decode(next.value))
          firstChunkSeen()
        }
        return new Response(chunks.join(""))
      },
    })
    servers.push(server)
    const target: ProxyTarget = {
      pageOrigin: PAGE,
      upstream: server.url.origin,
      originMap: new Map(),
      boot,
    }
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode("one-"))
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("upstream saw nothing while the body was open")),
            3_000,
          ),
        )
        try {
          await Promise.race([seenFirst, timeout])
          controller.enqueue(encoder.encode("two"))
          controller.close()
        } catch (error) {
          controller.error(error)
        }
      },
    })
    const req = new Request(`${PAGE}/upload`, {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)
    const res = await proxyHttp(req, target, deps)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("one-two")
  }, 10_000)

  test("an Origin or Referer from another site is forwarded as sent", async () => {
    const { seen, target } = upstream(() => new Response("ok"))
    await proxyHttp(
      pageRequest("/", {
        headers: { origin: "http://other.localhost:3990", referer: "https://elsewhere.example/a" },
      }),
      target,
      deps,
    )
    expect(seen[0]?.headers.origin).toBe("http://other.localhost:3990")
    expect(seen[0]?.headers.referer).toBe("https://elsewhere.example/a")
  })

  test.each([
    ["a double slash", (port: string) => `//127.0.0.1:${port}/x?q=1`],
    ["a triple slash", (port: string) => `///127.0.0.1:${port}/x?q=1`],
    ["a backslash", (port: string) => `/\\127.0.0.1:${port}/x?q=1`],
    ["an encoded double slash", (port: string) => `/%2F%2F127.0.0.1:${port}/x?q=1`],
  ])("a path with %s stays on the upstream", async (_name, pathFor) => {
    const { origin, seen, target } = upstream(() => new Response("ok"))
    const elsewhere = upstream(() => new Response("elsewhere"))
    const sent = pageRequest(pathFor(new URL(elsewhere.origin).port))
    await proxyHttp(sent, target, deps)
    expect(elsewhere.seen).toEqual([])
    expect(seen).toHaveLength(1)
    const received = new URL(seen[0]?.url ?? "")
    expect(received.origin).toBe(origin)
    // Bun's fetch collapses a leading run of slashes, so only the host is pinned, not the slash count.
    expect(`${received.pathname}${received.search}`.replace(/^\/+/, "/")).toBe(
      `${new URL(sent.url).pathname}${new URL(sent.url).search}`.replace(/^\/+/, "/"),
    )
  })
})

describe("responses", () => {
  test("a Location aimed at a mapped upstream is rewritten to the page origin", async () => {
    const extra = "http://127.0.0.1:1"
    const { origin, target } = upstream((req) => {
      const to = new URL(req.url).searchParams.get("to") ?? ""
      return new Response(null, { status: 302, headers: { location: to } })
    })
    const mapped = {
      ...target,
      originMap: new Map([
        [origin, PAGE],
        [extra, "http://larkspur.localhost:3991"],
      ]),
    }
    const follow = async (to: string) =>
      (await proxyHttp(pageRequest(`/go?to=${encodeURIComponent(to)}`), mapped, deps)).headers.get(
        "location",
      )

    expect(await follow(`${origin}/login?next=%2Fhome#form`)).toBe(
      `${PAGE}/login?next=%2Fhome#form`,
    )
    expect(await follow(`${extra}/api`)).toBe("http://larkspur.localhost:3991/api")
    expect(await follow("https://auth.example/sso?x=1")).toBe("https://auth.example/sso?x=1")
  })

  test("a non-HTML body is decoded and otherwise unchanged, with every Set-Cookie kept", async () => {
    const json = JSON.stringify({ items: [1, 2, 3], note: "<head></head>" })
    const { target } = upstream(() => {
      const headers = new Headers({
        "content-type": "application/json",
        "content-encoding": "gzip",
        etag: '"j1"',
      })
      headers.append("set-cookie", "a=1; Path=/")
      headers.append("set-cookie", "b=2; Path=/; HttpOnly")
      return new Response(Bun.gzipSync(json), { headers })
    })
    const res = await proxyHttp(pageRequest("/data.json"), target, deps)
    expect(await res.text()).toBe(json)
    expect(res.headers.get("content-encoding")).toBeNull()
    expect(res.headers.get("content-length")).toBeNull()
    expect(res.headers.get("etag")).toBe('"j1"')
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"])
  })

  test("a binary body passes through byte for byte, and an empty body stays empty", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i)
    const { target } = upstream((req) =>
      new URL(req.url).pathname === "/empty"
        ? new Response(null, { headers: { "content-type": "text/plain" } })
        : new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    )
    const binary = await proxyHttp(pageRequest("/blob"), target, deps)
    expect(new Uint8Array(await binary.arrayBuffer())).toEqual(bytes)
    const empty = await proxyHttp(pageRequest("/empty"), target, deps)
    expect(empty.status).toBe(200)
    expect((await empty.arrayBuffer()).byteLength).toBe(0)
  })

  test("a non-HTML body in an encoding fetch cannot decode passes through as sent", async () => {
    const { target } = upstream(
      () =>
        new Response("compressed bytes", {
          headers: { "content-type": "application/json", "content-encoding": "compress" },
        }),
    )
    const res = await proxyHttp(pageRequest("/data"), target, deps)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-encoding")).toBe("compress")
    expect(await res.text()).toBe("compressed bytes")
  })

  test("the 502 page names the upstream and the actual error", async () => {
    const { target } = upstream(() => new Response("unused"))
    const failing = Object.assign(
      async () => {
        throw new Error("socket hang up near xyzzy")
      },
      { preconnect: fetch.preconnect },
    )
    const res = await proxyHttp(pageRequest("/"), target, {
      fetch: failing,
      onUpstreamFailure: (upstream) => failures.push(upstream),
    })
    expect(res.status).toBe(502)
    const text = await res.text()
    expect(text).toContain(target.upstream)
    expect(text).toContain("socket hang up near xyzzy")
    expect(failures).toEqual([target.upstream])
  })

  test("an unreachable upstream reports the failure and answers with an iter8 502 page", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const dead = closed.url.origin
    await closed.stop(true)
    const target: ProxyTarget = { pageOrigin: PAGE, upstream: dead, originMap: new Map(), boot }

    const res = await proxyHttp(pageRequest("/"), target, deps)
    expect(failures).toEqual([dead])
    expect(res.status).toBe(502)
    expect(res.headers.get("content-type")).toContain("text/html")
    const text = await res.text()
    expect(text).toContain("iter8")
    expect(text).toContain(dead)
    expect(text).toMatch(/refused|connect|unable/i)
  })
})

test("a failure page escapes what it is given", async () => {
  const text = await failurePage(502, "<b>title</b>", `<script>alert("x")</script>`).text()
  expect(text).not.toContain("<b>")
  expect(text).not.toContain("<script>")
})
