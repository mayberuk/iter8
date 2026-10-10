import type { Server, ServerWebSocket } from "bun"

export type BridgeSocketData = {
  kind: "bridge"
  upstream: WebSocket
  backlog: Array<string | Uint8Array>
  /** The upstream's close, kept when it lands before the client socket has opened. */
  earlyClose?: { code: number; reason: string }
}

const UPSTREAM_OPEN_TIMEOUT_MS = 5_000

function sendableCode(code: number): number {
  if (code === 1005) return 1000
  const onTheWire =
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  return onTheWire ? code : 1011
}

function frameOf(event: MessageEvent): string | Uint8Array {
  return typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)
}

function openUpstream(
  url: URL,
  protocols: string[],
  headers: Record<string, string>,
  backlog: BridgeSocketData["backlog"],
  onCloseAfterOpen: (event: CloseEvent) => void,
) {
  // lib.dom's WebSocket type hides Bun's constructor option for request headers.
  const upstream = new WebSocket(url, { protocols, headers } as unknown as string[])
  upstream.binaryType = "arraybuffer"
  upstream.onmessage = (event) => backlog.push(frameOf(event))
  return new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      upstream.close()
      reject(new Error("upstream websocket did not open in time"))
    }, UPSTREAM_OPEN_TIMEOUT_MS)
    upstream.onopen = () => {
      clearTimeout(timer)
      upstream.onerror = null
      upstream.onclose = onCloseAfterOpen
      resolve(upstream)
    }
    upstream.onerror = upstream.onclose = () => {
      clearTimeout(timer)
      reject(new Error("upstream websocket failed to open"))
    }
  })
}

/**
 * Opens the upstream socket first, then upgrades the client with the subprotocol the upstream
 * selected. Resolves to undefined once upgraded, or to the error response to send instead.
 */
export async function upgradeBridged(
  req: Request,
  server: Server<BridgeSocketData>,
  upstreamUrl: string,
  upstreamHeaders: Record<string, string>,
): Promise<Response | undefined> {
  const { pathname, search } = new URL(req.url)
  const protocols = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((offer) => offer.trim())
    .filter((offer) => offer !== "")
  const backlog: BridgeSocketData["backlog"] = []
  let upstream: WebSocket
  let data: BridgeSocketData | undefined
  try {
    upstream = await openUpstream(
      new URL(pathname + search, upstreamUrl),
      protocols,
      upstreamHeaders,
      backlog,
      (event) => {
        if (data) data.earlyClose = { code: event.code, reason: event.reason }
      },
    )
  } catch (error) {
    return new Response(`iter8 could not reach the app's websocket: ${(error as Error).message}`, {
      status: 502,
    })
  }
  data = { kind: "bridge", upstream, backlog }
  const upgraded = server.upgrade(req, {
    headers: new Headers(
      upstream.protocol === "" ? {} : { "Sec-WebSocket-Protocol": upstream.protocol },
    ),
    data,
  })
  if (upgraded) return undefined
  upstream.close()
  return new Response("expected a websocket upgrade", { status: 400 })
}

export const bridgeHandlers = {
  open(ws: ServerWebSocket<BridgeSocketData>): void {
    const { upstream, backlog, earlyClose } = ws.data
    for (const frame of backlog.splice(0)) ws.send(frame)
    if (earlyClose) {
      ws.close(sendableCode(earlyClose.code), earlyClose.reason)
      return
    }
    upstream.onmessage = (event) => ws.send(frameOf(event))
    upstream.onclose = (event) => ws.close(sendableCode(event.code), event.reason)
  },
  message(ws: ServerWebSocket<BridgeSocketData>, data: string | Buffer): void {
    if (ws.data.upstream.readyState !== WebSocket.OPEN) return
    ws.data.upstream.send(typeof data === "string" ? data : new Uint8Array(data))
  },
  close(ws: ServerWebSocket<BridgeSocketData>, code: number, reason: string): void {
    const { upstream } = ws.data
    upstream.onclose = null
    if (upstream.readyState === WebSocket.OPEN) upstream.close(sendableCode(code), reason)
  },
}
