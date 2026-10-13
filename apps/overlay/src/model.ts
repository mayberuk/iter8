import {
  type AnchorStatus,
  type AttachResult,
  type BackgroundWork,
  type Box,
  type Capture,
  type ChatSetting,
  type ConversationMessage,
  type DraftBody,
  HelloResult,
  IdempotencyKey,
  type Intent,
  type LiveSession,
  MESSAGE_MAX_CHARS,
  type MessagePage,
  type MessageQuery,
  type Note,
  type NoteId,
  type NoteTarget,
  type OverlayPrefs,
  type PageId,
  type Pairing,
  type PostMessageRequest,
  type PostMessageResult,
  ROUND_TRANSITIONS,
  type Round,
  type RoundId,
  type RoundStage,
  type SendNowResult,
  type SendRequest,
  type SendResult,
  type ServerMessage,
} from "@iter8/protocol"
import { batch, computed, signal } from "@preact/signals"
import { z } from "zod"
import {
  type ConversationLoad,
  chatBlockedReason,
  mergeMessages,
  type PendingMessage,
  type PostFailure,
  settlePending,
} from "./conversation"

export const Mode = z.enum(["idle", "pick", "region", "shot", "markup", "compose"])
export type Mode = z.infer<typeof Mode>

export const DisplayNoteState = z.enum([
  "queued",
  "delivered",
  "working",
  "done",
  "answered",
  "failed",
])
export type DisplayNoteState = z.infer<typeof DisplayNoteState>

export const DockState = z.enum([
  "live",
  "busy",
  "background",
  "gone",
  "checking",
  "delivered",
  "unattached",
])
export type DockState = z.infer<typeof DockState>

export const ConnectionState = z.discriminatedUnion("status", [
  z.object({ status: z.literal("connecting") }),
  z.object({ status: z.literal("ready") }),
  z.object({ status: z.literal("unreachable") }),
  z.object({
    status: z.literal("refused"),
    reason: HelloResult.options[1].shape.reason,
  }),
  z.object({ status: z.literal("draining") }),
])
export type ConnectionState = z.infer<typeof ConnectionState>

export const MarkupTool = z.enum(["arrow", "box", "hl"])
export type MarkupTool = z.infer<typeof MarkupTool>

/** Region-relative CSS pixels; a box or highlight spans the two corners. */
export type Shape = { tool: MarkupTool; x1: number; y1: number; x2: number; y2: number }

export const EnrichmentStatus = z.enum(["running", "done"])
export type EnrichmentStatus = z.infer<typeof EnrichmentStatus>

export const SheetTab = z.enum(["round", "conversation", "history"])
export type SheetTab = z.infer<typeof SheetTab>

export const Menu = z.enum(["none", "session", "more"])
export type Menu = z.infer<typeof Menu>

export const ToastTone = z.enum(["plain", "ok", "amber", "failed"])
export type ToastTone = z.infer<typeof ToastTone>

export type Toast = {
  id: number
  text: string
  tone: ToastTone
  action: "undo" | null
  leavesAt: number
}

export type AnchorResolution =
  | { status: "anchored"; el: WeakRef<Element> }
  | { status: "moved" | "unanchored"; reason: "missing" | "ambiguous" }

type AcceptedHello = Extract<HelloResult, { outcome: "accepted" }>
type UpstreamFailure = Extract<ServerMessage, { type: "upstream-failure" }>
type Notice = { type: "reload-pending" } | UpstreamFailure

const KEEP_BODY = "Leave as is."
/** How long the dock shows a Send as delivered before it returns to the session's own state. */
const DELIVERED_MS = 2500
const MAX_TOASTS = 3
const TOAST_MS = 3200
const UNDO_TOAST_MS = 6000

const STAGE_DISPLAY = {
  draft: "queued",
  queued: "queued",
  announced: "delivered",
  claimed: "working",
  orphaned: "failed",
} as const satisfies Record<RoundStage, DisplayNoteState>

export function displayNoteState(round: Round, note: Note): DisplayNoteState {
  if (note.resolution.status !== "open") return note.resolution.status
  return STAGE_DISPLAY[round.state.stage]
}

export function isBeingWorked(round: Round, note: Note, pairing: Pairing | null): boolean {
  const { stage } = round.state
  return (
    (stage === "claimed" || stage === "announced") &&
    note.resolution.status === "open" &&
    pairing !== null &&
    pairing.owner === round.owner &&
    pairing.state.status === "busy"
  )
}

/** The state a round's marker shows in the conversation: done once no note is still open. */
export function roundDisplayState(round: Round): DisplayNoteState {
  const open = round.notes.some((note) => note.resolution.status === "open")
  return open ? STAGE_DISPLAY[round.state.stage] : "done"
}

export function dockState(
  pairing: Pairing | null,
  deliveredUntil: number | null,
  now: number,
): DockState {
  if (!pairing) return "unattached"
  if (pairing.state.status === "gone") return "gone"
  if (deliveredUntil !== null && now < deliveredUntil) return "delivered"
  if (pairing.state.status === "unknown") return "checking"
  return pairing.state.status
}

export function backgroundWords({ agents, tasks }: BackgroundWork): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
  if (tasks === 0) return `${count(agents, "agent")} running`
  if (agents === 0) return `${count(tasks, "background task")} running`
  return `${count(agents, "agent")} and ${count(tasks, "task")} running`
}

/** Pairing is checked before the draft count, so a gone or absent session always says why. */
export function sendBlockedReason(
  pairing: Pairing | null,
  draftCount: number,
): "no-pairing" | "gone" | "empty" | null {
  if (!pairing) return "no-pairing"
  if (pairing.state.status === "gone") return "gone"
  if (draftCount === 0) return "empty"
  return null
}

export function canSendNow(round: Round, pairing: Pairing | null): boolean {
  return (
    pairing?.state.status === "busy" &&
    round.state.stage === "queued" &&
    round.state.sendNowAt === undefined
  )
}

export function roundOutcome(round: Round): {
  label: string
  tone: "open" | "sent" | "done" | "failed"
} {
  const states = round.notes.map((note) => displayNoteState(round, note))
  const total = states.length
  const count = (state: DisplayNoteState) => states.filter((s) => s === state).length
  const resolved = count("done") + count("answered")
  if (resolved === total)
    return { label: total === 1 ? "Resolved" : `All ${total} resolved`, tone: "done" }
  if (round.state.stage === "orphaned") return { label: "Not delivered", tone: "failed" }
  if (count("queued") === total) return { label: "Queued", tone: "open" }
  if (count("delivered") === total) return { label: "Delivered", tone: "sent" }
  return {
    label: resolved ? `${resolved} of ${total} resolved` : `${total} in progress`,
    tone: "open",
  }
}

/** Builds each key from its own source: authored fields from the person, `capture` from the page. */
export function toDraftBody(
  authored: { intent: Intent; body: string; target: NoteTarget; anchorStatus: AnchorStatus },
  capture: Capture | undefined,
): DraftBody {
  const draft: DraftBody = {
    intent: authored.intent,
    body: authored.body,
    target: authored.target,
    anchorStatus: authored.anchorStatus,
  }
  if (capture) draft.capture = capture
  return draft
}

export function buildSendRequest(
  noteIds: readonly NoteId[],
  pairing: Pairing,
  idempotencyKey: IdempotencyKey,
): SendRequest {
  return { idempotencyKey, noteIds: [...noteIds], generation: pairing.generation }
}

function canMove(held: Round, update: Round): boolean {
  if (held.state.stage === update.state.stage) return true
  const edges: readonly RoundStage[] = ROUND_TRANSITIONS[held.state.stage]
  if (!edges.includes(update.state.stage)) return false
  if (update.state.stage !== "queued" || held.state.stage === "draft") return true
  // A queued update after announced or orphaned is only a requeue when it carries a newer
  // requeue time; without one it is the original queued message arriving late.
  const requeuedAt = update.state.requeuedAt
  if (requeuedAt === undefined) return false
  const heldRequeuedAt = "requeuedAt" in held.state ? held.state.requeuedAt : undefined
  return heldRequeuedAt === undefined || Date.parse(requeuedAt) > Date.parse(heldRequeuedAt)
}

export function applyRound(rounds: readonly Round[], update: Round): Round[] {
  const index = rounds.findIndex((round) => round.id === update.id)
  const held = rounds[index]
  if (!held) return [...rounds, update]
  if (!canMove(held, update)) return [...rounds]
  return rounds.map((round, i) => (i === index ? update : round))
}

export function sessionName(pairing: Pick<Pairing, "cwd"> | null, pageId: PageId): string {
  const segments = pairing?.cwd.split("/").filter((segment) => segment !== "") ?? []
  return segments.at(-1) ?? pageId
}

/** Round ids are not contiguous, so the next one is the highest number plus one, as the service allocates it. */
export function nextRoundNumber(rounds: readonly Round[]): number {
  return Math.max(0, ...rounds.map((round) => Number(round.id.slice(1)))) + 1
}

function roundLabel(id: RoundId): string {
  return `Round ${id.slice(1)}`
}

export function createOverlayModel(init: { hello: AcceptedHello; now: () => number }) {
  const { hello, now } = init
  const port = new URL(hello.page.origin).port

  const mode = signal<Mode>("idle")
  const connection = signal<ConnectionState>({ status: "ready" })

  const pairing = signal<Pairing | null>(hello.state.pairing)
  const liveSessions = signal<LiveSession[]>(hello.state.liveSessions)
  const machineName = signal(hello.machineName)
  const serviceVersion = signal(hello.serviceVersion)
  const pageId = signal<PageId>(hello.page.id)

  const drafts = signal<Note[]>(hello.state.drafts)
  const draftOrder = signal<NoteId[]>(hello.state.drafts.map((note) => note.id))
  const rounds = signal<Round[]>(hello.state.rounds)
  const agentNotes = signal<Note[]>(hello.state.agentNotes)
  const messages = signal<ConversationMessage[]>([])
  const conversation = signal<ConversationLoad>({ status: "unloaded" })
  const pendingMessages = signal<PendingMessage[]>([])
  const chat = signal<ChatSetting | null>(null)
  const chatDraft = signal("")
  const chatBlocked = computed(() => chatBlockedReason(pairing.value, chat.value))
  let chatEpoch = 0
  let chatLoading: number | null = null

  const hover = signal<WeakRef<Element> | null>(null)
  const climbStack = signal<WeakRef<Element>[]>([])
  const multi = signal<WeakRef<Element>[]>([])

  const composer = signal<{
    target: NoteTarget
    shot: { shapes: Shape[] } | null
    intent: Intent
    body: string
    editing: NoteId | null
    anchorStatus: AnchorStatus
    saving: boolean
    bodyError: boolean
    enrichment: EnrichmentStatus
    capture: Capture | undefined
  } | null>(null)
  const markup = signal<{ region: Box; tool: MarkupTool; shapes: Shape[] } | null>(null)
  const focus = signal(-1)
  const sheet = signal<{ open: boolean; tab: SheetTab }>({ open: false, tab: "round" })
  const menu = signal<Menu>("none")

  const prefs = signal<OverlayPrefs>(hello.state.prefs)
  const coachStep = signal(hello.state.prefs.coachDone ? -1 : 0)
  const paletteOpen = signal(false)
  const shortcutsOpen = signal(false)
  const peek = signal(false)

  const toasts = signal<Toast[]>([])
  const reloadPending = signal(false)
  /** Set when the page must reload now; the shell flushes pending draft writes, then reloads. */
  const reloadNow = signal(false)
  const upstreamFailures = signal<UpstreamFailure[]>([])
  const notices = computed<Notice[]>(() => [
    ...(reloadPending.value ? [{ type: "reload-pending" } as const] : []),
    ...upstreamFailures.value,
  ])

  const anchors = signal<Map<NoteId, AnchorResolution>>(new Map())

  /** Notes whose lost-element panel the user collapsed; a note lost after that is not in it. */
  const lostDismissed = signal<ReadonlySet<NoteId>>(new Set())
  const lastSentNoteIds = signal<NoteId[]>([])
  /** One in-flight guard and one key for every surface that sends, so overlapping sends make one round. */
  const sending: { inFlight: boolean; key: { revision: string; key: IdempotencyKey } | null } = {
    inFlight: false,
    key: null,
  }
  const deliveredUntil = signal<number | null>(null)

  const orderedDrafts = computed(() =>
    draftOrder.value.flatMap((id) => drafts.value.find((note) => note.id === id) ?? []),
  )
  const name = computed(() => sessionName(pairing.value, pageId.value))
  const where = computed(() => (port ? `${machineName.value}:${port}` : machineName.value))
  /** Reads the clock only when its signals change; call `expireDelivered` once the window lapses. */
  const dock = computed(() => dockState(pairing.value, deliveredUntil.value, now()))
  const sendBlocked = computed(() => sendBlockedReason(pairing.value, drafts.value.length))

  let nextToastId = 1
  let undo: { note: Note; index: number } | null = null

  function pushToast(
    text: string,
    options: { tone?: ToastTone; action?: "undo"; ttlMs?: number } = {},
  ): number {
    const toast: Toast = {
      id: nextToastId++,
      text,
      tone: options.tone ?? "plain",
      action: options.action ?? null,
      leavesAt: now() + (options.ttlMs ?? TOAST_MS),
    }
    toasts.value = [...toasts.value, toast].slice(-MAX_TOASTS)
    return toast.id
  }

  function dismissToast(id: number) {
    toasts.value = toasts.value.filter((toast) => toast.id !== id)
  }

  function nextCoach(from: number) {
    if (coachStep.value === from) coachStep.value = from + 1
  }

  function endCoach() {
    batch(() => {
      coachStep.value = -1
      if (!prefs.value.coachDone) prefs.value = { ...prefs.value, coachDone: true }
    })
  }

  function closeComposer() {
    if (!composer.value) return
    composer.value = null
    if (reloadPending.value) {
      reloadPending.value = false
      reloadNow.value = true
    }
  }

  function setMode(next: Mode) {
    batch(() => {
      const previous = mode.value
      mode.value = next
      if (next !== "pick" && next !== "compose") multi.value = []
      if (next === "idle" || next === "markup") {
        hover.value = null
        climbStack.value = []
      }
      if (next !== "compose") closeComposer()
      if (next !== "markup") markup.value = null
      if (previous !== next && next !== "idle" && menu.value === "session") menu.value = "none"
      if (next === "pick") nextCoach(0)
    })
  }

  function closeSheet() {
    sheet.value = { ...sheet.value, open: false }
    focus.value = -1
  }

  /** Closes the topmost open layer and reports whether there was one. */
  function closeTopLayer(): boolean {
    if (shortcutsOpen.value) shortcutsOpen.value = false
    else if (mode.value !== "idle") setMode("idle")
    else if (menu.value === "session" || menu.value === "more") menu.value = "none"
    else if (sheet.value.open) closeSheet()
    else if (coachStep.value >= 0) endCoach()
    else return false
    return true
  }

  function openComposer(
    from: { target: NoteTarget; shot?: { shapes: Shape[] } } | { editing: NoteId },
  ) {
    batch(() => {
      if ("editing" in from) {
        const note = drafts.value.find((draft) => draft.id === from.editing)
        if (!note) return
        setMode("compose")
        composer.value = {
          target: note.target,
          shot: null,
          intent: note.intent,
          body: note.body,
          editing: note.id,
          anchorStatus: note.anchorStatus,
          saving: false,
          bodyError: false,
          enrichment: "done",
          capture: note.capture,
        }
        return
      }
      const shot = from.shot ?? null
      setMode("compose")
      composer.value = {
        target: from.target,
        shot,
        intent: from.target.kind === "region" && !shot ? "change" : "fix",
        body: "",
        editing: null,
        anchorStatus: "anchored",
        saving: false,
        bodyError: false,
        enrichment: "running",
        capture: undefined,
      }
    })
  }

  function setIntent(intent: Intent) {
    if (composer.value) composer.value = { ...composer.value, intent }
  }

  function setBody(body: string) {
    if (composer.value) composer.value = { ...composer.value, body, bodyError: false }
  }

  function enrichmentDone(capture: Capture) {
    if (composer.value && !composer.value.editing)
      composer.value = { ...composer.value, enrichment: "done", capture }
  }

  /** Returns the body to save and marks the composer saving, or flags the empty-body error. */
  function beginSave(): DraftBody | null {
    const current = composer.value
    if (!current || current.saving) return null
    const text = current.body.trim()
    if (text === "" && current.intent !== "keep") {
      composer.value = { ...current, bodyError: true }
      return null
    }
    composer.value = { ...current, saving: true }
    return toDraftBody(
      {
        intent: current.intent,
        body: text === "" ? KEEP_BODY : text,
        target: current.target,
        anchorStatus: current.anchorStatus,
      },
      current.capture,
    )
  }

  function saveFailed() {
    if (composer.value) composer.value = { ...composer.value, saving: false }
  }

  function noteSaved(note: Note) {
    batch(() => {
      const index = draftOrder.value.indexOf(note.id)
      if (index >= 0) {
        drafts.value = drafts.value.map((draft) => (draft.id === note.id ? note : draft))
        pushToast(`Note ${index + 1} updated`, { tone: "ok" })
      } else {
        drafts.value = [...drafts.value, note]
        draftOrder.value = [...draftOrder.value, note.id]
        lastSentNoteIds.value = []
        deliveredUntil.value = null
        if (drafts.value.length === 1 || coachStep.value === 0) nextCoach(1)
      }
      if (composer.value?.saving) setMode("idle")
    })
  }

  function noteUpdated(note: Note) {
    if (drafts.value.some((draft) => draft.id === note.id))
      drafts.value = drafts.value.map((draft) => (draft.id === note.id ? note : draft))
  }

  function noteDeleted(id: NoteId) {
    const index = draftOrder.value.indexOf(id)
    const note = drafts.value.find((draft) => draft.id === id)
    if (index < 0 || !note) return
    batch(() => {
      drafts.value = drafts.value.filter((draft) => draft.id !== id)
      draftOrder.value = draftOrder.value.filter((noteId) => noteId !== id)
      undo = { note, index }
      if (focus.value >= draftOrder.value.length) focus.value = draftOrder.value.length - 1
      pushToast(`Note ${index + 1} deleted`, { action: "undo", ttlMs: UNDO_TOAST_MS })
    })
  }

  /** Hands back the last deleted note once; the shell recreates it and calls `noteRestored`. */
  function takeUndo(): { note: Note; index: number } | null {
    const taken = undo
    undo = null
    return taken
  }

  function noteRestored(note: Note, index: number) {
    batch(() => {
      drafts.value = [...drafts.value, note]
      const order = [...draftOrder.value]
      order.splice(Math.min(Math.max(index, 0), order.length), 0, note.id)
      draftOrder.value = order
    })
  }

  function moveNote(from: number, to: number) {
    const order = [...draftOrder.value]
    if (from === to || to < 0 || to >= order.length || from < 0 || from >= order.length) return
    const [moved] = order.splice(from, 1)
    if (moved === undefined) return
    order.splice(to, 0, moved)
    batch(() => {
      draftOrder.value = order
      if (focus.value === from) focus.value = to
    })
  }

  function focusAt(index: number) {
    const count = draftOrder.value.length
    if (count === 0) return
    focus.value = Math.min(Math.max(index, 0), count - 1)
  }

  function focusNext() {
    focusAt(focus.value + 1)
  }

  function focusPrev() {
    focusAt(focus.value < 0 ? 0 : focus.value - 1)
  }

  function toggleSheet(tab?: SheetTab) {
    const current = sheet.value
    if (current.open && (tab === undefined || tab === current.tab)) closeSheet()
    else sheet.value = { open: true, tab: tab ?? current.tab }
  }

  function setPrefs(patch: Partial<OverlayPrefs>) {
    prefs.value = { ...prefs.value, ...patch }
  }

  function setShortcutsOpen(open: boolean) {
    batch(() => {
      shortcutsOpen.value = open
      if (open && coachStep.value === 2) endCoach()
    })
  }

  function setAnchor(id: NoteId, resolution: AnchorResolution) {
    anchors.value = new Map(anchors.value).set(id, resolution)
  }

  function dismissUpstreamFailure(failurePort: number) {
    upstreamFailures.value = upstreamFailures.value.filter(
      (failure) => failure.port !== failurePort,
    )
  }

  function expireDelivered() {
    if (deliveredUntil.value !== null && now() >= deliveredUntil.value) deliveredUntil.value = null
  }

  function dropDrafts(ids: readonly NoteId[]) {
    const sent = new Set(ids)
    drafts.value = drafts.value.filter((draft) => !sent.has(draft.id))
    draftOrder.value = draftOrder.value.filter((id) => !sent.has(id))
  }

  function beginLoad(which: "newest" | "older"): MessageQuery | null {
    const current = conversation.value
    if (which === "newest") {
      if (current.status !== "unloaded" && current.status !== "failed") return null
      conversation.value = { status: "loading" }
      return {}
    }
    const oldest = messages.value[0]
    if (current.status !== "ready" || !current.hasOlder || current.olderLoading || !oldest)
      return null
    conversation.value = { ...current, olderLoading: true }
    return { before: oldest.id }
  }

  function applyMessagePage(which: "newest" | "older", page: MessagePage): void {
    batch(() => {
      messages.value = mergeMessages(messages.value, page.messages)
      pendingMessages.value = settlePending(pendingMessages.value, messages.value)
      const current = conversation.value
      if (which === "newest" || current.status === "ready")
        conversation.value = { status: "ready", hasOlder: page.hasOlder, olderLoading: false }
    })
  }

  function loadFailed(which: "newest" | "older"): void {
    const current = conversation.value
    if (which === "newest") conversation.value = { status: "failed" }
    else if (current.status === "ready") conversation.value = { ...current, olderLoading: false }
  }

  function beginChatLoad(): number | null {
    if (chat.value !== null || chatLoading === chatEpoch) return null
    chatLoading = chatEpoch
    return chatEpoch
  }

  function applyFetchedChat(ticket: number, setting: ChatSetting): void {
    if (ticket !== chatEpoch) return
    chatLoading = null
    chat.value = setting
  }

  function chatLoadFailed(ticket: number): void {
    if (chatLoading === ticket) chatLoading = null
  }

  function setChatSetting(setting: ChatSetting): void {
    chatEpoch++
    chatLoading = null
    chat.value = setting
  }

  function beginPost(text: string): PostMessageRequest | null {
    const trimmed = text.trim()
    const current = pairing.value
    if (
      trimmed === "" ||
      trimmed.length > MESSAGE_MAX_CHARS ||
      chatBlocked.value !== null ||
      !current
    )
      return null
    const key = IdempotencyKey.parse(crypto.randomUUID())
    batch(() => {
      pendingMessages.value = [
        ...pendingMessages.value,
        { key, text: trimmed, at: new Date(now()).toISOString(), status: "sending" },
      ]
      chatDraft.value = ""
    })
    return { idempotencyKey: key, generation: current.generation, text: trimmed }
  }

  function failPost(key: IdempotencyKey, reason: PostFailure): void {
    pendingMessages.value = pendingMessages.value.map((message) =>
      message.key === key ? { ...message, status: "failed", reason } : message,
    )
  }

  function applyPostResult(key: IdempotencyKey, result: PostMessageResult): void {
    batch(() => {
      if (result.outcome === "accepted") {
        messages.value = mergeMessages(messages.value, [result.message])
        pendingMessages.value = settlePending(pendingMessages.value, messages.value)
        return
      }
      failPost(key, result.reason)
      setChatSetting(result.chat)
      pairing.value = result.pairing
      if (result.reason === "chat-off" || result.reason === "unreachable") return
      pushToast(
        {
          "session-gone": `${name.value} ended — attach this page to a session to send`,
          "stale-generation":
            "This page is now attached to another session — check it and send again",
          "no-pairing": "This page isn't attached to a session — attach it to send",
        }[result.reason],
        { tone: "failed" },
      )
    })
  }

  function postFailed(key: IdempotencyKey, reason: "unreachable-service" | "invalid"): void {
    failPost(key, reason)
  }

  function retryPost(key: IdempotencyKey): PostMessageRequest | null {
    const current = pairing.value
    const held = pendingMessages.value.find((message) => message.key === key)
    if (!current || chatBlocked.value !== null || held?.status !== "failed") return null
    pendingMessages.value = pendingMessages.value.map((message) =>
      message.key === key ? { key, text: held.text, at: held.at, status: "sending" } : message,
    )
    return { idempotencyKey: key, generation: current.generation, text: held.text }
  }

  function discardPending(key: IdempotencyKey): void {
    pendingMessages.value = pendingMessages.value.filter((message) => message.key !== key)
  }

  function applySendNowResult(result: SendNowResult): void {
    batch(() => {
      rounds.value = applyRound(rounds.value, result.round)
      if (result.outcome === "accepted") {
        pushToast(
          `${roundLabel(result.round.id)} sent now · reaches ${name.value} after its current step`,
          { tone: "ok" },
        )
        return
      }
      pushToast(
        {
          "not-waiting": `${roundLabel(result.round.id)} was already handed to the session`,
          "session-gone": `${name.value} ended — attach this page to a session to send`,
          "no-pairing": "This page isn't attached to a session — attach it to send",
        }[result.reason],
        { tone: "failed" },
      )
    })
  }

  function applyServerMessage(message: ServerMessage) {
    batch(() => {
      switch (message.type) {
        case "message":
          messages.value = mergeMessages(messages.value, [message.message])
          pendingMessages.value = settlePending(pendingMessages.value, messages.value)
          return
        case "chat":
          setChatSetting(message.chat)
          return
        case "pairing":
          pairing.value = message.pairing
          return
        case "round": {
          const before = rounds.value.find((round) => round.id === message.round.id)
          rounds.value = applyRound(rounds.value, message.round)
          const after = rounds.value.find((round) => round.id === message.round.id)
          if (before?.state.stage !== "orphaned" && after?.state.stage === "orphaned")
            pushToast(
              `${roundLabel(after.id)} not delivered — ${name.value} ended before picking this up`,
              { tone: "failed" },
            )
          if (after === message.round) dropDrafts(after.notes.map((note) => note.id))
          return
        }
        case "agent-note": {
          const exists = agentNotes.value.some((note) => note.id === message.note.id)
          agentNotes.value = exists
            ? agentNotes.value.map((note) => (note.id === message.note.id ? message.note : note))
            : [...agentNotes.value, message.note]
          return
        }
        case "agent-note-removed":
          agentNotes.value = agentNotes.value.filter((note) => note.id !== message.noteId)
          return
        case "reload":
          if (composer.value && composer.value.body !== "") reloadPending.value = true
          else reloadNow.value = true
          return
        case "upstream-failure":
          upstreamFailures.value = [
            ...upstreamFailures.value.filter((failure) => failure.port !== message.port),
            message,
          ]
          return
        case "draining":
          connection.value = { status: "draining" }
          return
      }
    })
  }

  function applySendResult(result: SendResult) {
    batch(() => {
      if (result.outcome === "refused") {
        pairing.value = result.pairing
        const who = name.value
        pushToast(
          {
            "session-gone": `${who} ended — attach this page to a session to send`,
            "stale-generation": `This page is now attached to another session — check it and send again`,
            "no-pairing": `This page isn't attached to a session — attach it to send`,
          }[result.reason],
          { tone: "failed" },
        )
        return
      }
      const { round } = result
      rounds.value = applyRound(rounds.value, round)
      const sent = round.notes.map((note) => note.id)
      dropDrafts(sent)
      lastSentNoteIds.value = sent
      focus.value = -1
      sheet.value = { ...sheet.value, tab: "history" }
      const current = pairing.value
      if (current?.state.status === "busy")
        pushToast(`${roundLabel(round.id)} queued · delivers when ${name.value}’s turn ends`, {
          tone: "amber",
        })
      else if (current?.listener === "none")
        pushToast(`${roundLabel(round.id)} queued until your next prompt in ${name.value}`, {
          tone: "amber",
        })
      else {
        deliveredUntil.value = now() + DELIVERED_MS
        pushToast(`${roundLabel(round.id)} delivered to ${name.value}`, { tone: "ok" })
      }
    })
  }

  function applyAttachResult(result: AttachResult) {
    batch(() => {
      if (result.outcome === "refused") {
        liveSessions.value = result.sessions
        pushToast(
          {
            "not-live": "That session isn't live any more — pick another",
            "unknown-owner": "iter8 no longer knows that session — pick another",
          }[result.reason],
          { tone: "failed" },
        )
        return
      }
      pairing.value = result.pairing
      const requeued = result.requeued.length
        ? ` · requeued ${result.requeued.map(roundLabel).join(", ")}`
        : ""
      pushToast(`Attached to ${name.value} · ${where.value}${requeued}`, { tone: "ok" })
    })
  }

  /** Adopts a fresh handshake after a reconnect, keeping the local order of drafts that survive. */
  function applyHello(next: AcceptedHello) {
    batch(() => {
      chatEpoch++
      chatLoading = null
      chat.value = null
      if (conversation.value.status !== "unloaded") {
        messages.value = []
        conversation.value = { status: "unloaded" }
      }
      const ids = new Set(next.state.drafts.map((note) => note.id))
      const kept = draftOrder.value.filter((id) => ids.has(id))
      const known = new Set(kept)
      draftOrder.value = [
        ...kept,
        ...next.state.drafts.map((note) => note.id).filter((id) => !known.has(id)),
      ]
      drafts.value = next.state.drafts
      rounds.value = next.state.rounds
      agentNotes.value = next.state.agentNotes
      pairing.value = next.state.pairing
      liveSessions.value = next.state.liveSessions
      prefs.value = next.state.prefs
      machineName.value = next.machineName
      serviceVersion.value = next.serviceVersion
      connection.value = { status: "ready" }
    })
  }

  return {
    mode,
    connection,
    pairing,
    liveSessions,
    machineName,
    serviceVersion,
    pageId,
    drafts,
    draftOrder,
    rounds,
    agentNotes,
    messages,
    conversation,
    pendingMessages,
    chat,
    chatDraft,
    chatBlocked,
    beginLoad,
    applyMessagePage,
    loadFailed,
    beginChatLoad,
    applyFetchedChat,
    chatLoadFailed,
    setChatSetting,
    beginPost,
    applyPostResult,
    postFailed,
    retryPost,
    discardPending,
    applySendNowResult,
    hover,
    climbStack,
    multi,
    composer,
    markup,
    focus,
    sheet,
    menu,
    prefs,
    coachStep,
    paletteOpen,
    shortcutsOpen,
    peek,
    toasts,
    notices,
    reloadPending,
    reloadNow,
    upstreamFailures,
    anchors,
    lostDismissed,
    lastSentNoteIds,
    sending,
    deliveredUntil,
    orderedDrafts,
    name,
    where,
    dock,
    sendBlocked,
    setMode,
    escape: closeTopLayer,
    openComposer,
    setIntent,
    setBody,
    enrichmentDone,
    beginSave,
    saveFailed,
    noteSaved,
    noteUpdated,
    noteDeleted,
    takeUndo,
    noteRestored,
    moveNote,
    focusNext,
    focusPrev,
    toggleSheet,
    setPrefs,
    setShortcutsOpen,
    nextCoach,
    endCoach,
    pushToast,
    dismissToast,
    setAnchor,
    dismissUpstreamFailure,
    expireDelivered,
    applyServerMessage,
    applySendResult,
    applyAttachResult,
    applyHello,
  }
}

export type OverlayModel = ReturnType<typeof createOverlayModel>
