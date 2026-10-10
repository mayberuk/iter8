import { expect, test } from "bun:test"
import { PageId, type ServerMessage } from "@iter8/protocol"
import { createLiveHub, type LiveSocket } from "./live"

const page = PageId.parse("larkspur")
const otherPage = PageId.parse("willow")

function recordSocket() {
  const messages: string[] = []
  const closes: Array<{ code: number | undefined; reason: string | undefined }> = []
  const socket: LiveSocket = {
    send(data) {
      messages.push(data)
    },
    close(code, reason) {
      closes.push({ code, reason })
    },
  }
  return { socket, messages, closes }
}

test("push reaches every socket of its page and no socket of another page", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const second = recordSocket()
  const other = recordSocket()
  hub.attach(page, first.socket)
  hub.attach(page, second.socket)
  hub.attach(otherPage, other.socket)

  hub.push(page, { type: "pairing", pairing: null })

  expect(first.messages).toEqual(['{"type":"pairing","pairing":null}'])
  expect(second.messages).toEqual(first.messages)
  expect(other.messages).toEqual([])
  expect(hub.size()).toBe(3)
  expect(hub.connectedPageIds()).toEqual([page, otherPage])
})

test("push parses once before serializing the validated message", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const second = recordSocket()
  hub.attach(page, first.socket)
  hub.attach(page, second.socket)
  let reads = 0
  const message = {
    type: "pairing" as const,
    get pairing() {
      reads++
      return null
    },
    extra: "discard this",
    toJSON() {
      throw new Error("unvalidated serialization")
    },
  }

  hub.push(page, message)

  expect(reads).toBe(1)
  expect(first.messages).toEqual(['{"type":"pairing","pairing":null}'])
  expect(second.messages).toEqual(first.messages)
})

test.each([
  { type: "unknown" },
  { type: "pairing" },
  { type: "agent-note-removed", noteId: "bad" },
  { type: "upstream-failure", port: 0, url: "not a URL" },
])("invalid push throws before sending: %j", (message) => {
  const hub = createLiveHub()
  const first = recordSocket()
  const second = recordSocket()
  hub.attach(page, first.socket)
  hub.attach(page, second.socket)

  expect(() => hub.push(page, message as unknown as ServerMessage)).toThrow()
  expect(first.messages).toEqual([])
  expect(second.messages).toEqual([])
})

test("push validates even when the page has no sockets", () => {
  const hub = createLiveHub()
  expect(() => hub.push(page, { type: "unknown" } as unknown as ServerMessage)).toThrow()
  hub.push(page, { type: "reload" })
  expect(hub.size()).toBe(0)
})

test("detach is idempotent and removes only that attachment", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const second = recordSocket()
  const detachFirst = hub.attach(page, first.socket)
  const detachSecond = hub.attach(page, second.socket)

  detachFirst()
  detachFirst()
  hub.push(page, { type: "reload" })
  hub.broadcast({ type: "draining" })

  expect(first.messages).toEqual([])
  expect(second.messages).toEqual(['{"type":"reload"}', '{"type":"draining"}'])
  expect(hub.size()).toBe(1)
  expect(hub.connectedPageIds()).toEqual([page])
  detachSecond()
  expect(hub.size()).toBe(0)
  expect(hub.connectedPageIds()).toEqual([])
})

test("an old detach cannot remove a new page connection", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const detach = hub.attach(page, first.socket)
  detach()
  const replacement = recordSocket()
  hub.attach(page, replacement.socket)

  detach()
  hub.push(page, { type: "reload" })

  expect(replacement.messages).toEqual(['{"type":"reload"}'])
  expect(hub.connectedPageIds()).toEqual([page])
})

test.each(["push", "broadcast"] as const)("%s removes failed sockets and continues", (method) => {
  const hub = createLiveHub()
  let attempts = 0
  hub.attach(page, {
    send() {
      attempts++
      throw new Error("disconnected")
    },
    close() {},
  })
  const healthy = recordSocket()
  hub.attach(page, healthy.socket)
  if (method === "push") hub.push(page, { type: "reload" })
  else hub.broadcast({ type: "reload" })
  hub.broadcast({ type: "draining" })

  expect(attempts).toBe(1)
  expect(healthy.messages).toEqual(['{"type":"reload"}', '{"type":"draining"}'])
  expect(hub.size()).toBe(1)
})

test("a page disappears when its last socket fails to send", () => {
  const hub = createLiveHub()
  hub.attach(page, {
    send() {
      throw new Error("disconnected")
    },
    close() {},
  })
  hub.push(page, { type: "reload" })
  expect(hub.size()).toBe(0)
  expect(hub.connectedPageIds()).toEqual([])
})

test("broadcast reaches all pages and validates before sending", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const second = recordSocket()
  const other = recordSocket()
  hub.attach(page, first.socket)
  hub.attach(page, second.socket)
  hub.attach(otherPage, other.socket)

  expect(() => hub.broadcast({ type: "unknown" } as unknown as ServerMessage)).toThrow()
  expect(first.messages).toEqual([])
  expect(second.messages).toEqual([])
  expect(other.messages).toEqual([])
  hub.broadcast({ type: "draining" })
  expect(first.messages).toEqual(['{"type":"draining"}'])
  expect(second.messages).toEqual(first.messages)
  expect(other.messages).toEqual(first.messages)
})

test("closeAll closes every attached socket and empties the hub", () => {
  const hub = createLiveHub()
  const first = recordSocket()
  const other = recordSocket()
  const detached = recordSocket()
  const detach = hub.attach(page, first.socket)
  hub.attach(otherPage, other.socket)
  hub.attach(page, detached.socket)()

  hub.closeAll(1012, "service restarting")
  hub.closeAll(1012, "service restarting")
  hub.broadcast({ type: "draining" })
  detach()

  expect(first.closes).toEqual([{ code: 1012, reason: "service restarting" }])
  expect(other.closes).toEqual(first.closes)
  expect(detached.closes).toEqual([])
  expect(first.messages).toEqual([])
  expect(other.messages).toEqual([])
  expect(hub.size()).toBe(0)
  expect(hub.connectedPageIds()).toEqual([])
})

test("closeAll continues when a socket's close throws and allows fresh attachments", () => {
  const hub = createLiveHub()
  const detach = hub.attach(page, {
    send() {},
    close() {
      throw new Error("already closed")
    },
  })
  const healthy = recordSocket()
  hub.attach(otherPage, healthy.socket)
  hub.closeAll(1001, "stopping")

  expect(healthy.closes).toEqual([{ code: 1001, reason: "stopping" }])
  expect(hub.size()).toBe(0)
  const replacement = recordSocket()
  hub.attach(page, replacement.socket)
  detach()
  hub.push(page, { type: "reload" })
  expect(replacement.messages).toEqual(['{"type":"reload"}'])
})

test("live hubs have independent socket state", () => {
  const first = createLiveHub()
  const second = createLiveHub()
  const connection = recordSocket()
  first.attach(page, connection.socket)

  second.push(page, { type: "reload" })
  second.closeAll(1001, "stopping")

  expect(connection.messages).toEqual([])
  expect(connection.closes).toEqual([])
  expect(first.size()).toBe(1)
  expect(second.size()).toBe(0)
})
