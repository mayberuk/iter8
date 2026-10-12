import {
  type ConversationMessage,
  MESSAGE_MAX_CHARS,
  type MessageDelivery,
  type MessagePage,
  type PostMessageRequest,
  type RoundId,
} from "@iter8/protocol"
import { Fragment } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import type { PendingMessage, PostFailure } from "../conversation"
import { useOverlay, useSheet } from "./context"
import conversationCss from "./conversation.css" with { type: "text" }
import { SessionRows } from "./Dock"
import { Icon, Meter } from "./glyphs"
import { Markdown } from "./Markdown"

type Overlay = Pick<ReturnType<typeof useOverlay>, "model" | "connection">

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

const STICK_PX = 24

const FROM_PAGE = "You, from this page"

function clock(iso: string): string {
  return TIME.format(new Date(iso))
}

function authorLabel(author: ConversationMessage["author"]): string {
  switch (author.kind) {
    case "agent":
      return `${author.agent === "claude" ? "Claude" : author.agent} · ${author.name}`
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

function MessageRow({ message, name }: { message: ConversationMessage; name: string }) {
  const { author } = message
  const label = authorLabel(author)
  const time = clock(message.at)
  return (
    <article class={`cv-msg ${author.kind}`} aria-label={`${label}, ${time}`}>
      <div class="cv-meta">
        <b>{label}</b>
        <span>{time}</span>
      </div>
      {author.kind === "agent" ? (
        <Markdown text={message.text} />
      ) : (
        <p class="cv-text">{message.text}</p>
      )}
      {author.kind === "page" ? (
        <p class={`cv-state ${author.delivery.status}`}>{deliveryWords(author.delivery, name)}</p>
      ) : null}
    </article>
  )
}

function PendingRow(props: { entry: PendingMessage; name: string; blocked: boolean }) {
  const { entry, name, blocked } = props
  const overlay = useOverlay()
  const time = clock(entry.at)
  return (
    <article class="cv-msg page pending" aria-label={`${FROM_PAGE}, ${time}`}>
      <div class="cv-meta">
        <b>{FROM_PAGE}</b>
        <span>{time}</span>
      </div>
      <p class="cv-text">{entry.text}</p>
      {entry.status === "sending" ? (
        <p class="cv-state">Sending…</p>
      ) : (
        <>
          <p class="cv-state failed">Not sent — {failureWords(entry.reason, name)}</p>
          <div class="cv-acts">
            <button
              type="button"
              class="btn ghost"
              disabled={blocked}
              onClick={() => void post(overlay, overlay.model.retryPost(entry.key))}
            >
              Retry
            </button>
            <button
              type="button"
              class="btn ghost"
              onClick={() => overlay.model.discardPending(entry.key)}
            >
              Discard
            </button>
          </div>
        </>
      )}
    </article>
  )
}

function MessageList() {
  const { model, connection, root } = useOverlay()
  const messages = model.messages.value
  const pending = model.pendingMessages.value
  const load = model.conversation.value
  const blocked = model.chatBlocked.value !== null
  const name = model.name.value
  const list = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const hold = useRef<Hold | null>(null)
  const anchor = useRef<Hold | null>(null)
  const unloaded = load.status === "unloaded"

  // Read before this render commits: a scroll in the same task as a push has no scroll event yet.
  const shown = list.current
  if (shown) stick.current = shown.scrollHeight - shown.scrollTop - shown.clientHeight <= STICK_PX

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

  return (
    <div
      class="cv-list"
      role="log"
      aria-label="Messages"
      ref={list}
      onScroll={(event) => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX
        anchor.current = stick.current ? null : topRow(el)
      }}
    >
      <div class="cv-body" ref={body}>
        {load.status === "ready" && load.hasOlder && !load.olderLoading ? (
          <div class="cv-top">
            <button
              type="button"
              class="btn ghost"
              onClick={() => void loadPage({ model, connection }, "older", holdTopRow)}
            >
              Show earlier messages
            </button>
          </div>
        ) : null}
        {loading ? <div class="cv-top">Loading…</div> : null}
        {load.status === "failed" ? (
          <div class="cv-top">
            <span>Couldn't load messages</span>
            <button
              type="button"
              class="btn ghost"
              onClick={() => void loadPage({ model, connection }, "newest", () => {})}
            >
              Retry
            </button>
          </div>
        ) : null}
        {load.status === "ready" && messages.length === 0 && pending.length === 0 ? (
          <div class="empty-r">
            <h3>No messages yet</h3>
            <p>Finished messages from {name} show here.</p>
          </div>
        ) : null}
        {messages.map((message, index) => {
          const { roundId } = message
          return (
            <Fragment key={message.id}>
              {roundId !== null && roundId !== messages[index - 1]?.roundId ? (
                <button type="button" class="cv-round" onClick={() => showRound(roundId)}>
                  Round {roundId.slice(1)}
                </button>
              ) : null}
              <MessageRow message={message} name={name} />
            </Fragment>
          )
        })}
        {pending.map((entry) => (
          <PendingRow key={entry.key} entry={entry} name={name} blocked={blocked} />
        ))}
      </div>
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

  useLayoutEffect(() => {
    const el = field.current
    if (!el) return
    el.value = model.chatDraft.peek()
    setOver(overBy(el.value))
    if (focus.current) {
      focus.current = false
      el.focus()
    }
  }, [model, focus])

  function send() {
    const el = field.current
    if (!el || over > 0) return
    const request = model.beginPost(el.value)
    if (!request) return
    el.value = ""
    void post(overlay, request)
  }

  return (
    <div class="cv-compose">
      <div class="cv-field">
        <textarea
          ref={field}
          rows={1}
          aria-label={`Message ${name}`}
          placeholder={`Message ${name}`}
          onInput={(event) => {
            const text = event.currentTarget.value
            model.chatDraft.value = text
            setOver(overBy(text))
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
            event.preventDefault()
            send()
          }}
        />
        <button
          type="button"
          class="send"
          aria-label="Send message"
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
  const busy = model.dock.value === "busy"
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
        <div class="cv-off">
          <p>
            Chat is off for this page. Pages that aren't local could send text to {name} as if you
            typed it.
          </p>
          <button type="button" class="btn ghost" onClick={() => void toggleChat(true)}>
            Turn on chat for this page
          </button>
        </div>
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
      {busy && blocked === null ? (
        <div class="busyline">
          <Meter state="busy" />
          {name} is working — each message appears here when it finishes.
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
