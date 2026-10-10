import { type OverlayBoot, renderBootScript } from "@iter8/protocol"
import { amendCsp } from "./csp"

const CSP = "content-security-policy"

/**
 * Streams the decoded HTML `res` with the boot script added at the end of `head`, at the start of
 * `body` when there is no head, or at the document end when there is neither, and amends the
 * header and meta CSP so the script and the overlay it imports may run.
 */
export async function injectBoot(
  res: Response,
  boot: OverlayBoot,
  pageOrigin: string,
): Promise<Response> {
  const text = renderBootScript(boot)
  const scriptHash = new Bun.CryptoHasher("sha256").update(text).digest("base64")
  const tag = `<script type="module">${text}</script>`
  let injected = false

  const headers = new Headers(res.headers)
  const policy = headers.get(CSP)
  if (policy !== null) headers.set(CSP, amendCsp(policy, scriptHash, pageOrigin))
  headers.delete("content-length")
  headers.delete("etag")
  headers.delete("last-modified")
  headers.set("cache-control", "no-store")

  return new HTMLRewriter()
    .on("meta[http-equiv]", {
      element(meta) {
        const content = meta.getAttribute("content")
        if (meta.getAttribute("http-equiv")?.trim().toLowerCase() !== CSP || content === null)
          return
        meta.setAttribute("content", amendCsp(content, scriptHash, pageOrigin))
      },
    })
    .on("head", {
      element(head) {
        // A head with no end tag in the source never fires this, so the body or document end
        // takes the script instead.
        head.onEndTag((end) => {
          if (injected) return
          end.before(tag, { html: true })
          injected = true
        })
      },
    })
    .on("body", {
      element(body) {
        if (injected) return
        body.prepend(tag, { html: true })
        injected = true
      },
    })
    .onDocument({
      end(end) {
        if (!injected) end.append(tag, { html: true })
      },
    })
    .transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers }))
}
