import { extname, join, resolve, sep } from "node:path"
import {
  ASSET_PREFIX,
  ChatSetting,
  ClientMessage,
  ConversationMessage,
  LIVE_PATH,
  LiveSessionList,
  liveSubprotocols,
  MachineId,
  MESSAGE_PAGE_DEFAULT,
  type MessageId,
  MessageQuery,
  type Note,
  OVERLAY_PREFIX,
  OVERLAY_ROUTES,
  OverlayBoot,
  OverlayPrefs,
  Page,
  PageId,
  PageState,
  PageToken,
  Pairing,
  PairingGeneration,
  PostMessageResult,
  PROTOCOL_VERSION,
  Round,
  renderBootScript,
  SendNowResult,
  SendResult,
  ServerMessage,
  SOURCE_BUNDLE_PATH,
  TOKEN_HEADER,
} from "@iter8/protocol"
import { type Context, Hono } from "hono"
import { upgradeWebSocket, websocket } from "hono/bun"
import type { WSContext } from "hono/ws"
import type { z } from "zod"
import { nextPort } from "../rig/ports"

const SeededState = PageState.pick({ drafts: true, rounds: true, agentNotes: true })
const SendRefusal = SendResult.options[1]
const PostMessageRefusal = PostMessageResult.options[1]
const PostFailure = PostMessageRefusal.omit({ chat: true, pairing: true })
const SendNowRefusal = SendNowResult.options[1]

export type MockServiceOptions = {
  folder: string
  overlayDir: string
  pageId?: string
  pairing?: z.input<typeof Pairing> | null
  liveSessions?: z.input<typeof LiveSessionList>
  pageState?: z.input<typeof SeededState>
  prefs?: z.input<typeof OverlayPrefs>
  chat?: z.input<typeof ChatSetting>
  messages?: z.input<typeof ConversationMessage>[]
}

export type RecordedRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

const DEFAULT_PREFS: z.input<typeof OverlayPrefs> = {
  theme: "auto",
  dock: "br",
  collapsed: false,
  pinsVisible: true,
  coachDone: false,
}

function reply<S extends z.ZodType>(schema: S, value: z.input<S>, status = 200): Response {
  return Response.json(schema.parse(value), { status })
}

async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined))
  return parsed.success ? parsed.data : null
}

function nextNumber(ids: string[]): number {
  return Math.max(0, ...ids.map(numberOf)) + 1
}

function numberOf(id: string): number {
  return Number(id.slice(1))
}

// A built single-page app has no file per route, so with `spa` an extensionless miss serves the
// root page, as a static host's fallback does.
async function fileIn(root: string, pathname: string, spa: boolean): Promise<Bun.BunFile | null> {
  const path = resolve(root, `.${pathname}`)
  if (path !== root && !path.startsWith(root + sep)) return null
  const candidates =
    extname(path) === ""
      ? [join(path, "index.html"), ...(spa ? [join(root, "index.html")] : [])]
      : [path]
  for (const candidate of candidates) {
    const file = Bun.file(candidate)
    if (await file.exists()) return file
  }
  return null
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  const ihdr = new TextDecoder().decode(bytes.subarray(12, 16))
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte) || ihdr !== "IHDR") {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/**
 * An in-memory overlay service that serves a built folder on the page's `*.localhost` host and
 * enforces the same token, Origin and subprotocol rules the real service does.
 */
export async function startMockService(options: MockServiceOptions) {
  const folder = resolve(options.folder)
  const overlayDir = resolve(options.overlayDir)
  const port = await nextPort()
  const pageId = PageId.parse(options.pageId ?? "mockpage")
  const host = `${pageId}.localhost:${port}`
  const origin = `http://${host}`
  const token = PageToken.parse(
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
  )
  const machineId = MachineId.parse(`mock-${crypto.randomUUID()}`)
  const machineName = "mock-machine"
  const boot = OverlayBoot.parse({
    protocolVersion: PROTOCOL_VERSION,
    pageId,
    machineId,
    machineName,
    token,
    apiBase: OVERLAY_PREFIX,
    sourceBundleUrl: SOURCE_BUNDLE_PATH,
  })
  const bootTag = `<script type="module">${renderBootScript(boot)}</script>`
  const expected = { protocolVersion: PROTOCOL_VERSION, machineId }

  const seeded = SeededState.parse(options.pageState ?? { drafts: [], rounds: [], agentNotes: [] })
  let pairing = options.pairing ? Pairing.parse(options.pairing) : null
  let liveSessions = LiveSessionList.parse(options.liveSessions ?? [])
  let prefs = OverlayPrefs.parse(options.prefs ?? DEFAULT_PREFS)
  const drafts = new Map<string, Note>(seeded.drafts.map((note) => [note.id, note]))
  let rounds: Round[] = seeded.rounds
  const agentNotes = seeded.agentNotes
  const screenshots = new Map<string, Uint8Array<ArrayBuffer>>()
  let noteCounter = nextNumber([
    ...seeded.drafts.map((note) => note.id),
    ...seeded.agentNotes.map((note) => note.id),
    ...seeded.rounds.flatMap((round) => round.notes.map((note) => note.id)),
  ])
  let roundCounter = nextNumber(seeded.rounds.map((round) => round.id))
  let messages = options.messages ? options.messages.map((m) => ConversationMessage.parse(m)) : []
  messages.sort((a, b) => numberOf(a.id) - numberOf(b.id))
  let messageCounter = nextNumber(messages.map((message) => message.id))
  let chat = ChatSetting.parse(
    options.chat ?? { enabled: true, defaultEnabled: true, reachable: true },
  )
  let sendFailure: z.output<typeof SendRefusal> | null = null
  let postFailure: z.output<typeof PostFailure> | null = null
  let sendNowFailure: z.output<typeof SendNowRefusal>["reason"] | null = null
  let postGate: Promise<void> | null = null
  const sockets = new Map<unknown, WSContext>()
  const requests: RecordedRequest[] = []
  const clientMessages: ClientMessage[] = []

  const page = () =>
    Page.parse({
      id: pageId,
      origin,
      target: { kind: "folder", root: folder },
      pairing: pairing && { owner: pairing.owner, generation: pairing.generation },
    })

  // Chromium omits Origin on a same-origin GET, so Sec-Fetch-Site vouches for the page instead.
  const requestOrigin = (c: Context) =>
    c.req.header("origin") ?? (c.req.header("sec-fetch-site") === "same-origin" ? origin : null)

  const now = () => new Date().toISOString()
  const R = OVERLAY_ROUTES

  const push = (message: z.input<typeof ServerMessage>) => {
    const text = JSON.stringify(ServerMessage.parse(message))
    for (const ws of sockets.values()) ws.send(text)
  }

  const storeMessage = (message: ConversationMessage) => {
    messages = [...messages.filter((held) => held.id !== message.id), message].sort(
      (a, b) => numberOf(a.id) - numberOf(b.id),
    )
    messageCounter = Math.max(messageCounter, numberOf(message.id) + 1)
    push({ type: "message", message })
  }

  const app = new Hono()
    .use("*", async (c, next) => {
      const raw = c.req.raw
      const text =
        raw.body && !c.req.path.startsWith(R.uploadScreenshot.path) ? await raw.clone().text() : ""
      let body: unknown = null
      try {
        body = text === "" ? null : JSON.parse(text)
      } catch {}
      requests.push({
        method: c.req.method,
        path: c.req.path,
        headers: Object.fromEntries(raw.headers),
        body,
      })
      if (new URL(c.req.url).host !== host) return c.body(null, 404)
      return next()
    })
    .get(`${ASSET_PREFIX}*`, async (c) => {
      const file = await fileIn(
        overlayDir,
        decodeURIComponent(c.req.path.slice(ASSET_PREFIX.length - 1)),
        false,
      )
      return file ? new Response(file) : c.body(null, 404)
    })
    .get(
      LIVE_PATH,
      async (c, next) => {
        const offered = (c.req.header("sec-websocket-protocol") ?? "")
          .split(",")
          .map((protocol) => protocol.trim())
        const allowed =
          c.req.header("origin") === origin &&
          liveSubprotocols(token).every((protocol) => offered.includes(protocol))
        return allowed ? next() : c.body(null, 403)
      },
      upgradeWebSocket(() => ({
        onOpen(_event, ws) {
          sockets.set(ws.raw, ws)
        },
        onMessage(event, ws) {
          let data: unknown
          try {
            data = typeof event.data === "string" ? JSON.parse(event.data) : null
          } catch {}
          const message = ClientMessage.safeParse(data)
          if (message.success) clientMessages.push(message.data)
          else ws.close(1007, "not a ClientMessage")
        },
        onClose(_event, ws) {
          sockets.delete(ws.raw)
        },
      })),
    )
    .use(`${OVERLAY_PREFIX}/*`, async (c, next) => {
      if (c.req.method === "OPTIONS" || requestOrigin(c) !== origin) return c.body(null, 403)
      if (c.req.header(TOKEN_HEADER) !== token) {
        return c.req.path === R.hello.path
          ? reply(R.hello.response, { outcome: "refused", reason: "bad-token", expected }, 401)
          : c.body(null, 401)
      }
      return next()
    })
    .post(R.hello.path, async (c) => {
      const hello = await parseBody(c, R.hello.request)
      if (!hello) return c.body(null, 400)
      const reason =
        hello.protocolVersion !== PROTOCOL_VERSION
          ? "version-mismatch"
          : hello.machineId !== machineId
            ? "wrong-machine"
            : hello.pageId !== pageId
              ? "unknown-page"
              : null
      if (reason) return reply(R.hello.response, { outcome: "refused", reason, expected })
      return reply(R.hello.response, {
        outcome: "accepted",
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: "0.0.0-mock",
        machineId,
        machineName,
        page: page(),
        state: { drafts: [...drafts.values()], rounds, agentNotes, pairing, liveSessions, prefs },
      })
    })
    .get(R.whoami.path, () => reply(R.whoami.response, { machineId, pageId }))
    .get(R.listDrafts.path, () => reply(R.listDrafts.response, [...drafts.values()]))
    .post(R.createDraft.path, async (c) => {
      const draft = await parseBody(c, R.createDraft.request)
      if (!draft) return c.body(null, 400)
      const note = R.createDraft.response.parse({
        ...draft,
        id: `N${noteCounter++}`,
        pageId,
        author: { kind: "user" },
        resolution: { status: "open" },
        createdAt: now(),
      })
      drafts.set(note.id, note)
      return reply(R.createDraft.response, note, 201)
    })
    .put(R.putDraft.path, async (c) => {
      const existing = drafts.get(c.req.param("noteId"))
      if (!existing) return c.body(null, 404)
      const draft = await parseBody(c, R.putDraft.request)
      if (!draft) return c.body(null, 400)
      const { id, author, resolution, createdAt } = existing
      const note = R.putDraft.response.parse({
        ...draft,
        id,
        pageId,
        author,
        resolution,
        createdAt,
      })
      drafts.set(note.id, note)
      return reply(R.putDraft.response, note)
    })
    .delete(R.deleteDraft.path, (c) =>
      drafts.delete(c.req.param("noteId"))
        ? reply(R.deleteDraft.response, { ok: true })
        : c.body(null, 404),
    )
    .post(R.send.path, async (c) => {
      const send = await parseBody(c, R.send.request)
      if (!send) return c.body(null, 400)
      const sent = rounds.find(
        (round) =>
          round.state.stage !== "draft" && round.state.idempotencyKey === send.idempotencyKey,
      )
      if (sent) return reply(R.send.response, { outcome: "accepted", round: sent })
      if (sendFailure) {
        const refusal = sendFailure
        sendFailure = null
        return reply(R.send.response, refusal)
      }
      if (!pairing) {
        return reply(R.send.response, { outcome: "refused", reason: "no-pairing", pairing: null })
      }
      const reason =
        pairing.state.status === "gone"
          ? "session-gone"
          : send.generation !== pairing.generation
            ? "stale-generation"
            : null
      if (reason) return reply(R.send.response, { outcome: "refused", reason, pairing })
      const notes = send.noteIds.flatMap((id) => drafts.get(id) ?? [])
      if (notes.length !== send.noteIds.length) return c.body(null, 404)
      const round = Round.parse({
        id: `R${roundCounter++}`,
        pageId,
        owner: pairing.owner,
        state: { stage: "queued", queuedAt: now(), idempotencyKey: send.idempotencyKey },
        notes,
      })
      rounds.push(round)
      for (const id of send.noteIds) drafts.delete(id)
      return reply(R.send.response, { outcome: "accepted", round })
    })
    .get(R.listRounds.path, () =>
      reply(
        R.listRounds.response,
        rounds.map((round) => ({
          id: round.id,
          pageId: round.pageId,
          owner: round.owner,
          stage: round.state.stage,
          noteCount: round.notes.length,
          doneCount: round.notes.filter((note) => note.resolution.status === "done").length,
          answeredCount: round.notes.filter((note) => note.resolution.status === "answered").length,
        })),
      ),
    )
    .get(R.listMessages.path, (c) => {
      const query = MessageQuery.safeParse(c.req.query())
      if (!query.success) return c.body(null, 400)
      const limit = query.data.limit === undefined ? MESSAGE_PAGE_DEFAULT : Number(query.data.limit)
      const { before } = query.data
      const below =
        before === undefined
          ? messages
          : messages.filter((message) => numberOf(message.id) < numberOf(before))
      return reply(R.listMessages.response, {
        messages: below.slice(-limit),
        hasOlder: below.length > limit,
      })
    })
    .post(R.postMessage.path, async (c) => {
      const post = await parseBody(c, R.postMessage.request)
      if (!post) return c.body(null, 400)
      await postGate
      const stored = messages.find(
        (message) =>
          message.author.kind === "page" && message.author.idempotencyKey === post.idempotencyKey,
      )
      if (stored) return reply(R.postMessage.response, { outcome: "accepted", message: stored })
      if (postFailure) {
        const refusal = postFailure
        postFailure = null
        return reply(R.postMessage.response, { ...refusal, chat, pairing })
      }
      const reason = !pairing
        ? "no-pairing"
        : post.generation !== pairing.generation
          ? "stale-generation"
          : pairing.state.status === "gone"
            ? "session-gone"
            : !chat.enabled
              ? "chat-off"
              : !chat.reachable
                ? "unreachable"
                : null
      if (reason) {
        return reply(R.postMessage.response, { outcome: "refused", reason, chat, pairing })
      }
      const newest = rounds.reduce<Round | null>(
        (best, round) => (!best || numberOf(round.id) > numberOf(best.id) ? round : best),
        null,
      )
      const message = ConversationMessage.parse({
        id: `M${messageCounter}`,
        pageId,
        roundId: newest?.id ?? null,
        author: {
          kind: "page",
          idempotencyKey: post.idempotencyKey,
          delivery: { status: "queued" },
        },
        text: post.text,
        at: now(),
      })
      storeMessage(message)
      return reply(R.postMessage.response, { outcome: "accepted", message })
    })
    .get(R.getChat.path, () => reply(R.getChat.response, chat))
    .put(R.setChat.path, async (c) => {
      const toggle = await parseBody(c, R.setChat.request)
      if (!toggle) return c.body(null, 400)
      chat = { ...chat, enabled: toggle.enabled }
      push({ type: "chat", chat })
      return reply(R.setChat.response, chat)
    })
    .post(R.sendNow.path, (c) => {
      const round = rounds.find((candidate) => candidate.id === c.req.param("roundId"))
      if (!round) return c.body(null, 404)
      const refuse = (reason: z.output<typeof SendNowRefusal>["reason"]) =>
        reply(R.sendNow.response, { outcome: "refused", reason, round })
      if (sendNowFailure) {
        const reason = sendNowFailure
        sendNowFailure = null
        return refuse(reason)
      }
      if (!pairing) return refuse("no-pairing")
      if (round.state.stage === "orphaned" || pairing.state.status === "gone") {
        return refuse("session-gone")
      }
      if (round.state.stage !== "queued") return refuse("not-waiting")
      const sent = {
        ...round,
        state: { ...round.state, sendNowAt: round.state.sendNowAt ?? now() },
      }
      rounds = rounds.map((candidate) => (candidate.id === sent.id ? sent : candidate))
      push({ type: "round", round: sent })
      return reply(R.sendNow.response, { outcome: "accepted", round: sent })
    })
    .post(R.uploadScreenshot.path, async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const size = pngSize(bytes)
      if (!size) return c.body(null, 415)
      const ref = crypto.randomUUID().replaceAll("-", "")
      screenshots.set(ref, bytes)
      return reply(R.uploadScreenshot.response, { ref, ...size }, 201)
    })
    .get(R.getScreenshot.path, (c) => {
      const bytes = screenshots.get(c.req.param("ref"))
      return bytes
        ? new Response(bytes, { headers: { "content-type": "image/png" } })
        : c.body(null, 404)
    })
    .post(R.symbolicate.path, async (c) => {
      const lead = await parseBody(c, R.symbolicate.request)
      if (!lead) return c.body(null, 400)
      if (lead.confidence === "none") {
        return reply(R.symbolicate.response, { confidence: "none", reason: "no-framework" })
      }
      const frame = lead.frames.find((candidate) => candidate.kind === "source")
      if (!frame) {
        return reply(R.symbolicate.response, { confidence: "none", reason: "no-frames-resolved" })
      }
      const base = { framework: lead.framework, component: lead.component, file: frame.file }
      const resolved = R.symbolicate.response.safeParse(
        lead.confidence === "file-only"
          ? { confidence: "file-only", ...base }
          : {
              confidence: lead.confidence,
              ...base,
              ...(frame.line === undefined ? {} : { line: frame.line }),
              ...(frame.column === undefined ? {} : { column: frame.column }),
            },
      )
      return reply(
        R.symbolicate.response,
        resolved.success ? resolved.data : { confidence: "none", reason: "outside-project" },
      )
    })
    .get(R.listSessions.path, () => reply(R.listSessions.response, liveSessions))
    .post(R.attach.path, async (c) => {
      const attach = await parseBody(c, R.attach.request)
      if (!attach) return c.body(null, 400)
      const session = liveSessions.find(
        (candidate) => candidate.owner === attach.owner && candidate.state.status !== "gone",
      )
      if (!session) {
        return reply(R.attach.response, {
          outcome: "refused",
          reason: "not-live",
          sessions: liveSessions,
        })
      }
      pairing = Pairing.parse({
        ...session,
        generation: PairingGeneration.parse((pairing?.generation ?? 0) + 1),
        relabelPending: false,
        listener: "armed",
      })
      const requeued: string[] = []
      const requeuedAt = now()
      rounds = rounds.map((round) => {
        const { state } = round
        if (state.stage !== "queued" && state.stage !== "announced" && state.stage !== "orphaned") {
          return round
        }
        requeued.push(round.id)
        const { queuedAt, idempotencyKey } = state
        return {
          ...round,
          owner: session.owner,
          state: { stage: "queued", queuedAt, idempotencyKey, requeuedAt },
        }
      })
      return reply(R.attach.response, { outcome: "accepted", pairing, requeued })
    })
    .get(R.getPrefs.path, () => reply(R.getPrefs.response, prefs))
    .put(R.savePrefs.path, async (c) => {
      const saved = await parseBody(c, R.savePrefs.request)
      if (!saved) return c.body(null, 400)
      prefs = saved
      return reply(R.savePrefs.response, prefs)
    })
    .get("*", async (c) => {
      if (c.req.path.startsWith(OVERLAY_PREFIX)) return c.body(null, 404)
      const file = await fileIn(folder, decodeURIComponent(c.req.path), true)
      if (!file) return c.body(null, 404)
      if (!file.type.startsWith("text/html")) return new Response(file)
      return new HTMLRewriter()
        .on("body", {
          element(body) {
            body.append(bootTag, { html: true })
          },
        })
        .transform(new Response(file, { headers: { "content-type": file.type } }))
    })

  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch, websocket })

  return {
    app,
    port,
    origin,
    pageUrl: (path = "/") => new URL(path, origin).href,
    pageId,
    token,
    machineId,
    setPairing(next: z.input<typeof Pairing> | null) {
      pairing = next && Pairing.parse(next)
    },
    setLiveSessions(list: z.input<typeof LiveSessionList>) {
      liveSessions = LiveSessionList.parse(list)
    },
    push,
    draft: () => [...drafts.values()],
    rounds: () => [...rounds],
    prefs: () => prefs,
    requests: () => [...requests],
    clientMessages: () => [...clientMessages],
    failNextSend(refusal: z.input<typeof SendRefusal>) {
      sendFailure = SendRefusal.parse(refusal)
    },
    messages: () => [...messages],
    chat: () => chat,
    pushMessage(message: z.input<typeof ConversationMessage>) {
      storeMessage(ConversationMessage.parse(message))
    },
    markDelivered(id: MessageId) {
      const held = messages.find((message) => message.id === id)
      if (held?.author.kind !== "page" || held.author.delivery.status !== "queued") {
        throw new Error(`${id} is not a queued page message`)
      }
      storeMessage({
        ...held,
        author: { ...held.author, delivery: { status: "delivered", at: now() } },
      })
    },
    setChat(next: z.input<typeof ChatSetting>) {
      chat = ChatSetting.parse(next)
      push({ type: "chat", chat })
    },
    holdPosts() {
      let release = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      postGate = held
      return () => {
        if (postGate === held) postGate = null
        release()
      }
    },
    failNextPost(refusal: z.input<typeof PostFailure>) {
      postFailure = PostFailure.parse(refusal)
    },
    failNextSendNow(reason: z.output<typeof SendNowRefusal>["reason"]) {
      sendNowFailure = SendNowRefusal.shape.reason.parse(reason)
    },
    dropSockets() {
      for (const ws of sockets.values()) ws.close(1012, "mock service dropped its sockets")
    },
    async stop() {
      for (const ws of sockets.values()) ws.close(1001, "mock service stopped")
      await server.stop(true)
    },
  }
}

export type MockService = Awaited<ReturnType<typeof startMockService>>
