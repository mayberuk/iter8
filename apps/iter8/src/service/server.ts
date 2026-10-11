import { chmod, rm } from "node:fs/promises"
import {
  ClientMessage,
  LIVE_PATH,
  OVERLAY_PREFIX,
  type PageId,
  ServerMessage,
} from "@iter8/protocol"
import type { Server, ServerWebSocket } from "bun"
import type { PageRecord } from "../pages/pages"
import { failurePage, proxyHttp, withoutHopByHop } from "../proxy/forward"
import { injectBoot } from "../proxy/inject"
import { type BridgeSocketData, bridgeHandlers, upgradeBridged } from "../proxy/ws-bridge"
import { serveFolder, watchFolder as watchFolderFiles } from "../static/folder"
import type { ControlApp } from "./control-api"
import {
  authorizeLive,
  bootFor,
  type OverlayApiDeps,
  type OverlayApp,
  pagePairing,
} from "./overlay-api"

export type ServerDeps = {
  overlayApp: OverlayApp
  controlApp: ControlApp
  overlay: OverlayApiDeps
  poolPorts: number[]
  controlSocket: string
  fetch: typeof fetch
}

export type RunningServer = {
  ports: number[]
  watchFolder(record: PageRecord): void
  stop(): Promise<void>
}

type LiveSocketData = { kind: "live"; pageId: PageId; detach?: () => void }
type SocketData = BridgeSocketData | LiveSocketData

function isBridge(ws: ServerWebSocket<SocketData>): ws is ServerWebSocket<BridgeSocketData> {
  return ws.data.kind === "bridge"
}

function isUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket"
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined
}

async function claimControlSocket(path: string): Promise<void> {
  try {
    const socket = await Bun.connect({ unix: path, socket: { data() {} } })
    socket.end()
  } catch (error) {
    const code = errorCode(error)
    if (code === "ENOENT") return
    if (code === "ECONNREFUSED") {
      await rm(path, { force: true })
      return
    }
    throw error
  }
  throw new Error(`Another iter8 service is already listening on ${path}`)
}

async function bindControlSocket(path: string, app: ControlApp): Promise<Server<undefined>> {
  // No idle timeout: `hook wait` holds its request open as a long-poll. bun-types 1.4.2 declares
  // idleTimeout only for TCP listeners, but the runtime applies it to a unix socket as well.
  const options: Bun.Serve.Options<undefined> = { unix: path, fetch: (req) => app.fetch(req) }
  Object.assign(options, { idleTimeout: 0 })
  const server = Bun.serve(options)
  try {
    await chmod(path, 0o600)
  } catch (error) {
    await server.stop(true)
    throw error
  }
  return server
}

export async function startServer(deps: ServerDeps): Promise<RunningServer> {
  const { overlayApp, controlApp, overlay } = deps
  const { pages, live } = overlay
  const watchers = new Map<PageId, () => void>()

  const boot = (record: PageRecord) => bootFor(record, overlay.machineId, overlay.machineName)

  async function handle(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const host = req.headers.get("host") ?? ""
    const hostname = URL.parse(`http://${host}`)?.hostname ?? ""
    const port = server.port
    const match = port === undefined ? null : pages.match(hostname, port)
    const pageOrigin = `http://${host}`
    const { pathname } = new URL(req.url)

    if (pathname === OVERLAY_PREFIX || pathname.startsWith(`${OVERLAY_PREFIX}/`)) {
      if (pathname === LIVE_PATH && isUpgrade(req)) {
        const authorized = authorizeLive(req, match, pageOrigin, pages)
        if (!authorized.ok) return authorized.response
        const upgraded = server.upgrade(req, {
          headers: { "Sec-WebSocket-Protocol": authorized.protocol },
          data: { kind: "live", pageId: authorized.pageId },
        })
        return upgraded ? undefined : new Response("expected a websocket upgrade", { status: 400 })
      }
      return overlayApp.fetch(req, { match, pageOrigin })
    }

    if (!match || port === undefined) {
      return failurePage(404, "no page here", `No iter8 page is open at ${host}`)
    }
    const { record, upstream } = match
    const { page } = record

    if (page.target.kind === "folder") {
      const res = await serveFolder(req, page.target.root)
      const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim()
      return mediaType === "text/html" ? injectBoot(res, boot(record), pageOrigin) : res
    }
    if (upstream === null) throw new Error(`Server page ${page.id} matched with no upstream`)

    if (isUpgrade(req)) {
      const { origin, host: upstreamHost } = new URL(upstream)
      // Sec-WebSocket-* belong to the client library opening the upstream socket; the subprotocol
      // offer travels separately.
      const forwarded = withoutHopByHop(req.headers)
      for (const name of [...forwarded.keys()]) {
        if (name.startsWith("sec-websocket-")) forwarded.delete(name)
      }
      forwarded.set("host", upstreamHost)
      // Only the page's own origin is rewritten, so the upstream's origin check still sees a
      // foreign site (and still sees no Origin when the client sent none).
      if (forwarded.get("origin") === pageOrigin) forwarded.set("origin", origin)
      const headers = Object.fromEntries(forwarded)
      return upgradeBridged(req, server, upstream, headers)
    }

    const { hostname: pageHostname } = new URL(page.origin)
    const originMap = new Map([
      [new URL(page.target.upstream).origin, page.origin],
      ...page.target.extraUpstreams.map(
        (extra) =>
          [new URL(extra.upstream).origin, `http://${pageHostname}:${extra.port}`] as const,
      ),
    ])
    return proxyHttp(
      req,
      { pageOrigin, upstream, originMap, boot: match.primary ? boot(record) : null },
      {
        fetch: deps.fetch,
        onUpstreamFailure: (url) => live.push(page.id, { type: "upstream-failure", port, url }),
      },
    )
  }

  const websocket = {
    open(ws: ServerWebSocket<SocketData>) {
      if (isBridge(ws)) return bridgeHandlers.open(ws)
      if (ws.data.kind !== "live") return
      const { pageId } = ws.data
      ws.data.detach = live.attach(pageId, {
        send: (data) => ws.send(data),
        close: (code, reason) => ws.close(code, reason),
      })
      // The overlay's hello snapshot precedes this attach, so a change pushed in between reached
      // no socket. This handler is synchronous: nothing can be pushed between attach and replay.
      // A pairing is only ever set, never cleared, so an unpaired page has nothing to replay.
      const record = pages.get(pageId)
      if (record) {
        const replay: ServerMessage[] = []
        const pairing = pagePairing(overlay, record)
        if (pairing) replay.push({ type: "pairing", pairing })
        for (const summary of overlay.inbox.summaries({ pageId })) {
          const round = overlay.inbox.round(summary.id)
          if (round) replay.push({ type: "round", round })
        }
        for (const message of replay) ws.send(JSON.stringify(ServerMessage.parse(message)))
      }
    },
    message(ws: ServerWebSocket<SocketData>, message: string | Buffer) {
      if (isBridge(ws)) return bridgeHandlers.message(ws, message)
      let data: unknown
      try {
        data = typeof message === "string" ? JSON.parse(message) : null
      } catch {}
      if (!ClientMessage.safeParse(data).success) ws.close(1007, "not a ClientMessage")
    },
    close(ws: ServerWebSocket<SocketData>, code: number, reason: string) {
      if (isBridge(ws)) return bridgeHandlers.close(ws, code, reason)
      if (ws.data.kind === "live") ws.data.detach?.()
    },
  }

  await claimControlSocket(deps.controlSocket)

  const listeners: Server<SocketData>[] = []
  const tried: string[] = []
  for (const port of deps.poolPorts) {
    try {
      listeners.push(
        Bun.serve<SocketData>({ hostname: "127.0.0.1", port, fetch: handle, websocket }),
      )
      tried.push(`${port} (bound)`)
    } catch (error) {
      if (errorCode(error) === "EADDRINUSE") {
        tried.push(`${port} (in use)`)
        continue
      }
      tried.push(`${port} (${error instanceof Error ? error.message : String(error)})`)
      await Promise.all(listeners.map((listener) => listener.stop(true)))
      throw new Error(`Could not bind the iter8 port pool; tried ${tried.join(", ")}`, {
        cause: error,
      })
    }
  }
  if (listeners.length === 0) {
    throw new Error(`No iter8 pool port could be bound; tried ${tried.join(", ")}`)
  }

  const control = await bindControlSocket(deps.controlSocket, controlApp).catch(async (error) => {
    await Promise.all(listeners.map((listener) => listener.stop(true)))
    throw error
  })

  return {
    ports: listeners.flatMap((listener) => listener.port ?? []),
    watchFolder(record) {
      const { id, target } = record.page
      if (target.kind !== "folder" || watchers.has(id)) return
      watchers.set(
        id,
        watchFolderFiles(target.root, () => live.push(id, { type: "reload" })),
      )
    },
    async stop() {
      for (const stopWatching of watchers.values()) stopWatching()
      watchers.clear()
      await Promise.all([...listeners, control].map((server) => server.stop(true)))
      await rm(deps.controlSocket, { force: true })
    },
  }
}
