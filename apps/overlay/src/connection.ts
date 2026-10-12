import {
  type AttachResult,
  type ChatSetting,
  type ChatToggle,
  type DraftBody,
  type HelloResult,
  LIVE_PATH,
  type LiveSession,
  liveSubprotocols,
  type MessagePage,
  MessageQuery,
  type Note,
  type NoteId,
  OVERLAY_ROUTES,
  type OverlayBoot,
  type OverlayPrefs,
  type OwnerId,
  type PostMessageRequest,
  type PostMessageResult,
  PROTOCOL_VERSION,
  type ResolvedSourceLead,
  type RoundId,
  type Screenshot,
  type ScreenshotRef,
  type SendNowResult,
  type SendRequest,
  type SendResult,
  ServerMessage,
  type SourceLead,
  TOKEN_HEADER,
} from "@iter8/protocol"
import type { z } from "zod"

export type ConnectionEvent =
  | { kind: "ready"; hello: Extract<HelloResult, { outcome: "accepted" }> }
  | { kind: "refused"; hello: Extract<HelloResult, { outcome: "refused" }> }
  | { kind: "unreachable" }
  | { kind: "draining" }

type RouteKey = keyof typeof OVERLAY_ROUTES
type JsonRouteKey = Exclude<RouteKey, "getScreenshot">
type WriteKey = NoteId | "prefs"

function isUnreachable(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith("status 0: network failure")
}

export function createConnection(deps: {
  boot: OverlayBoot
  host: string
  secure: boolean
  fetch: typeof fetch
  WebSocket: typeof WebSocket
  onMessage: (m: ServerMessage) => void
  onEvent: (e: ConnectionEvent) => void
}) {
  let closed = false
  let socket: WebSocket | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null
  let starting: Promise<void> | null = null
  const pending = new Map<WriteKey, DraftBody | OverlayPrefs>()
  const writes = new Map<WriteKey, Promise<void>>()
  const inflight = new Map<WriteKey, DraftBody | OverlayPrefs>()
  const errors = new Map<WriteKey, Error>()

  function parseRequest(key: RouteKey, body: unknown): unknown {
    try {
      return OVERLAY_ROUTES[key].request?.parse(body) ?? body
    } catch {
      throw new Error(`${key} status 0: invalid request`)
    }
  }

  async function http(key: RouteKey, body?: unknown, parameter?: string): Promise<Response> {
    const route = OVERLAY_ROUTES[key]
    const parsed = parseRequest(key, body)
    const headers = new Headers({ [TOKEN_HEADER]: deps.boot.token })
    const init: RequestInit = { method: route.method, headers }
    if (route.request) {
      headers.set("content-type", "application/json")
      init.body = JSON.stringify(parsed)
    } else if (key === "uploadScreenshot") {
      headers.set("content-type", "image/png")
      init.body = body as Blob
    }
    const path =
      key === "listMessages" && parameter
        ? `${route.path}?${parameter}`
        : parameter === undefined
          ? route.path
          : route.path.replace(/:noteId|:ref|:roundId/, encodeURIComponent(parameter))
    let response: Response
    try {
      response = await deps.fetch(path, init)
    } catch {
      throw new Error(`${key} status 0: network failure`)
    }
    if (!response.ok && !(key === "hello" && response.status === 401)) {
      throw new Error(`${key} status ${response.status}: request failed`)
    }
    return response
  }

  async function json<K extends JsonRouteKey>(
    key: K,
    body?: unknown,
    parameter?: string,
  ): Promise<z.output<(typeof OVERLAY_ROUTES)[K]["response"]>> {
    const response = await http(key, body, parameter)
    try {
      return OVERLAY_ROUTES[key].response.parse(await response.json()) as z.output<
        (typeof OVERLAY_ROUTES)[K]["response"]
      >
    } catch {
      throw new Error(`${key} status ${response.status}: invalid response`)
    }
  }

  async function connect(): Promise<void> {
    let hello: HelloResult
    try {
      hello = await json("hello", {
        protocolVersion: PROTOCOL_VERSION,
        pageId: deps.boot.pageId,
        machineId: deps.boot.machineId,
      })
    } catch (error) {
      if (closed) return
      if (error instanceof Error && error.message === "hello status 0: network failure") {
        deps.onEvent({ kind: "unreachable" })
        return
      }
      throw error
    }
    if (closed) return
    if (hello.outcome === "refused") {
      deps.onEvent({ kind: "refused", hello })
      return
    }
    const adopted = withQueuedWrites(hello)
    resumeWrites()
    deps.onEvent({ kind: "ready", hello: adopted })
    if (closed) return
    const live = new deps.WebSocket(
      `${deps.secure ? "wss" : "ws"}://${deps.host}${LIVE_PATH}`,
      liveSubprotocols(deps.boot.token),
    )
    socket = live
    live.onmessage = (event) => {
      if (closed || socket !== live) return
      let message: ServerMessage
      try {
        message = ServerMessage.parse(JSON.parse(event.data))
      } catch {
        return
      }
      deps.onMessage(message)
      if (message.type === "draining") {
        deps.onEvent({ kind: "draining" })
        live.close()
      }
    }
    live.onclose = () => {
      if (closed || socket !== live) return
      socket = null
      reconnect = setTimeout(() => {
        reconnect = null
        // Automatic reconnect has no awaiting caller; explicit start still exposes HTTP errors.
        void start().catch(() => {})
      }, 1000)
    }
  }

  async function start(): Promise<void> {
    if (closed || socket) return
    if (starting) return starting
    if (reconnect !== null) {
      clearTimeout(reconnect)
      reconnect = null
    }
    starting = connect()
    try {
      await starting
    } finally {
      starting = null
    }
  }

  function withQueuedWrites(
    hello: Extract<HelloResult, { outcome: "accepted" }>,
  ): Extract<HelloResult, { outcome: "accepted" }> {
    const unsaved = new Map([...inflight, ...pending])
    if (unsaved.size === 0) return hello
    const prefs = unsaved.get("prefs") as OverlayPrefs | undefined
    return {
      ...hello,
      state: {
        ...hello.state,
        drafts: hello.state.drafts.map((note) => {
          const queued = unsaved.get(note.id) as DraftBody | undefined
          return queued ? { ...note, ...queued } : note
        }),
        prefs: prefs ?? hello.state.prefs,
      },
    }
  }

  function startWrite(key: WriteKey): void {
    if (writes.has(key)) return
    const route = key === "prefs" ? "savePrefs" : "putDraft"
    const task = (async () => {
      try {
        for (;;) {
          const next = pending.get(key)
          if (next === undefined) return
          pending.delete(key)
          inflight.set(key, next)
          try {
            await json(route, next, key === "prefs" ? undefined : key)
            if (isUnreachable(errors.get(key))) errors.delete(key)
          } catch (error) {
            if (inflight.get(key) === next) {
              errors.set(key, error as Error)
              if (isUnreachable(error) && !pending.has(key)) {
                pending.set(key, next)
                return
              }
            }
          } finally {
            if (inflight.get(key) === next) inflight.delete(key)
          }
        }
      } finally {
        writes.delete(key)
      }
    })()
    writes.set(key, task)
  }

  function resumeWrites(): void {
    for (const key of [...pending.keys()]) startWrite(key)
  }

  function dropQueued(key: WriteKey): void {
    pending.delete(key)
    inflight.delete(key)
    errors.delete(key)
  }

  function enqueue(key: WriteKey, body: DraftBody | OverlayPrefs): void {
    pending.set(
      key,
      parseRequest(key === "prefs" ? "savePrefs" : "putDraft", body) as DraftBody | OverlayPrefs,
    )
    startWrite(key)
  }

  return {
    start,
    createDraft(body: DraftBody): Promise<Note> {
      return json("createDraft", body)
    },
    putDraft(id: NoteId, body: DraftBody): void {
      enqueue(id, body)
    },
    async deleteDraft(id: NoteId): Promise<void> {
      await json("deleteDraft", undefined, id)
      dropQueued(id)
    },
    async flush(): Promise<void> {
      while (writes.size) await Promise.all(writes.values())
      const [error] = errors.values()
      for (const key of [...errors.keys()]) if (!pending.has(key)) errors.delete(key)
      if (error) throw error
    },
    async send(request: SendRequest): Promise<SendResult> {
      const result = await json("send", request)
      if (result.outcome === "accepted") for (const id of request.noteIds) dropQueued(id)
      return result
    },
    async listMessages(query: MessageQuery): Promise<MessagePage> {
      let parsed: MessageQuery
      try {
        parsed = MessageQuery.parse(query)
      } catch {
        throw new Error("listMessages status 0: invalid request")
      }
      const search = new URLSearchParams()
      if (parsed.before !== undefined) search.set("before", parsed.before)
      if (parsed.limit !== undefined) search.set("limit", parsed.limit)
      return json("listMessages", undefined, search.toString())
    },
    postMessage(request: PostMessageRequest): Promise<PostMessageResult> {
      return json("postMessage", request)
    },
    getChat(): Promise<ChatSetting> {
      return json("getChat")
    },
    setChat(enabled: boolean): Promise<ChatSetting> {
      const toggle: ChatToggle = { enabled }
      return json("setChat", toggle)
    },
    sendNow(roundId: RoundId): Promise<SendNowResult> {
      return json("sendNow", undefined, roundId)
    },
    uploadScreenshot(png: Blob): Promise<Screenshot> {
      return json("uploadScreenshot", png)
    },
    async fetchScreenshot(ref: ScreenshotRef): Promise<Blob> {
      const response = await http("getScreenshot", undefined, ref)
      try {
        return await response.blob()
      } catch {
        throw new Error(`getScreenshot status ${response.status}: invalid response`)
      }
    },
    symbolicate(lead: SourceLead): Promise<ResolvedSourceLead> {
      return json("symbolicate", lead)
    },
    listSessions(): Promise<LiveSession[]> {
      return json("listSessions")
    },
    attach(owner: OwnerId): Promise<AttachResult> {
      return json("attach", { owner })
    },
    savePrefs(prefs: OverlayPrefs): void {
      enqueue("prefs", prefs)
    },
    close(): void {
      closed = true
      if (reconnect !== null) {
        clearTimeout(reconnect)
        reconnect = null
      }
      socket?.close()
      socket = null
    },
  }
}

export type Connection = ReturnType<typeof createConnection>
