import { type PageId, ServerMessage } from "@iter8/protocol"

export type LiveSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type LiveHub = {
  attach(pageId: PageId, socket: LiveSocket): () => void
  push(pageId: PageId, message: ServerMessage): void
  broadcast(message: ServerMessage): void
  closeAll(code: number, reason: string): void
  connectedPageIds(): PageId[]
  size(): number
}

export function createLiveHub(): LiveHub {
  const pages = new Map<PageId, Set<LiveSocket>>()

  function detach(pageId: PageId, sockets: Set<LiveSocket>, socket: LiveSocket): void {
    sockets.delete(socket)
    if (sockets.size === 0 && pages.get(pageId) === sockets) pages.delete(pageId)
  }

  function send(pageId: PageId, data: string): void {
    const sockets = pages.get(pageId)
    if (!sockets) return
    for (const socket of sockets) {
      try {
        socket.send(data)
      } catch {
        detach(pageId, sockets, socket)
      }
    }
  }

  return {
    attach(pageId, socket) {
      let sockets = pages.get(pageId)
      if (!sockets) {
        sockets = new Set()
        pages.set(pageId, sockets)
      }
      sockets.add(socket)
      const attached = sockets
      return () => detach(pageId, attached, socket)
    },
    push(pageId, message) {
      const data = JSON.stringify(ServerMessage.parse(message))
      send(pageId, data)
    },
    broadcast(message) {
      const data = JSON.stringify(ServerMessage.parse(message))
      for (const pageId of pages.keys()) send(pageId, data)
    },
    closeAll(code, reason) {
      const sockets = [...pages.values()].flatMap((pageSockets) => [...pageSockets])
      pages.clear()
      for (const socket of sockets) {
        try {
          socket.close(code, reason)
        } catch {}
      }
    },
    connectedPageIds() {
      return [...pages.keys()]
    },
    size() {
      let total = 0
      for (const sockets of pages.values()) total += sockets.size
      return total
    },
  }
}
