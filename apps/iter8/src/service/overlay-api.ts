import { zValidator } from "@hono/zod-validator"
import {
  ASSET_PREFIX,
  type AttachResult,
  type ChatSetting,
  type HelloResult,
  LANDING_PATH,
  liveSubprotocols,
  type MachineId,
  MESSAGE_PAGE_DEFAULT,
  MessageQuery,
  NoteId,
  OVERLAY_PREFIX,
  OVERLAY_ROUTES,
  OverlayBoot,
  type PageId,
  type Pairing,
  type PostMessageResult,
  PROTOCOL_VERSION,
  RoundId,
  ScreenshotRef,
  type SendResult,
  SOURCE_BUNDLE_PATH,
  TOKEN_HEADER,
} from "@iter8/protocol"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import type { AgentNotes } from "../pages/agent-notes"
import type { HostMatch, PageRecord, Pages } from "../pages/pages"
import type { Prefs } from "../pages/prefs"
import type { Screenshots } from "../pages/screenshots"
import type { Owners } from "../pairing/owners"
import type { Inbox } from "../rounds/inbox"
import type { Symbolicator } from "../symbolicate/symbolicate"
import { serveAsset } from "./assets"
import { landingResponse } from "./landing"
import type { LiveHub } from "./live"
import type { Waiters } from "./waiters"

/** The server resolves the request's host to a page before handing it to the overlay app. */
export type OverlayEnv = { Bindings: { match: HostMatch | null; pageOrigin: string } }

export type OverlayApiDeps = {
  pages: Pages
  owners: Owners
  inbox: Inbox
  agentNotes: AgentNotes
  screenshots: Screenshots
  prefs: Prefs
  live: LiveHub
  waiters: Waiters
  symbolicator: Symbolicator
  overlayDir: string
  machineId: MachineId
  machineName: string
  serviceVersion: string
}

const R = OVERLAY_ROUTES

export function bootFor(
  record: PageRecord,
  machineId: MachineId,
  machineName: string,
): OverlayBoot {
  return OverlayBoot.parse({
    protocolVersion: PROTOCOL_VERSION,
    pageId: record.page.id,
    machineId,
    machineName,
    token: record.token,
    apiBase: OVERLAY_PREFIX,
    sourceBundleUrl: SOURCE_BUNDLE_PATH,
  })
}

export function pagePairing(deps: OverlayApiDeps, record: PageRecord): Pairing | null {
  const paired = record.page.pairing
  if (!paired) return null
  const listener = deps.waiters.isArmed(paired.owner) ? "armed" : "none"
  return deps.owners.pairing(paired.owner, paired.generation, listener)
}

export function pageChat(deps: OverlayApiDeps, record: PageRecord): ChatSetting {
  const pairing = pagePairing(deps, record)
  const reachable =
    pairing !== null && pairing.state.status !== "gone" && deps.waiters.modAttached(pairing.owner)
  return deps.inbox.conversation.chatSetting(record.page, reachable)
}

/** Checked before the upgrade: a browser WebSocket carries no token header, only subprotocols. */
export function authorizeLive(
  req: Request,
  match: HostMatch | null,
  pageOrigin: string,
  pages: Pages,
): { ok: true; pageId: PageId; protocol: string } | { ok: false; response: Response } {
  const refuse = (status: 401 | 403) => ({
    ok: false as const,
    response: new Response(null, { status }),
  })
  if (req.headers.get("origin") !== pageOrigin) return refuse(403)
  if (!match?.primary) return refuse(403)
  const { record } = match
  const offered = (req.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
  const offersAll = liveSubprotocols(record.token).every((protocol) => {
    if (!protocol.endsWith(record.token)) return offered.includes(protocol)
    const prefix = protocol.slice(0, -record.token.length)
    const token = offered.find((candidate) => candidate.startsWith(prefix))
    return pages.verifyToken(record, token === undefined ? null : token.slice(prefix.length))
  })
  if (!offersAll) return refuse(401)
  return { ok: true, pageId: record.page.id, protocol: `iter8.v${PROTOCOL_VERSION}` }
}

export function createOverlayApi(deps: OverlayApiDeps) {
  const expected = { protocolVersion: PROTOCOL_VERSION, machineId: deps.machineId }

  const guard = createMiddleware<OverlayEnv & { Variables: { match: HostMatch } }>(
    async (c, next) => {
      const { match, pageOrigin } = c.env
      // Chromium omits Origin on a same-origin GET, so Sec-Fetch-Site vouches for the page instead.
      const origin =
        c.req.header("origin") ??
        (c.req.header("sec-fetch-site") === "same-origin" ? pageOrigin : null)
      if (c.req.method === "OPTIONS" || origin !== pageOrigin) return c.body(null, 403)
      if (!match) return c.body(null, 404)
      if (!deps.pages.verifyToken(match.record, c.req.header(TOKEN_HEADER) ?? null)) {
        if (c.req.method === R.hello.method && c.req.path === R.hello.path) {
          const refused: HelloResult = { outcome: "refused", reason: "bad-token", expected }
          return c.json(refused, 401)
        }
        return c.body(null, 401)
      }
      c.set("match", match)
      await next()
    },
  )

  return new Hono<OverlayEnv>()
    .get(`${ASSET_PREFIX}*`, (c) =>
      serveAsset(deps.overlayDir, new URL(c.req.url).pathname.slice(ASSET_PREFIX.length)),
    )
    .get(LANDING_PATH, () => landingResponse())
    .use(`${OVERLAY_PREFIX}/*`, guard)
    .post(R.hello.path, zValidator("json", R.hello.request), (c) => {
      const hello = c.req.valid("json")
      const { record } = c.var.match
      const pageId = record.page.id
      const reason =
        hello.protocolVersion !== PROTOCOL_VERSION
          ? "version-mismatch"
          : hello.machineId !== deps.machineId
            ? "wrong-machine"
            : hello.pageId !== pageId
              ? "unknown-page"
              : null
      if (reason) {
        const refused: HelloResult = { outcome: "refused", reason, expected }
        return c.json(refused)
      }
      const accepted: HelloResult = {
        outcome: "accepted",
        protocolVersion: PROTOCOL_VERSION,
        serviceVersion: deps.serviceVersion,
        machineId: deps.machineId,
        machineName: deps.machineName,
        page: record.page,
        state: {
          drafts: deps.inbox.drafts(pageId),
          rounds: deps.inbox
            .summaries({ pageId })
            .flatMap((summary) => deps.inbox.round(summary.id) ?? []),
          agentNotes: deps.agentNotes.forPage(pageId),
          pairing: pagePairing(deps, record),
          liveSessions: deps.owners.liveSessions(),
          prefs: deps.prefs.get(),
        },
      }
      return c.json(accepted)
    })
    .get(R.whoami.path, (c) =>
      c.json({ machineId: deps.machineId, pageId: c.var.match.record.page.id }),
    )
    .get(R.listDrafts.path, (c) => c.json(deps.inbox.drafts(c.var.match.record.page.id)))
    .post(R.createDraft.path, zValidator("json", R.createDraft.request), (c) =>
      c.json(deps.inbox.createDraft(c.var.match.record.page.id, c.req.valid("json")), 201),
    )
    .put(R.putDraft.path, zValidator("json", R.putDraft.request), (c) => {
      const noteId = NoteId.safeParse(c.req.param("noteId"))
      const note = noteId.success
        ? deps.inbox.putDraft(c.var.match.record.page.id, noteId.data, c.req.valid("json"))
        : null
      return note ? c.json(note) : c.body(null, 404)
    })
    .delete(R.deleteDraft.path, (c) => {
      const noteId = NoteId.safeParse(c.req.param("noteId"))
      const deleted =
        noteId.success && deps.inbox.deleteDraft(c.var.match.record.page.id, noteId.data)
      return deleted ? c.json({ ok: true as const }) : c.body(null, 404)
    })
    .post(R.send.path, zValidator("json", R.send.request), (c) => {
      let result: SendResult
      try {
        result = deps.inbox.send(c.var.match.record.page.id, c.req.valid("json"))
      } catch (error) {
        if (error instanceof Error && error.cause === "not-found") return c.body(null, 404)
        throw error
      }
      if (result.outcome === "accepted") {
        const { round } = result
        // A retried send can return a round already announced or claimed, which has nothing to wake for.
        if (round.owner && round.state.stage === "queued") deps.waiters.wake(round.owner)
        deps.live.push(round.pageId, { type: "round", round })
      }
      return c.json(result)
    })
    .get(R.listRounds.path, (c) =>
      c.json(deps.inbox.summaries({ pageId: c.var.match.record.page.id })),
    )
    .get(R.listMessages.path, zValidator("query", MessageQuery), (c) => {
      const { before, limit } = c.req.valid("query")
      return c.json(
        deps.inbox.conversation.list(c.var.match.record.page.id, {
          before: before ?? null,
          limit: limit === undefined ? MESSAGE_PAGE_DEFAULT : Number(limit),
        }),
      )
    })
    .post(R.postMessage.path, zValidator("json", R.postMessage.request), (c) => {
      const { record } = c.var.match
      const pageId = record.page.id
      const request = c.req.valid("json")
      const stored = deps.inbox.conversation.byKey(pageId, request.idempotencyKey)
      if (stored) return c.json({ outcome: "accepted" as const, message: stored })
      const pairing = pagePairing(deps, record)
      const chat = pageChat(deps, record)
      const reason =
        pairing === null
          ? "no-pairing"
          : request.generation !== pairing.generation
            ? "stale-generation"
            : pairing.state.status === "gone"
              ? "session-gone"
              : !chat.enabled
                ? "chat-off"
                : !chat.reachable
                  ? "unreachable"
                  : null
      if (reason !== null) {
        const refused: PostMessageResult = { outcome: "refused", reason, chat, pairing }
        return c.json(refused)
      }
      if (!pairing) throw new Error(`Page ${pageId} has no pairing after chat acceptance`)
      const message = deps.inbox.conversation.post(pageId, pairing.owner, request)
      deps.live.push(pageId, { type: "message", message })
      deps.waiters.wake(pairing.owner)
      return c.json({ outcome: "accepted" as const, message })
    })
    .get(R.getChat.path, (c) => c.json(pageChat(deps, c.var.match.record)))
    .put(R.setChat.path, zValidator("json", R.setChat.request), (c) => {
      const { record } = c.var.match
      deps.inbox.conversation.setChat(record.page.id, c.req.valid("json").enabled)
      const chat = pageChat(deps, record)
      deps.live.push(record.page.id, { type: "chat", chat })
      return c.json(chat)
    })
    .post(R.sendNow.path, (c) => {
      const roundId = RoundId.safeParse(c.req.param("roundId"))
      const result = roundId.success
        ? deps.inbox.sendNow(c.var.match.record.page.id, roundId.data)
        : null
      if (!result) return c.body(null, 404)
      if (result.outcome === "accepted") {
        deps.live.push(result.round.pageId, { type: "round", round: result.round })
      }
      return c.json(result)
    })
    .post(R.uploadScreenshot.path, async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer())
      const screenshot = deps.screenshots.store(c.var.match.record.page.id, bytes)
      return screenshot ? c.json(screenshot, 201) : c.body(null, 415)
    })
    .get(R.getScreenshot.path, (c) => {
      const ref = ScreenshotRef.safeParse(c.req.param("ref"))
      const png = ref.success ? deps.screenshots.read(c.var.match.record.page.id, ref.data) : null
      return png
        ? new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } })
        : c.body(null, 404)
    })
    .post(R.symbolicate.path, zValidator("json", R.symbolicate.request), async (c) => {
      const { record, upstream } = c.var.match
      // The listener's own upstream, not the primary's: a page on an extra listener loads its
      // scripts from that upstream.
      const { target } = record.page
      const resolved = await deps.symbolicator.resolve(c.req.valid("json"), {
        projectRoot: record.projectRoot,
        pageOrigin: c.env.pageOrigin,
        upstream,
        folderRoot: target.kind === "folder" ? target.root : null,
      })
      return c.json(resolved)
    })
    .get(R.listSessions.path, (c) => c.json(deps.owners.liveSessions()))
    .post(R.attach.path, zValidator("json", R.attach.request), (c) => {
      const { owner } = c.req.valid("json")
      const sessions = deps.owners.liveSessions()
      if (!sessions.some((session) => session.owner === owner)) {
        const refused: AttachResult = {
          outcome: "refused",
          reason: deps.owners.resolve([], owner) ? "not-live" : "unknown-owner",
          sessions,
        }
        return c.json(refused)
      }
      const pageId = c.var.match.record.page.id
      deps.owners.pairPage(pageId, owner)
      deps.inbox.conversation.setFocus(owner, pageId, null)
      const requeued = deps.inbox.requeuePage(pageId, owner)
      const record = deps.pages.get(pageId)
      const pairing = record && pagePairing(deps, record)
      if (!record || !pairing) throw new Error(`Page ${pageId} has no pairing right after attach`)
      deps.live.push(pageId, { type: "pairing", pairing })
      deps.live.push(pageId, { type: "chat", chat: pageChat(deps, record) })
      for (const round of requeued) deps.live.push(pageId, { type: "round", round })
      if (requeued.length > 0) deps.waiters.wake(owner)
      const accepted: AttachResult = {
        outcome: "accepted",
        pairing,
        requeued: requeued.map((round) => round.id),
      }
      return c.json(accepted)
    })
    .get(R.getPrefs.path, (c) => c.json(deps.prefs.get()))
    .put(R.savePrefs.path, zValidator("json", R.savePrefs.request), (c) =>
      c.json(deps.prefs.save(c.req.valid("json"))),
    )
}

export type OverlayApp = ReturnType<typeof createOverlayApi>
