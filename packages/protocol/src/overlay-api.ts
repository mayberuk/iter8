import { z } from "zod"
import { Screenshot } from "./capture"
import {
  ChatSetting,
  ChatToggle,
  MessagePage,
  PostMessageRequest,
  PostMessageResult,
  SendNowResult,
} from "./conversation"
import {
  IdempotencyKey,
  MachineId,
  NoteId,
  OwnerId,
  PageId,
  PageToken,
  PairingGeneration,
  RoundId,
} from "./ids"
import { Note } from "./note"
import { Page } from "./page"
import { LiveSession, Pairing } from "./pairing"
import { OverlayPrefs, PageState } from "./prefs"
import { Round, RoundSummary } from "./round"
import { ResolvedSourceLead, SourceLead } from "./source"
import { PROTOCOL_VERSION, ProtocolVersion } from "./version"

export const OVERLAY_PREFIX = "/__iter8"
/** Every file of the overlay build is served here without a token. */
export const ASSET_PREFIX = `${OVERLAY_PREFIX}/assets/`
export const OVERLAY_SCRIPT_PATH = `${ASSET_PREFIX}overlay.js`
export const SOURCE_BUNDLE_PATH = `${ASSET_PREFIX}source.js`
/** The page that proves an SSH-forwarded port reached the expected machine and page. */
export const LANDING_PATH = `${OVERLAY_PREFIX}/land`
export const TOKEN_HEADER = "x-iter8-token"
export const LIVE_PATH = `${OVERLAY_PREFIX}/live`

/** The landing page's hash parameters, short because they sit in a URL a person may read. */
export const LandingFragment = z.object({ m: MachineId, p: PageId, t: PageToken })
export type LandingFragment = z.infer<typeof LandingFragment>

/**
 * A browser `WebSocket` cannot set headers, so the live socket carries the protocol version and
 * the page token as offered subprotocols.
 */
export function liveSubprotocols(token: PageToken): string[] {
  return [`iter8.v${PROTOCOL_VERSION}`, `iter8-token.${token}`]
}

export const HelloRequest = z.object({
  protocolVersion: ProtocolVersion,
  pageId: PageId,
  machineId: MachineId,
})
export type HelloRequest = z.infer<typeof HelloRequest>

export const HelloResult = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("accepted"),
    protocolVersion: ProtocolVersion,
    serviceVersion: z.string().min(1),
    machineId: MachineId,
    machineName: z.string().min(1),
    page: Page,
    state: PageState,
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["version-mismatch", "wrong-machine", "unknown-page", "bad-token"]),
    expected: z.object({ protocolVersion: ProtocolVersion, machineId: MachineId }),
  }),
])
export type HelloResult = z.infer<typeof HelloResult>

export const Whoami = z.object({ machineId: MachineId, pageId: PageId })
export type Whoami = z.infer<typeof Whoami>

export const DraftList = z.array(Note)
export type DraftList = z.infer<typeof DraftList>

/** The service owns a draft's id, page, author, resolution and creation time. */
export const DraftBody = Note.omit({
  id: true,
  pageId: true,
  author: true,
  resolution: true,
  createdAt: true,
})
export type DraftBody = z.infer<typeof DraftBody>

export const Ok = z.object({ ok: z.literal(true) })
export type Ok = z.infer<typeof Ok>

/** Retrying with the same idempotency key returns the same round. */
export const SendRequest = z.object({
  idempotencyKey: IdempotencyKey,
  noteIds: z.array(NoteId).min(1),
  generation: PairingGeneration,
})
export type SendRequest = z.infer<typeof SendRequest>

export const SendResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), round: Round }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["session-gone", "stale-generation", "no-pairing"]),
    pairing: Pairing.nullable(),
  }),
])
export type SendResult = z.infer<typeof SendResult>

export const RoundSummaryList = z.array(RoundSummary)
export type RoundSummaryList = z.infer<typeof RoundSummaryList>

export const LiveSessionList = z.array(LiveSession)
export type LiveSessionList = z.infer<typeof LiveSessionList>

export const AttachRequest = z.object({ owner: OwnerId })
export type AttachRequest = z.infer<typeof AttachRequest>

/** Reattaches only the calling page, and only to a session the service sees as live. */
export const AttachResult = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), pairing: Pairing, requeued: z.array(RoundId) }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum(["not-live", "unknown-owner"]),
    sessions: LiveSessionList,
  }),
])
export type AttachResult = z.infer<typeof AttachResult>

type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: string
  request: z.ZodType | null
  response: z.ZodType | null
}

/**
 * Every overlay route. Each requires the page token in {@link TOKEN_HEADER} and an Origin equal to
 * the page's origin. A `null` schema means the body is not JSON: absent, or PNG bytes for a
 * screenshot, which the overlay fetches with the token and shows through an object URL.
 */
export const OVERLAY_ROUTES = {
  hello: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/hello`,
    request: HelloRequest,
    response: HelloResult,
  },
  whoami: { method: "GET", path: `${OVERLAY_PREFIX}/whoami`, request: null, response: Whoami },
  listDrafts: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/drafts`,
    request: null,
    response: DraftList,
  },
  createDraft: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/drafts`,
    request: DraftBody,
    response: Note,
  },
  putDraft: {
    method: "PUT",
    path: `${OVERLAY_PREFIX}/drafts/:noteId`,
    request: DraftBody,
    response: Note,
  },
  deleteDraft: {
    method: "DELETE",
    path: `${OVERLAY_PREFIX}/drafts/:noteId`,
    request: null,
    response: Ok,
  },
  send: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/rounds`,
    request: SendRequest,
    response: SendResult,
  },
  listRounds: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/rounds`,
    request: null,
    response: RoundSummaryList,
  },
  listMessages: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/messages`,
    request: null,
    response: MessagePage,
  },
  postMessage: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/messages`,
    request: PostMessageRequest,
    response: PostMessageResult,
  },
  getChat: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/chat`,
    request: null,
    response: ChatSetting,
  },
  setChat: {
    method: "PUT",
    path: `${OVERLAY_PREFIX}/chat`,
    request: ChatToggle,
    response: ChatSetting,
  },
  sendNow: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/rounds/:roundId/now`,
    request: null,
    response: SendNowResult,
  },
  uploadScreenshot: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/screenshots`,
    request: null,
    response: Screenshot,
  },
  getScreenshot: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/screenshots/:ref`,
    request: null,
    response: null,
  },
  symbolicate: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/symbolicate`,
    request: SourceLead,
    response: ResolvedSourceLead,
  },
  listSessions: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/sessions`,
    request: null,
    response: LiveSessionList,
  },
  attach: {
    method: "POST",
    path: `${OVERLAY_PREFIX}/attach`,
    request: AttachRequest,
    response: AttachResult,
  },
  getPrefs: {
    method: "GET",
    path: `${OVERLAY_PREFIX}/prefs`,
    request: null,
    response: OverlayPrefs,
  },
  savePrefs: {
    method: "PUT",
    path: `${OVERLAY_PREFIX}/prefs`,
    request: OverlayPrefs,
    response: OverlayPrefs,
  },
} as const satisfies Record<string, Route>
