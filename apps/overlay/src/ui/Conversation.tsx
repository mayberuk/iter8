import {
  type ConversationMessage,
  type IdempotencyKey,
  MESSAGE_MAX_CHARS,
  type MessageDelivery,
  type MessageId,
  type MessagePage,
  type PostMessageRequest,
  type RoundId,
} from "@iter8/protocol"
import { type Signal, signal } from "@preact/signals"
import { Fragment, type RefObject } from "preact"
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks"
import { authorIdentity, groupRuns, type PendingMessage, type PostFailure } from "../conversation"
import { roundDisplayState } from "../model"
import { useOverlay, useSheet } from "./context"
import conversationCss from "./conversation.css" with { type: "text" }
import { SessionRows } from "./Dock"
import { Avatar, Icon, StatusGlyph, StatusRing } from "./glyphs"
import { Markdown } from "./Markdown"

type Overlay = Pick<ReturnType<typeof useOverlay>, "model" | "connection">

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

const STICK_PX = 24

const FROM_PAGE = "You, from this page"

const COPIED_MS = 1400

const MAX_STAGGER = 6

function clock(iso: string): string {
  return TIME.format(new Date(iso))
}

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ")
}

type Delivery = "sending" | "queued" | "delivered" | "failed"

type Who =
  | { kind: "agent"; agent: string; name: string }
  | { kind: "user" }
  | { kind: "page"; state: Delivery; words: string; retry: IdempotencyKey | null }

type Entry = {
  key: string
  id: MessageId | null
  roundId: RoundId | null
  at: string
  text: string
  identity: string
  who: Who
}

function authorLabel(who: Who): string {
  switch (who.kind) {
    case "agent":
      return `${who.agent === "claude" ? "Claude" : who.agent} · ${who.name}`
    case "user":
      return "You, in the terminal"
    case "page":
      return FROM_PAGE
  }
}

function deliveryWords(delivery: MessageDelivery, name: string): string {
  switch (delivery.status) {
    case "queued":
      return `Waiting for ${name} to take it`
    case "delivered":
      return `Taken by ${name}`
    case "failed":
      return `Not delivered — ${name} ended before taking it`
  }
}

function failureWords(reason: PostFailure, name: string): string {
  switch (reason) {
    case "no-pairing":
      return "this page isn't attached to a session"
    case "stale-generation":
      return "this page is now attached to another session"
    case "session-gone":
      return `${name} ended`
    case "chat-off":
      return "chat is off for this page"
    case "unreachable":
      return `${name} can't take page messages right now`
    case "unreachable-service":
      return "iter8 isn't reachable"
    case "invalid":
      return "the message couldn't be sent as written"
  }
}

function messageEntry(message: ConversationMessage, name: string): Entry {
  const { author } = message
  const shared = {
    id: message.id,
    roundId: message.roundId,
    at: message.at,
    text: message.text,
    identity: authorIdentity(author),
  }
  switch (author.kind) {
    case "agent":
      return {
        ...shared,
        key: message.id,
        who: { kind: "agent", agent: author.agent, name },
      }
    case "user":
      return { ...shared, key: message.id, who: { kind: "user" } }
    case "page":
      return {
        ...shared,
        key: author.idempotencyKey,
        who: {
          kind: "page",
          state: author.delivery.status,
          words: deliveryWords(author.delivery, name),
          retry: null,
        },
      }
  }
}

function pendingEntry(entry: PendingMessage, name: string): Entry {
  const shared = {
    key: entry.key,
    id: null,
    roundId: null,
    at: entry.at,
    text: entry.text,
    identity: "page",
  }
  return entry.status === "sending"
    ? { ...shared, who: { kind: "page", state: "sending", words: "Sending…", retry: null } }
    : {
        ...shared,
        who: {
          kind: "page",
          state: "failed",
          words: `Not sent — ${failureWords(entry.reason, name)}`,
          retry: entry.key,
        },
      }
}

/** A sent message is one row from sending to delivered: its pending entry and its stored message share the idempotency key. */
function entriesOf(
  messages: readonly ConversationMessage[],
  pending: readonly PendingMessage[],
  name: string,
): Entry[] {
  const stored = messages.map((message) => messageEntry(message, name))
  const held = new Set(stored.map((entry) => entry.key))
  return [
    ...stored,
    ...pending.filter((entry) => !held.has(entry.key)).map((entry) => pendingEntry(entry, name)),
  ]
}

const overBy = (text: string) => Math.max(0, text.trim().length - MESSAGE_MAX_CHARS)

async function post({ model, connection }: Overlay, request: PostMessageRequest | null) {
  if (!request) return
  const key = request.idempotencyKey
  let result: Awaited<ReturnType<typeof connection.postMessage>>
  try {
    result = await connection.postMessage(request)
  } catch (error) {
    const invalid = error instanceof Error && error.message.includes("status 0: invalid request")
    model.postFailed(key, invalid ? "invalid" : "unreachable-service")
    return
  }
  model.applyPostResult(key, result)
}

async function loadPage(
  { model, connection }: Overlay,
  which: "newest" | "older",
  beforeApply: () => void,
) {
  const query = model.beginLoad(which)
  if (!query) return
  let page: MessagePage
  try {
    page = await connection.listMessages(query)
  } catch {
    model.loadFailed(which)
    if (which === "older")
      model.pushToast("Couldn't load earlier messages — try again", { tone: "failed" })
    return
  }
  beforeApply()
  model.applyMessagePage(which, page)
}

function checkChat({ model, connection }: Overlay, setFailed: (failed: boolean) => void) {
  const ticket = model.beginChatLoad()
  if (ticket === null) return
  setFailed(false)
  connection.getChat().then(
    (setting) => model.applyFetchedChat(ticket, setting),
    () => {
      model.chatLoadFailed(ticket)
      setFailed(true)
    },
  )
}

type Hold = { row: Element; top: number; scrollTop: number }

function topRow(list: HTMLElement): Hold | null {
  const edge = list.getBoundingClientRect().top
  for (const row of list.querySelectorAll("article")) {
    const box = row.getBoundingClientRect()
    if (box.bottom > edge) return { row, top: box.top - edge, scrollTop: list.scrollTop }
  }
  return null
}

function restore(list: HTMLElement, held: Hold) {
  const shift = held.row.getBoundingClientRect().top - list.getBoundingClientRect().top - held.top
  if (shift === 0) return
  list.scrollTop += shift
  held.scrollTop = list.scrollTop
}

function keepPlace(list: HTMLElement, held: Hold | null, anchor: Hold | null, stick: boolean) {
  if (held?.row.isConnected) restore(list, held)
  else if (stick) list.scrollTop = list.scrollHeight
  // Only from the offset it was taken at: a scroll whose event has not fired yet is never undone.
  else if (anchor?.row.isConnected && anchor.scrollTop === list.scrollTop) restore(list, anchor)
}

const SCROLL_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const

function CopyButton({ text }: { text: string }) {
  const { model } = useOverlay()
  const [done, setDone] = useState(false)

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [done])

  function copy() {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setDone(true),
        () => model.pushToast("Couldn't copy", { tone: "failed" }),
      )
  }

  return (
    <button
      type="button"
      class={cls("cv-copy", done && "done")}
      aria-label="Copy message"
      onClick={copy}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  )
}

type RowProps = {
  entry: Entry
  head: boolean
  last: boolean
  enter: number | null
  blocked: boolean
}

function MessageRow({ entry, head, last, enter, blocked }: RowProps) {
  const overlay = useOverlay()
  const { who } = entry
  const label = authorLabel(who)
  const time = clock(entry.at)
  const state = who.kind === "page" ? who.state : null
  const was = useRef(state)
  const fresh = useRef(false)
  if (was.current !== state) {
    if ((was.current === "sending" || was.current === "queued") && state === "delivered") {
      fresh.current = true
    }
    was.current = state
  }
  const agent = who.kind === "agent"
  const retry = who.kind === "page" ? who.retry : null
  return (
    <article
      class={cls(
        "cv-msg",
        who.kind,
        agent ? who.agent === "claude" && "claude" : "mine",
        state,
        head && "head",
        last && "last",
        enter !== null && "enter",
        fresh.current && "fresh",
      )}
      style={enter !== null ? { "--i": enter } : undefined}
      aria-label={`${label}, ${time}`}
    >
      {head && who.kind === "agent" ? (
        <header class="cv-meta">
          <Avatar agent={who.agent} size={18} />
          <b class="cv-who">{who.agent === "claude" ? "Claude" : who.agent}</b>
          <span class="cv-sess">{who.name}</span>
          <time dateTime={entry.at}>{time}</time>
        </header>
      ) : (
        <span class="cv-sr">{label}</span>
      )}
      <div class={agent ? "cv-prose" : "cv-bubble"}>
        {agent ? <Markdown text={entry.text} /> : <p class="cv-text">{entry.text}</p>}
        <div class="cv-tools">
          {agent && !head ? <time dateTime={entry.at}>{time}</time> : null}
          <CopyButton text={entry.text} />
        </div>
      </div>
      {who.kind !== "agent" ? (
        <div class="cv-foot">
          <time dateTime={entry.at}>{time}</time>
          {who.kind === "page" && state ? (
            <p class={`cv-state ${state}`}>
              <span class="cv-words">{who.words}</span>
              {state === "sending" ? <Icon name="send" size={15} /> : <StatusGlyph state={state} />}
            </p>
          ) : null}
          {who.kind === "user" ? (
            <p class="cv-state user">
              <span class="cv-words">From the terminal</span>
              <Icon name="term" size={13} />
            </p>
          ) : null}
        </div>
      ) : null}
      {retry !== null ? (
        <div class="cv-acts">
          <button
            type="button"
            class="btn ghost"
            disabled={blocked}
            onClick={() => void post(overlay, overlay.model.retryPost(retry))}
          >
            Retry
          </button>
          <button
            type="button"
            class="btn ghost"
            onClick={() => overlay.model.discardPending(retry)}
          >
            Discard
          </button>
        </div>
      ) : null}
    </article>
  )
}

function RoundDivider(props: {
  roundId: RoundId
  final: boolean
  enter: boolean
  open: (id: RoundId) => void
}) {
  const { model } = useOverlay()
  const round = model.rounds.value.find((held) => held.id === props.roundId)
  const state = round ? roundDisplayState(round) : null
  const live = props.final && (state === "queued" || state === "delivered" || state === "working")
  const number = props.roundId.slice(1)
  return (
    <button
      type="button"
      class={cls("cv-round", state, live && "live", props.enter && "enter")}
      aria-label={state ? `Round ${number}, ${state}` : `Round ${number}`}
      onClick={() => props.open(props.roundId)}
    >
      <span class="rn">
        {state ? <StatusGlyph state={state} /> : null}
        Round {number}
        <Icon name="right" size={12} />
      </span>
    </button>
  )
}

type View = { stuck: Signal<boolean>; unread: Signal<number>; firstUnread: Signal<string | null> }

function JumpPill({ view, list }: { view: View; list: RefObject<HTMLDivElement | null> }) {
  if (view.stuck.value) return null
  const unread = view.unread.value
  const plural = unread === 1 ? "" : "s"
  return (
    <button
      type="button"
      class={cls("cv-jump", unread > 0 && "fresh")}
      aria-label={unread > 0 ? `${unread} new message${plural}, jump to latest` : "Jump to latest"}
      onClick={() => {
        const el = list.current
        if (!el) return
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
        el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" })
      }}
    >
      <Icon name="down" size={14} />
      {unread > 0 ? (
        <>
          <span class="ct" key={unread}>
            {unread}
          </span>
          new message{plural}
        </>
      ) : (
        "Jump to latest"
      )}
    </button>
  )
}

function Empty({ name }: { name: string }) {
  return (
    <div class="cv-empty">
      <div class="cv-ghosts" aria-hidden="true">
        <div class="gh" style={{ "--i": 0, width: "78%" }}>
          <i style={{ width: "40%" }} />
          <i style={{ width: "92%" }} />
          <i style={{ width: "64%" }} />
        </div>
        <div class="gh mine" style={{ "--i": 1, width: "56%" }}>
          <i style={{ width: "88%" }} />
          <i style={{ width: "46%" }} />
        </div>
      </div>
      <div class="cv-empty-tile">
        <StatusGlyph state="queued" />
      </div>
      <h3>No messages yet</h3>
      <p>Finished messages from {name} show here.</p>
      <p class="cv-hint">
        <kbd>Enter</kbd> sends, <kbd>Shift</kbd>
        <kbd>Enter</kbd> adds a line
      </p>
    </div>
  )
}

function Working({ agent }: { agent: string }) {
  return (
    <div class="cv-work" aria-hidden="true">
      <div class="cv-meta">
        <Avatar agent={agent} size={18} />
        <b class="cv-who">{agent === "claude" ? "Claude" : agent}</b>
        <span class="cv-sess">writing</span>
      </div>
      <div class="cv-bars">
        <i />
        <i />
        <i />
      </div>
    </div>
  )
}

function MessageList() {
  const { model, connection, root } = useOverlay()
  const messages = model.messages.value
  const pending = model.pendingMessages.value
  const load = model.conversation.value
  const blocked = model.chatBlocked.value !== null
  const name = model.name.value
  const pairing = model.pairing.value
  const busyPairing = pairing?.state.status === "busy" ? pairing : null
  const list = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const lastTop = useRef(0)
  const hold = useRef<Hold | null>(null)
  const anchor = useRef<Hold | null>(null)
  const unloaded = load.status === "unloaded"
  const view = useMemo<View>(
    () => ({ stuck: signal(true), unread: signal(0), firstUnread: signal<string | null>(null) }),
    [],
  )
  const staggers = useRef(new Map<string, number | null>())
  const frontier = useRef<bigint | null>(null)
  const counted = useRef(new Set<string>())

  const entries = useMemo(() => entriesOf(messages, pending, name), [messages, pending, name])
  const runs = useMemo(
    () => groupRuns(entries.map(({ identity, roundId, at }) => ({ identity, roundId, at }))),
    [entries],
  )

  // A message from the agent ends the draft the placeholder stands for.
  const lastAgent = entries.findLast((entry) => entry.who.kind === "agent")?.key ?? null
  const draftAfter = useRef<string | null | undefined>(undefined)
  if (!busyPairing || load.status !== "ready") draftAfter.current = undefined
  else if (draftAfter.current === undefined) draftAfter.current = lastAgent
  const forming =
    busyPairing !== null && load.status === "ready" && draftAfter.current === lastAgent

  // Read before this render commits: a scroll in the same task as a push has no scroll event yet.
  // Only a scroll upward leaves the bottom: a row that grows under the pin moves the gap too.
  // Sampling lastTop here keeps a clamp from a shrinking row from reading as a scroll up once the
  // container resizes before the clamp's scroll event.
  const shown = list.current
  if (shown) {
    const near = shown.scrollHeight - shown.scrollTop - shown.clientHeight <= STICK_PX
    stick.current = near || (stick.current && shown.scrollTop >= lastTop.current)
    lastTop.current = shown.scrollTop
  }

  // A row enters with motion only when it arrives after the first page: the first page and any
  // earlier page are already history.
  if (load.status !== "ready") {
    frontier.current = null
    staggers.current.clear()
    counted.current.clear()
  } else if (frontier.current === null) {
    frontier.current = messages.reduce((top, { id }) => {
      const value = BigInt(id.slice(1))
      return value > top ? value : top
    }, 0n)
    for (const entry of entries) staggers.current.set(entry.key, null)
  } else {
    let batch = 0
    for (const entry of entries) {
      if (staggers.current.has(entry.key)) continue
      const old = entry.id !== null && BigInt(entry.id.slice(1)) <= frontier.current
      staggers.current.set(entry.key, old ? null : Math.min(batch++, MAX_STAGGER))
    }
  }

  function holdTopRow() {
    const el = list.current
    if (el) hold.current = topRow(el)
  }

  useEffect(() => {
    void loadPage({ model, connection }, "newest", () => {})
  }, [model, connection])

  useEffect(() => {
    if (unloaded) void loadPage({ model, connection }, "newest", () => {})
  }, [unloaded, model, connection])

  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    if (model.conversation.peek().status === "loading") {
      stick.current = true
      hold.current = null
    }
    keepPlace(el, hold.current, anchor.current, stick.current)
    for (const entry of entries) {
      if (staggers.current.get(entry.key) == null || counted.current.has(entry.key)) continue
      counted.current.add(entry.key)
      if (stick.current || entry.who.kind !== "agent") continue
      view.unread.value = view.unread.peek() + 1
      if (view.firstUnread.peek() === null) view.firstUnread.value = entry.key
    }
    if (stick.current) {
      view.unread.value = 0
      view.firstUnread.value = null
    }
  })

  // `content-visibility: auto` rows take their real height over several frames, each correction
  // bringing more into range; so the place is re-held on every resize.
  useEffect(() => {
    const el = list.current
    const content = body.current
    if (!el || !content) return
    const observer = new ResizeObserver(() =>
      keepPlace(el, hold.current, anchor.current, stick.current),
    )
    const release = () => {
      hold.current = null
    }
    observer.observe(el)
    observer.observe(content)
    for (const type of SCROLL_INPUT) el.addEventListener(type, release, { passive: true })
    return () => {
      observer.disconnect()
      for (const type of SCROLL_INPUT) el.removeEventListener(type, release)
    }
  }, [])

  function showRound(id: RoundId) {
    model.sheet.value = { ...model.sheet.value, tab: "history" }
    model.focus.value = -1
    requestAnimationFrame(() =>
      root.getElementById(`round-${id}`)?.scrollIntoView({ block: "start" }),
    )
  }

  const loading = load.status === "loading" || (load.status === "ready" && load.olderLoading)
  const firstUnread = view.firstUnread.value
  const finalDivider = entries.findLastIndex(
    (entry, index) => entry.roundId !== null && entry.roundId !== entries[index - 1]?.roundId,
  )

  return (
    <div class="cv-stage">
      <div
        class="cv-list"
        role="log"
        aria-label="Messages"
        ref={list}
        onScroll={(event) => {
          const el = event.currentTarget
          const near = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
          stick.current = near || (stick.current && el.scrollTop >= lastTop.current)
          lastTop.current = el.scrollTop
          anchor.current = stick.current ? null : topRow(el)
          view.stuck.value = stick.current
          if (stick.current) {
            view.unread.value = 0
            view.firstUnread.value = null
          }
        }}
      >
        <div class="cv-body" ref={body}>
          {load.status === "ready" && load.hasOlder && !load.olderLoading ? (
            <div class="cv-top">
              <button
                type="button"
                class="cv-more"
                onClick={() => void loadPage({ model, connection }, "older", holdTopRow)}
              >
                <Icon name="up" size={14} />
                Show earlier messages
              </button>
            </div>
          ) : null}
          {loading ? (
            <div class="cv-top">
              <StatusRing state="checking" agent={pairing?.agent} size={16} />
              Loading…
            </div>
          ) : null}
          {load.status === "failed" ? (
            <div class="cv-top">
              <span>Couldn't load messages</span>
              <button
                type="button"
                class="cv-link"
                onClick={() => void loadPage({ model, connection }, "newest", () => {})}
              >
                Retry
              </button>
            </div>
          ) : null}
          {load.status === "ready" && entries.length === 0 ? <Empty name={name} /> : null}
          {entries.map((entry, index) => {
            const enter = staggers.current.get(entry.key) ?? null
            const run = runs[index]
            return (
              <Fragment key={entry.key}>
                {entry.roundId !== null && entry.roundId !== entries[index - 1]?.roundId ? (
                  <RoundDivider
                    roundId={entry.roundId}
                    final={index === finalDivider}
                    enter={enter !== null}
                    open={showRound}
                  />
                ) : null}
                {entry.key === firstUnread ? (
                  // biome-ignore lint/a11y/useSemanticElements: an hr cannot carry the "New" label
                  <div class="cv-newline enter" role="separator">
                    <span>New</span>
                  </div>
                ) : null}
                <MessageRow
                  entry={entry}
                  head={run?.head ?? true}
                  last={run?.last ?? true}
                  enter={enter}
                  blocked={blocked}
                />
              </Fragment>
            )
          })}
          {forming ? <Working agent={busyPairing.agent} /> : null}
        </div>
      </div>
      <div class="cv-sr" role="status">
        {busyPairing ? `${name} is working` : ""}
      </div>
      <JumpPill view={view} list={list} />
    </div>
  )
}

function AttachBox(props: { heading: string; hint: string }) {
  const { model, connection } = useOverlay()
  const owner = model.pairing.value?.owner
  const sessions = model.liveSessions.value.filter(
    (session) => session.state.status !== "gone" && session.owner !== owner,
  )

  useEffect(() => {
    let live = true
    connection
      .listSessions()
      .then((fresh) => {
        if (live) model.liveSessions.value = fresh
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [connection, model])

  return (
    <div class="gonebox">
      <h4>{props.heading}</h4>
      <p>{props.hint}</p>
      {sessions.length ? (
        <SessionRows sessions={sessions} current={null} />
      ) : (
        <p>No other session is running on {model.machineName.value}</p>
      )}
    </div>
  )
}

function ChatInput({ name, focus }: { name: string; focus: { current: boolean } }) {
  const overlay = useOverlay()
  const { model } = overlay
  const field = useRef<HTMLTextAreaElement>(null)
  const [over, setOver] = useState(0)
  const [empty, setEmpty] = useState(true)

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.value = model.chatDraft.peek()
    setOver(overBy(el.value))
    setEmpty(el.value.trim() === "")
    if (focus.current) {
      focus.current = false
      if (!model.paletteOpen.peek()) el.focus()
    }
  }, [model, focus])

  function send() {
    const el = field.current
    if (!el || over > 0) return
    const request = model.beginPost(el.value)
    if (!request) return
    el.value = ""
    setEmpty(true)
    void post(overlay, request)
  }

  return (
    <div class="cv-compose">
      <div class={cls("cv-field", over > 0 && "over")}>
        <textarea
          ref={field}
          rows={1}
          aria-label={`Message ${name}`}
          placeholder={`Message ${name}`}
          onInput={(event) => {
            const text = event.currentTarget.value
            model.chatDraft.value = text
            setOver(overBy(text))
            setEmpty(text.trim() === "")
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
            event.preventDefault()
            send()
          }}
        />
        <button
          type="button"
          class={cls("send", empty ? "idle" : "armed")}
          aria-label="Send message"
          title="Send · Enter"
          disabled={over > 0}
          onClick={send}
        >
          <Icon name="send" size={15} />
        </button>
      </div>
      {over > 0 ? (
        <p class="cv-over">
          {over} character{over === 1 ? "" : "s"} over the limit
        </p>
      ) : null}
    </div>
  )
}

function ChatBox() {
  const overlay = useOverlay()
  const { model, connection } = overlay
  const blocked = model.chatBlocked.value
  const chat = model.chat.value
  const name = model.name.value
  const [checkFailed, setCheckFailed] = useState(false)
  const focusInput = useRef(true)
  const unknown = chat === null

  useEffect(() => {
    if (unknown) checkChat({ model, connection }, setCheckFailed)
  }, [unknown, model, connection])

  // Only the tab opening or a turn-on may focus the input; once neither brings one up, a later
  // push that shows it must not take the page's keystrokes.
  useLayoutEffect(() => {
    if (checkFailed || (blocked !== null && blocked !== "checking")) focusInput.current = false
  })

  async function toggleChat(enabled: boolean) {
    try {
      const setting = await connection.setChat(enabled)
      focusInput.current = enabled
      model.setChatSetting(setting)
    } catch {
      model.pushToast(`Couldn't turn ${enabled ? "on" : "off"} chat — try again`, {
        tone: "failed",
      })
    }
  }

  return (
    <div class="cv-chat">
      {blocked === "no-pairing" ? (
        <AttachBox
          heading="Not attached"
          hint="Attach this page to a live session to message it."
        />
      ) : null}
      {blocked === "gone" ? (
        <AttachBox
          heading="Session ended"
          hint="Attach this page to a live session to message it."
        />
      ) : null}
      {blocked === "checking" && !checkFailed ? <p class="cv-line">Checking chat…</p> : null}
      {blocked === "checking" && checkFailed ? (
        <div class="cv-line">
          <span>Couldn't check chat for this page</span>
          <button
            type="button"
            class="cv-link"
            onClick={() => checkChat({ model, connection }, setCheckFailed)}
          >
            Retry
          </button>
        </div>
      ) : null}
      {blocked === "chat-off" ? (
        <>
          <div class="cv-off">
            <div class="cv-off-ic">
              <Icon name="lock" size={16} />
            </div>
            <p>
              <b>Chat is off for this page.</b> Pages that aren't local could send text to {name} as
              if you typed it.
            </p>
            <button type="button" class="btn ghost" onClick={() => void toggleChat(true)}>
              Turn on chat for this page
            </button>
          </div>
          <div class="cv-hatch" aria-hidden="true" />
        </>
      ) : null}
      {blocked === "unreachable" ? (
        <p class="cv-line">
          {name} can't take page messages right now. Chat reaches a session only through the iter8
          mod in Claude Code's terminal or desktop app; notes still work.
        </p>
      ) : null}
      {chat?.enabled && !chat.defaultEnabled && (blocked === null || blocked === "unreachable") ? (
        <div class="cv-line">
          <span>Chat is on for this page</span>
          <button type="button" class="cv-link" onClick={() => void toggleChat(false)}>
            Turn off
          </button>
        </div>
      ) : null}
      {blocked === null ? <ChatInput name={name} focus={focusInput} /> : null}
    </div>
  )
}

export function Conversation() {
  useSheet(conversationCss)
  return (
    <>
      <MessageList />
      <ChatBox />
    </>
  )
}
