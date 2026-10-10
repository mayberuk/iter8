type Directive = { name: string; sources: string[]; raw: string }

const HASH_OR_NONCE = /^'(nonce|sha256|sha384|sha512)-/i
const NONCE = /^'nonce-([A-Za-z0-9+/_-]+=*)'$/i

function parse(policy: string): Directive[] {
  return policy
    .split(";")
    .map((raw) => raw.trim())
    .filter((raw) => raw !== "")
    .map((raw) => {
      const [name = "", ...sources] = raw.split(/\s+/)
      return { name: name.toLowerCase(), sources, raw }
    })
}

function has(sources: string[], keyword: string): boolean {
  return sources.some((source) => source.toLowerCase() === keyword)
}

// A browser ignores 'unsafe-inline' once a nonce, a hash or 'strict-dynamic' is present, so only
// a bare 'unsafe-inline' already runs the boot script; a hash there would switch it off.
function allowsAllInline(sources: string[]): boolean {
  return (
    has(sources, "'unsafe-inline'") &&
    !has(sources, "'strict-dynamic'") &&
    !sources.some((source) => HASH_OR_NONCE.test(source))
  )
}

function allowsOrigin(sources: string[], origin: string): boolean {
  const scheme = origin.slice(0, origin.indexOf(":") + 1)
  return sources.some((source) => {
    const lower = source.toLowerCase()
    return lower === origin || lower === scheme || (scheme === "http:" && lower === "*")
  })
}

function amendPolicy(policy: string, scriptHash: string, pageOrigin: string): string {
  const directives = parse(policy)
  const first = (name: string) => directives.find((directive) => directive.name === name)
  let changed = false

  // When the fallback is default-src, the additions go into a copy named for the one fetch type,
  // so a hash or origin added for the overlay never widens or tightens the page's other types.
  const amend = (chain: string[], additions: (sources: string[]) => string[]) => {
    const effective = chain.map(first).find((directive) => directive !== undefined)
    if (!effective) return
    const added = additions(effective.sources).filter(
      (source) => !effective.sources.includes(source),
    )
    if (added.length === 0) return
    const sources = [
      ...effective.sources.filter((source) => source.toLowerCase() !== "'none'"),
      ...added,
    ]
    const name = chain[0] ?? effective.name
    if (effective.name === name) {
      effective.sources = sources
      effective.raw = [name, ...sources].join(" ")
    } else {
      directives.push({ name, sources, raw: [name, ...sources].join(" ") })
    }
    changed = true
  }

  const scriptName = first("script-src-elem") ? "script-src-elem" : "script-src"
  amend([scriptName, "default-src"], (sources) => [
    ...(allowsAllInline(sources) ? [] : [`'sha256-${scriptHash}'`]),
    ...(has(sources, "'self'") ||
    has(sources, "'strict-dynamic'") ||
    allowsOrigin(sources, pageOrigin)
      ? []
      : [pageOrigin]),
  ])
  const socketOrigin = pageOrigin.replace(/^http/, "ws")
  amend(["connect-src", "default-src"], (sources) => [
    ...(has(sources, "'self'") || allowsOrigin(sources, pageOrigin) ? [] : [pageOrigin]),
    ...(allowsOrigin(sources, socketOrigin) ? [] : [socketOrigin]),
  ])
  amend(["font-src", "default-src"], (sources) =>
    has(sources, "'self'") || allowsOrigin(sources, pageOrigin) ? [] : [pageOrigin],
  )
  amend(["img-src", "default-src"], (sources) => (has(sources, "blob:") ? [] : ["blob:"]))

  return changed ? directives.map((directive) => directive.raw).join("; ") : policy
}

function scriptNonces(policy: string): string[] {
  const directives = parse(policy)
  const effective = ["script-src-elem", "script-src", "default-src"]
    .map((name) => directives.find((directive) => directive.name === name))
    .find((directive) => directive !== undefined)
  return (effective?.sources ?? []).flatMap((source) => NONCE.exec(source)?.[1] ?? [])
}

/**
 * The nonce an injected script can carry to be allowed by every enforcing policy whose effective
 * script directive has one, or undefined when there is none or the policies share none. Takes
 * header values, so a comma-separated list counts as several policies.
 */
export function agreedNonce(values: string[]): string | undefined {
  const sets = values
    .flatMap((value) => value.split(",").map(scriptNonces))
    .filter((nonces) => nonces.length > 0)
  return sets[0]?.find((nonce) => sets.every((set) => set.includes(nonce)))
}

/**
 * Lets the page's CSP run the injected boot script (whose base64 SHA-256 is `scriptHash`), load
 * the overlay from `pageOrigin`, reach the service over HTTP and websocket, and show screenshot
 * blob URLs. Takes a header value, so a comma-separated list amends each policy.
 */
export function amendCsp(policy: string, scriptHash: string, pageOrigin: string): string {
  const policies = policy.split(",").map((one) => one.trim())
  const amended = policies.map((one) => amendPolicy(one, scriptHash, pageOrigin))
  return amended.every((one, i) => one === policies[i]) ? policy : amended.join(", ")
}
