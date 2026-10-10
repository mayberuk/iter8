import {
  type DraftBody,
  HelloResult,
  LIVE_PATH,
  liveSubprotocols,
  type NoteId,
  OVERLAY_ROUTES,
  type OverlayBoot,
  type PairingGeneration,
  PROTOCOL_VERSION,
  ServerMessage,
  TOKEN_HEADER,
} from "@iter8/protocol"

type Reply = { status: number; body: unknown }

/** What the probe exposes on `window.__iter8Probe` for a scenario to read through Playwright. */
export type Iter8Probe = {
  boot: OverlayBoot
  hello: HelloResult | null
  connected: boolean
  messages: ServerMessage[]
  lastError: string | null
  call: (method: string, path: string, body?: unknown) => Promise<Reply>
  putDraft: (draft: DraftBody, id?: NoteId) => Promise<Reply>
  send: (noteIds: NoteId[], generation: PairingGeneration) => Promise<Reply>
}

export const PROBE_GLOBAL = "__iter8Probe"

/** The bundle contract: the boot script imports this and calls it with the page's boot config. */
export function mount(boot: OverlayBoot): () => void {
  const fail = (error: unknown) => {
    probe.lastError = error instanceof Error ? error.message : String(error)
  }

  const call = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(path, {
      method,
      headers: {
        [TOKEN_HEADER]: boot.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, body: text === "" ? null : JSON.parse(text) }
  }

  const probe: Iter8Probe = {
    boot,
    hello: null,
    connected: false,
    messages: [],
    lastError: null,
    call,
    putDraft: (draft, id) =>
      id === undefined
        ? call(OVERLAY_ROUTES.createDraft.method, OVERLAY_ROUTES.createDraft.path, draft)
        : call(
            OVERLAY_ROUTES.putDraft.method,
            OVERLAY_ROUTES.putDraft.path.replace(":noteId", id),
            draft,
          ),
    send: (noteIds, generation) =>
      call(OVERLAY_ROUTES.send.method, OVERLAY_ROUTES.send.path, {
        idempotencyKey: crypto.randomUUID(),
        noteIds,
        generation,
      }),
  }
  Reflect.set(window, PROBE_GLOBAL, probe)

  const socket = new WebSocket(`ws://${location.host}${LIVE_PATH}`, liveSubprotocols(boot.token))
  socket.onopen = () => {
    probe.connected = true
  }
  socket.onclose = () => {
    probe.connected = false
  }
  socket.onerror = () => fail(new Error("The live socket failed"))
  socket.onmessage = (event) => {
    const message = ServerMessage.safeParse(JSON.parse(String(event.data)))
    if (message.success) probe.messages.push(message.data)
    else fail(message.error)
  }

  call(OVERLAY_ROUTES.hello.method, OVERLAY_ROUTES.hello.path, {
    protocolVersion: PROTOCOL_VERSION,
    pageId: boot.pageId,
    machineId: boot.machineId,
  })
    .then(({ body }) => {
      probe.hello = HelloResult.parse(body)
    })
    .catch(fail)

  return () => {
    socket.close()
    Reflect.deleteProperty(window, PROBE_GLOBAL)
  }
}
