import { LandingFragment, OVERLAY_ROUTES, TOKEN_HEADER } from "@iter8/protocol"

const key = LandingFragment.keyof().enum

const script = `const fragment = new URLSearchParams(location.hash.slice(1))
const machineId = fragment.get(${JSON.stringify(key.m)})
const pageId = fragment.get(${JSON.stringify(key.p)})
const token = fragment.get(${JSON.stringify(key.t)})
const refuse = () => {
  const port = location.port
  document.getElementById("status").textContent =
    \`Port \${port} on this computer is not the iter8 service that opened this page. Check the SSH forward for port \${port}.\`
}
if (!machineId || !pageId || !token) refuse()
else
  fetch(${JSON.stringify(OVERLAY_ROUTES.whoami.path)}, { headers: { ${JSON.stringify(TOKEN_HEADER)}: token } })
    .then((response) => (response.ok ? response.json() : null))
    .then((whoami) =>
      whoami && whoami.machineId === machineId && whoami.pageId === pageId
        ? location.replace("/")
        : refuse(),
    )
    .catch(refuse)
`

const style = `:root{--paper:#FCFBF6;--ink:#221F19;--mute:#6F695B;--line:#DEDACD;color-scheme:light dark}
@media (prefers-color-scheme: dark){:root{--paper:#2A2824;--ink:#ECE5D5;--mute:#9D9584;--line:#3C3832}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);
font:14px/1.45 ui-sans-serif,system-ui,sans-serif}
main{max-width:32rem;padding:1.5rem;border:1px solid var(--line);border-radius:10px}
h1{margin:0 0 .5rem;font-size:15px}
p{margin:0;color:var(--mute)}`

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64")

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>iter8</title>
<style>${style}</style>
</head>
<body>
<main><h1>iter8</h1><p id="status">Checking which iter8 service answers on this port…</p></main>
<script>${script}</script>
</body>
</html>
`

const csp = [
  "default-src 'none'",
  `script-src 'sha256-${sha256(script)}'`,
  `style-src 'sha256-${sha256(style)}'`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

/** Proves an SSH-forwarded port reached the machine and page named in the URL fragment. */
export function landingResponse(): Response {
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "cache-control": "no-store",
    },
  })
}
