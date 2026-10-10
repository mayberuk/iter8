import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { OverlayBoot, renderBootScript } from "@iter8/protocol"
import { injectBoot } from "./inject"

const ORIGIN = "http://larkspur.localhost:3990"
const boot = OverlayBoot.parse({
  protocolVersion: 1,
  pageId: "larkspur",
  machineId: "devbox-7f3a",
  machineName: "devbox",
  token: "q5Jx2lK9vT0wYbN3cR8mZ4hD1sF6gA7e",
  apiBase: "/__iter8",
  sourceBundleUrl: "/__iter8/assets/source.js",
})
const bootHash = (value: OverlayBoot) =>
  `'sha256-${createHash("sha256").update(renderBootScript(value)).digest("base64")}'`

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { "content-type": "text/html", ...headers } })
}

type Script = { attrs: Record<string, string>; text: string }

async function scriptsIn(markup: string): Promise<Script[]> {
  const scripts: Script[] = []
  await new HTMLRewriter()
    .on("script", {
      element(element) {
        scripts.push({ attrs: Object.fromEntries(element.attributes), text: "" })
      },
      text(chunk) {
        const last = scripts.at(-1)
        if (last) last.text += chunk.text
      },
    })
    .transform(new Response(markup))
    .text()
  return scripts
}

async function metaCsp(markup: string): Promise<string[]> {
  const found: string[] = []
  await new HTMLRewriter()
    .on("meta", {
      element(meta) {
        if (meta.getAttribute("http-equiv")?.toLowerCase() === "content-security-policy") {
          found.push(meta.getAttribute("content") ?? "")
        }
      },
    })
    .transform(new Response(markup))
    .text()
  return found
}

describe("placement", () => {
  test("the boot script is the last element of head", async () => {
    const out = await (
      await injectBoot(
        html("<html><head><title>t</title></head><body>b</body></html>"),
        boot,
        ORIGIN,
      )
    ).text()
    expect(out).toBe(
      `<html><head><title>t</title><script type="module">${renderBootScript(boot)}</script></head><body>b</body></html>`,
    )
  })

  test("without a head it opens body", async () => {
    const out = await (
      await injectBoot(html("<html><body><p>b</p></body></html>"), boot, ORIGIN)
    ).text()
    expect(out).toBe(
      `<html><body><script type="module">${renderBootScript(boot)}</script><p>b</p></body></html>`,
    )
  })

  test("a head with no end tag hands the script to body", async () => {
    const out = await (await injectBoot(html("<head><title>t</title><body>b"), boot, ORIGIN)).text()
    expect(out).toBe(
      `<head><title>t</title><body><script type="module">${renderBootScript(boot)}</script>b`,
    )
  })

  test("without head or body it goes at the document end", async () => {
    const out = await (await injectBoot(html("<p>bare</p>"), boot, ORIGIN)).text()
    expect(out).toBe(`<p>bare</p><script type="module">${renderBootScript(boot)}</script>`)
  })

  test("a boot value containing </script> cannot close the element", async () => {
    const hostile = { ...boot, machineName: "</script><script>alert(1)</script>" }
    const out = await (await injectBoot(html("<head></head>"), hostile, ORIGIN)).text()
    const scripts = await scriptsIn(out)
    expect(scripts).toEqual([{ attrs: { type: "module" }, text: renderBootScript(hostile) }])
  })
})

describe("headers", () => {
  test("cache validators are removed and the response is not stored", async () => {
    const res = await injectBoot(
      html("<head></head>", {
        etag: '"v1"',
        "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
        "cache-control": "max-age=600",
        "content-length": "13",
        "x-app": "kept",
      }),
      boot,
      ORIGIN,
    )
    expect(res.headers.get("etag")).toBeNull()
    expect(res.headers.get("last-modified")).toBeNull()
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-app")).toBe("kept")
    expect(res.headers.get("content-length")).toBeNull()
  })

  test("a strict header CSP gets the hash of the exact boot script; Report-Only is left alone", async () => {
    const strict = "script-src 'nonce-r4nd0m' 'strict-dynamic'; object-src 'none'"
    const res = await injectBoot(
      html("<head></head>", {
        "content-security-policy": strict,
        "content-security-policy-report-only": strict,
      }),
      boot,
      ORIGIN,
    )
    const amended = res.headers.get("content-security-policy") ?? ""
    expect(amended.split(";")[0]?.trim().split(/\s+/)).toContain(bootHash(boot))
    expect(res.headers.get("content-security-policy-report-only")).toBe(strict)
    const [script] = await scriptsIn(await res.text())
    expect(
      `'sha256-${createHash("sha256")
        .update(script?.text ?? "")
        .digest("base64")}'`,
    ).toBe(bootHash(boot))
  })

  test("a meta CSP with script-src 'self' is amended by the same rule", async () => {
    const markup = `<head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    expect(await metaCsp(out)).toEqual([`script-src 'self' ${bootHash(boot)}`])
  })

  test("each boot value gets the hash of its own script text", async () => {
    const other = OverlayBoot.parse({
      ...boot,
      token: "Zz9yX8wV7uT6sR5qP4oN3mL2kJ1iH0gF",
      pageId: "heron",
    })
    expect(renderBootScript(other)).not.toBe(renderBootScript(boot))
    const policy = "script-src 'nonce-r4nd0m' 'strict-dynamic'"
    for (const value of [boot, other, boot]) {
      const res = await injectBoot(
        html(`<head>${metaOf(policy)}</head>`, { "content-security-policy": policy }),
        value,
        ORIGIN,
      )
      const expected = `script-src 'nonce-r4nd0m' 'strict-dynamic' ${bootHash(value)}`
      expect(res.headers.get("content-security-policy")).toBe(expected)
      expect(await metaCsp(await res.text())).toEqual([expected])
    }
    expect(bootHash(boot)).not.toBe(bootHash(other))
  })

  test("an unsafe-inline policy gets no hash", async () => {
    const policy = "script-src 'self' 'unsafe-inline'"
    const markup = `<head><meta http-equiv="content-security-policy" content="${policy}"></head>`
    const res = await injectBoot(html(markup, { "content-security-policy": policy }), boot, ORIGIN)
    expect(res.headers.get("content-security-policy")).toBe(policy)
    expect(await metaCsp(await res.text())).toEqual([policy])
  })

  const metaOf = (policy: string, name = "Content-Security-Policy") =>
    `<meta http-equiv="${name}" content="${policy}">`

  const directiveMap = (policy: string) =>
    new Map(
      policy
        .split(";")
        .map((raw) => raw.trim().split(/\s+/))
        .filter(([name]) => name)
        .map(([name = "", ...sources]) => [name, sources] as const),
    )

  test("a meta CSP host list without 'self' gets the hash and the page origin", async () => {
    const markup = `<head>${metaOf("script-src https://cdn.example")}</head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    expect(await metaCsp(out)).toEqual([
      `script-src https://cdn.example ${bootHash(boot)} ${ORIGIN}`,
    ])
  })

  test("a meta CSP with a nonce and strict-dynamic gets the hash and no origin", async () => {
    const markup = `<head>${metaOf("script-src 'nonce-r4nd0m' 'strict-dynamic'")}</head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    expect(await metaCsp(out)).toEqual([
      `script-src 'nonce-r4nd0m' 'strict-dynamic' ${bootHash(boot)}`,
    ])
  })

  test("a meta CSP with only default-src admits the script without changing default-src", async () => {
    const markup = `<head>${metaOf("default-src https://cdn.example")}</head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    const [content = ""] = await metaCsp(out)
    const amended = directiveMap(content)
    expect(amended.get("default-src")).toEqual(["https://cdn.example"])
    expect(amended.get("script-src")).toEqual(["https://cdn.example", bootHash(boot), ORIGIN])
  })

  test("a meta CSP with script-src-elem amends it and leaves script-src alone", async () => {
    const markup = `<head>${metaOf("script-src 'self'; script-src-elem https://cdn.example")}</head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    const [content = ""] = await metaCsp(out)
    const amended = directiveMap(content)
    expect(amended.get("script-src")).toEqual(["'self'"])
    expect(amended.get("script-src-elem")).toEqual(["https://cdn.example", bootHash(boot), ORIGIN])
  })

  test("every meta CSP tag is amended, and a Report-Only meta is left alone", async () => {
    const reportOnly = metaOf("script-src 'self'", "Content-Security-Policy-Report-Only")
    const markup = `<head>${metaOf("script-src 'self'")}${reportOnly}${metaOf("script-src https://cdn.example")}</head>`
    const out = await (await injectBoot(html(markup), boot, ORIGIN)).text()
    expect(await metaCsp(out)).toEqual([
      `script-src 'self' ${bootHash(boot)}`,
      `script-src https://cdn.example ${bootHash(boot)} ${ORIGIN}`,
    ])
    expect(out).toContain(reportOnly)
  })
})
