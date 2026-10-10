import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { agreedNonce, amendCsp } from "./csp"

const HASH = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
const HASH_SOURCE = `'sha256-${HASH}'`
const ORIGIN = "http://larkspur.localhost:3990"
const WS_ORIGIN = "ws://larkspur.localhost:3990"

function directives(policy: string): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const raw of policy.split(";")) {
    const [name, ...sources] = raw.trim().split(/\s+/)
    if (name && !found.has(name.toLowerCase())) found.set(name.toLowerCase(), sources)
  }
  return found
}

// The CSP fallback a browser applies when it checks one fetch type against a single policy.
function effective(policy: string, chain: string[]): string[] | undefined {
  const found = directives(policy)
  return chain.map((name) => found.get(name)).find((sources) => sources !== undefined)
}

const scriptSources = (policy: string) =>
  effective(policy, ["script-src-elem", "script-src", "default-src"])

describe("the effective script directive", () => {
  test("a nonce with strict-dynamic gets the hash and no origin", () => {
    const policy = "script-src 'nonce-abc123' 'strict-dynamic'; object-src 'none'"
    const sources = scriptSources(amendCsp(policy, HASH, ORIGIN))
    expect(sources).toContain(HASH_SOURCE)
    expect(sources).not.toContain(ORIGIN)
  })

  test("'self' gets the hash and no origin", () => {
    const sources = scriptSources(amendCsp("script-src 'self'", HASH, ORIGIN))
    expect(sources).toEqual(["'self'", HASH_SOURCE])
  })

  test("a host list without 'self' gets the hash and the page origin", () => {
    const sources = scriptSources(amendCsp("script-src https://cdn.example", HASH, ORIGIN))
    expect(sources).toEqual(["https://cdn.example", HASH_SOURCE, ORIGIN])
  })

  test("a bare 'unsafe-inline' gets no hash, since a hash would switch inline scripts off", () => {
    expect(scriptSources(amendCsp("script-src 'self' 'unsafe-inline'", HASH, ORIGIN))).toEqual([
      "'self'",
      "'unsafe-inline'",
    ])
    expect(scriptSources(amendCsp("script-src 'unsafe-inline'", HASH, ORIGIN))).toEqual([
      "'unsafe-inline'",
      ORIGIN,
    ])
  })

  test("'unsafe-inline' beside a nonce, a hash or strict-dynamic is ignored, so the hash is added", () => {
    for (const other of ["'nonce-abc123'", "'sha384-xyz'", "'strict-dynamic'"]) {
      const policy = `script-src 'self' 'unsafe-inline' ${other}`
      expect(scriptSources(amendCsp(policy, HASH, ORIGIN))).toContain(HASH_SOURCE)
    }
  })

  test("script-src-elem wins over script-src", () => {
    const policy = "script-src 'self'; script-src-elem https://cdn.example"
    const amended = directives(amendCsp(policy, HASH, ORIGIN))
    expect(amended.get("script-src-elem")).toEqual(["https://cdn.example", HASH_SOURCE, ORIGIN])
    expect(amended.get("script-src")).toEqual(["'self'"])
  })

  test("a default-src fallback admits the script without changing default-src", () => {
    const policy = "default-src https://cdn.example"
    const amended = amendCsp(policy, HASH, ORIGIN)
    expect(scriptSources(amended)).toEqual(["https://cdn.example", HASH_SOURCE, ORIGIN])
    expect(directives(amended).get("default-src")).toEqual(["https://cdn.example"])
  })

  test("an empty script directive restricts scripts, so it gets the hash and the page origin", () => {
    for (const policy of ["script-src", "script-src;", "script-src ; object-src 'none'"]) {
      expect(scriptSources(amendCsp(policy, HASH, ORIGIN))).toEqual([HASH_SOURCE, ORIGIN])
    }
    expect(scriptSources(amendCsp("default-src;", HASH, ORIGIN))).toEqual([HASH_SOURCE, ORIGIN])
  })

  test("'none' is dropped when a source is added beside it", () => {
    expect(scriptSources(amendCsp("script-src 'none'", HASH, ORIGIN))).toEqual([
      HASH_SOURCE,
      ORIGIN,
    ])
  })
})

describe("the overlay's other fetches", () => {
  test("connect-src gets the page origin and its websocket form", () => {
    const amended = amendCsp("connect-src https://api.example", HASH, ORIGIN)
    expect(directives(amended).get("connect-src")).toEqual([
      "https://api.example",
      ORIGIN,
      WS_ORIGIN,
    ])
  })

  test("connect-src with 'self' gets only the websocket form", () => {
    const amended = amendCsp("connect-src 'self'", HASH, ORIGIN)
    expect(directives(amended).get("connect-src")).toEqual(["'self'", WS_ORIGIN])
  })

  test("font-src gets the page origin and img-src gets blob:", () => {
    const amended = directives(amendCsp("font-src data:; img-src 'self' data:", HASH, ORIGIN))
    expect(amended.get("font-src")).toEqual(["data:", ORIGIN])
    expect(amended.get("img-src")).toEqual(["'self'", "data:", "blob:"])
  })

  test("a restricting default-src covers every type the overlay needs", () => {
    const amended = amendCsp("default-src 'self'", HASH, ORIGIN)
    expect(scriptSources(amended)).toEqual(["'self'", HASH_SOURCE])
    expect(effective(amended, ["connect-src", "default-src"])).toEqual(["'self'", WS_ORIGIN])
    expect(effective(amended, ["font-src", "default-src"])).toEqual(["'self'"])
    expect(effective(amended, ["img-src", "default-src"])).toEqual(["'self'", "blob:"])
  })
})

test("a policy with no restricting directive is returned unchanged", () => {
  for (const policy of ["", "frame-ancestors 'none'", "upgrade-insecure-requests; report-uri /r"]) {
    expect(amendCsp(policy, HASH, ORIGIN)).toBe(policy)
  }
})

test("each policy of a comma-separated header value is amended", () => {
  const [first, second] = amendCsp("script-src 'self', script-src 'nonce-q'", HASH, ORIGIN).split(
    ", ",
  )
  expect(scriptSources(first ?? "")).toContain(HASH_SOURCE)
  expect(scriptSources(second ?? "")).toContain(HASH_SOURCE)
})

describe("the nonce an injected script can carry", () => {
  test("a nonce in the effective script directive is returned", () => {
    expect(agreedNonce(["script-src 'nonce-abc' 'strict-dynamic'"])).toBe("abc")
    expect(agreedNonce(["default-src 'nonce-abc'"])).toBe("abc")
    expect(agreedNonce(["script-src 'self'; script-src-elem 'NONCE-abc'"])).toBe("abc")
  })

  test("a nonce outside the effective script directive is ignored", () => {
    expect(agreedNonce(["script-src 'self'; script-src-elem https://cdn.example"])).toBeUndefined()
    expect(agreedNonce(["script-src-elem 'self'; script-src 'nonce-abc'"])).toBeUndefined()
    expect(agreedNonce(["script-src 'self'; default-src 'nonce-abc'"])).toBeUndefined()
    expect(agreedNonce(["style-src 'nonce-abc'"])).toBeUndefined()
  })

  test("no policy, or no nonce, gives none", () => {
    expect(agreedNonce([])).toBeUndefined()
    expect(agreedNonce(["script-src 'sha256-abc' 'strict-dynamic'"])).toBeUndefined()
  })

  test("every policy with a nonce must accept it, across values and within a comma list", () => {
    expect(agreedNonce(["script-src 'nonce-a'", "script-src 'nonce-b'"])).toBeUndefined()
    expect(agreedNonce(["script-src 'nonce-a', script-src 'nonce-b'"])).toBeUndefined()
    expect(agreedNonce(["script-src 'nonce-a' 'nonce-b'", "script-src 'nonce-b'"])).toBe("b")
    expect(agreedNonce(["script-src 'self'", "script-src 'nonce-a'"])).toBe("a")
  })

  test("a value that is not a plain base64 token is never returned", () => {
    expect(agreedNonce(["script-src 'nonce-a\"b'"])).toBeUndefined()
    expect(agreedNonce(["script-src 'nonce-a<b'"])).toBeUndefined()
  })
})

const source = fc.constantFrom(
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'strict-dynamic'",
  "'nonce-abc123'",
  "'sha256-abc'",
  "https://cdn.example",
  "data:",
  "*",
)
const directive = fc.tuple(
  fc.constantFrom(
    "default-src",
    "script-src",
    "script-src-elem",
    "connect-src",
    "font-src",
    "img-src",
    "style-src",
    "object-src",
  ),
  fc.uniqueArray(source, { minLength: 1, maxLength: 4 }),
)
const policy = fc
  .uniqueArray(directive, { maxLength: 6, selector: ([name]) => name })
  .map((list) => list.map(([name, sources]) => [name, ...sources].join(" ")).join("; "))

test("amending only adds sources, and the boot script and overlay module are always admitted", () => {
  fc.assert(
    fc.property(policy, (original) => {
      const amended = amendCsp(original, HASH, ORIGIN)
      const before = directives(original)
      const after = directives(amended)
      for (const [name, sources] of before) {
        const kept = after.get(name) ?? []
        for (const one of sources) if (one !== "'none'") expect(kept).toContain(one)
      }
      const script = scriptSources(amended)
      if (script === undefined) return
      const bareInline =
        script.includes("'unsafe-inline'") &&
        !script.some((one) => /^'(nonce|sha256)-|^'strict-dynamic'$/.test(one))
      expect(bareInline || script.includes(HASH_SOURCE)).toBe(true)
      expect(["'self'", "'strict-dynamic'", "*", ORIGIN].some((one) => script.includes(one))).toBe(
        true,
      )
    }),
  )
})
