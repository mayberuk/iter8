import {
  type ElementAnchor,
  Intent,
  type LiveSession,
  type Note,
  type Round,
  type ScreenshotRef,
} from "@iter8/protocol"
import type { JSX } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { captureCrop } from "../enrich/crop"
import {
  type DisplayNoteState,
  displayNoteState,
  nextRoundNumber,
  roundOutcome,
  type SheetTab,
  sessionName,
} from "../model"
import { resolveAnchor } from "../pick/anchor"
import { Conversation } from "./Conversation"
import { useOverlay, useSheet } from "./context"
import { SessionRows, useSendRound } from "./Dock"
import { Avatar, Icon, IntentGlyph, Meter, StatusGlyph } from "./glyphs"
import sheetCss from "./sheet.css" with { type: "text" }

type Sending = ReturnType<typeof useSendRound>

const INTENT_LABEL = {
  fix: "Fix",
  change: "Change",
  question: "Question",
  keep: "Keep",
} as const satisfies Record<Intent, string>

const TAB_LABEL = {
  round: "This round",
  conversation: "Conversation",
  history: "History",
} as const satisfies Record<SheetTab, string>

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

const COMPARE_STEP = 5

function clock(iso: string): string {
  return TIME.format(new Date(iso))
}

function number(index: number): string {
  return String(index + 1).padStart(2, "0")
}

function anchorsOf(note: Note): readonly ElementAnchor[] {
  switch (note.target.kind) {
    case "element":
      return [note.target.anchor]
    case "elements":
      return note.target.anchors
    case "region":
      return []
  }
}

function targetLabel(note: Note): string {
  const { target } = note
  if (target.kind === "region") {
    const size = `${Math.round(target.box.width)}×${Math.round(target.box.height)}`
    return note.capture?.screenshot ? `screenshot ${size}` : `region ${size}`
  }
  const anchors = anchorsOf(note)
  const first = anchors[0]
  const tag =
    first?.selector
      .at(-1)
      ?.split(" > ")
      .at(-1)
      ?.match(/^[a-z][\w-]*/i)?.[0] ?? "element"
  const name = first?.name ?? first?.text
  const base = name ? `${tag} “${name.length > 28 ? `${name.slice(0, 26)}…` : name}”` : tag
  return anchors.length > 1 ? `${base} ×${anchors.length}` : base
}

function sourceFile(note: Note): string | undefined {
  const lead = note.capture?.sourceLead
  return lead && lead.confidence !== "none" ? lead.file.split("/").pop() : undefined
}

function reveal(note: Note) {
  const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"
  const { target } = note
  if (target.kind === "region") {
    window.scrollTo({ top: target.box.y - window.innerHeight / 3, behavior })
    return
  }
  const first = anchorsOf(note)[0]
  const found = first && resolveAnchor(first)
  if (found?.kind === "anchored") found.el.scrollIntoView({ block: "center", behavior })
}

function useScreenshotUrl(ref: ScreenshotRef | undefined): string | null {
  const { connection } = useOverlay()
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (ref === undefined) return
    let live = true
    let made: string | null = null
    connection
      .fetchScreenshot(ref)
      .then((blob) => {
        if (!live) return
        made = URL.createObjectURL(blob)
        setUrl(made)
      })
      .catch(() => {})
    return () => {
      live = false
      if (made !== null) URL.revokeObjectURL(made)
      setUrl(null)
    }
  }, [ref, connection])

  return ref === undefined ? null : url
}

function useFreshSessions(active: boolean) {
  const { model, connection } = useOverlay()
  useEffect(() => {
    if (!active) return
    let live = true
    connection
      .listSessions()
      .then((sessions) => {
        if (live) model.liveSessions.value = sessions
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [active, connection, model])
}

function useAttachable(): LiveSession[] {
  const { model } = useOverlay()
  const owner = model.pairing.value?.owner
  return model.liveSessions.value.filter(
    (session) => session.state.status !== "gone" && session.owner !== owner,
  )
}

function StateChip({ state }: { state: DisplayNoteState }) {
  return (
    <span class={`st-chip ${state}`} role="status" aria-label={state}>
      <StatusGlyph state={state} />
      {state}
    </span>
  )
}

function AttachBox(props: { heading: string; hint: string }) {
  const { model } = useOverlay()
  const sessions = useAttachable()
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

function DraftRow(props: {
  note: Note
  index: number
  drag: {
    from: { current: number | null }
    over: number | null
    setOver: (to: number | null) => void
  }
}) {
  const { note, index, drag } = props
  const { model, connection } = useOverlay()
  const screenshot = useScreenshotUrl(note.capture?.screenshot?.ref)
  const focused = model.focus.value === index
  const resolution = model.anchors.value.get(note.id)
  const moved = resolution ? resolution.status !== "anchored" : note.anchorStatus !== "anchored"
  const classes = ["note", note.intent, focused ? "focus" : "", drag.over === index ? "over" : ""]

  async function remove() {
    try {
      await connection.deleteDraft(note.id)
      model.noteDeleted(note.id)
    } catch {
      model.pushToast("Couldn't delete the note — try again", { tone: "failed" })
    }
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: j and k move the focus between rows (keys.ts)
    <li
      id={`note-${note.id}`}
      class={classes.filter(Boolean).join(" ")}
      draggable
      aria-current={focused ? "true" : undefined}
      onClick={() => {
        model.focus.value = index
      }}
      onDragStart={(event) => {
        drag.from.current = index
        event.dataTransfer?.setData("text/plain", String(index))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      }}
      onDragEnd={() => {
        drag.from.current = null
        drag.setOver(null)
      }}
      onDragOver={(event) => {
        event.preventDefault()
        drag.setOver(index)
      }}
      onDragLeave={() => drag.setOver(null)}
      onDrop={(event) => {
        event.preventDefault()
        const from = drag.from.current
        drag.from.current = null
        drag.setOver(null)
        if (from !== null) model.moveNote(from, index)
      }}
    >
      <span class="grip" aria-hidden="true">
        <Icon name="grip" size={14} />
      </span>
      <div class="frame">
        {screenshot ? <img src={screenshot} alt={`Screenshot of note ${index + 1}`} /> : null}
        <span class="fn">{number(index)}</span>
        {note.target.kind === "elements" ? (
          <span class="multi">×{note.target.anchors.length}</span>
        ) : null}
        <span class="edge" />
      </div>
      <div class="nb">
        <div class="eb">
          <IntentGlyph intent={note.intent} size={15} />
          <span class="it">{INTENT_LABEL[note.intent]}</span>
        </div>
        <div class="txt">{note.body}</div>
        <div class="tgt">{targetLabel(note)}</div>
        {moved ? (
          <span class="st-chip moved" role="status" aria-label="Moved">
            Moved
          </span>
        ) : null}
        <div class="acts">
          <button
            type="button"
            class="iconbtn"
            aria-label={`Edit note ${index + 1}`}
            onClick={(event) => {
              event.stopPropagation()
              reveal(note)
              model.openComposer({ editing: note.id })
            }}
          >
            <Icon name="edit" size={14} />
          </button>
          <button
            type="button"
            class="iconbtn del"
            aria-label={`Delete note ${index + 1}`}
            onClick={(event) => {
              event.stopPropagation()
              void remove()
            }}
          >
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </li>
  )
}

function RoundTab() {
  const { model, root } = useOverlay()
  const notes = model.orderedDrafts.value
  const focused = notes[model.focus.value]
  const from = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  useEffect(() => {
    if (!focused) return
    root.getElementById(`note-${focused.id}`)?.scrollIntoView({ block: "nearest" })
    reveal(focused)
  }, [focused, root])

  if (notes.length === 0) {
    return (
      <div class="empty-r">
        <div class="ring2">
          <Icon name="pick" size={20} />
        </div>
        <h3>Nothing in round {nextRoundNumber(model.rounds.value)} yet</h3>
        <p>
          Press <kbd>C</kbd> and click anything on the page,
          <br />
          or <kbd>S</kbd> to mark up a screenshot.
        </p>
      </div>
    )
  }

  return (
    <ol class="notes" aria-label="Notes in this round">
      {notes.map((note, index) => (
        <DraftRow key={note.id} note={note} index={index} drag={{ from, over, setOver }} />
      ))}
    </ol>
  )
}

function Footer({ sending }: { sending: Sending }) {
  const { model } = useOverlay()
  const { send, blocked, label } = sending
  const notes = model.orderedDrafts.value
  const counts = Intent.options.flatMap((intent) => {
    const count = notes.filter((note) => note.intent === intent).length
    return count ? [{ intent, count }] : []
  })
  const unattached = blocked === "gone" || blocked === "no-pairing"
  useFreshSessions(unattached)
  const pairing = model.pairing.value
  const wake =
    blocked !== null || !pairing || pairing.state.status === "busy"
      ? null
      : pairing.listener === "none"
        ? `Queued until your next prompt in ${model.name.value}`
        : `Wakes ${model.name.value} now`

  return (
    <div class="sh-f">
      {blocked === "gone" ? (
        <AttachBox heading="Session ended" hint="Attach this page to a live session to send." />
      ) : null}
      {blocked === "no-pairing" ? (
        <AttachBox heading="Not attached" hint="Attach this page to a live session to send." />
      ) : null}
      {model.dock.value === "busy" ? (
        <div class="busyline">
          <Meter state="busy" />
          {model.name.value} is mid-turn. This round delivers when its turn ends.
        </div>
      ) : null}
      {wake ? <div class="wakeline">{wake}</div> : null}
      <div class="sum">
        <div class="txt">
          {notes.length ? (
            <>
              <b>
                {notes.length} note{notes.length === 1 ? "" : "s"}
              </b>
              {counts.map(({ intent, count }) => `${count} ${intent}`).join(" · ")}
            </>
          ) : (
            "No notes yet"
          )}
          <div class="bars">
            {counts.map(({ intent, count }) => (
              <i key={intent} class={intent} style={{ flex: count }} />
            ))}
          </div>
        </div>
        <button type="button" class="send" disabled={blocked !== null} onClick={() => void send()}>
          <Icon name="send" size={15} />
          {label} round
        </button>
      </div>
    </div>
  )
}

type After = { status: "loading" } | { status: "ready"; url: string } | { status: "unavailable" }

function useAfter(note: Note): After {
  const { host } = useOverlay()
  const [after, setAfter] = useState<After>({ status: "loading" })

  useEffect(() => {
    const controller = new AbortController()
    let made: string | null = null
    const first = anchorsOf(note)[0]
    const found = first && resolveAnchor(first)
    if (found?.kind !== "anchored") {
      setAfter({ status: "unavailable" })
      return
    }
    captureCrop(found.el, { signal: controller.signal, exclude: host })
      .then((result) => {
        if (controller.signal.aborted) return
        if ("omitted" in result) {
          setAfter({ status: "unavailable" })
          return
        }
        made = URL.createObjectURL(result.png)
        setAfter({ status: "ready", url: made })
      })
      .catch(() => {})
    return () => {
      controller.abort()
      if (made !== null) URL.revokeObjectURL(made)
    }
  }, [note, host])

  return after
}

function Compare({ note, before }: { note: Note; before: ScreenshotRef }) {
  const beforeUrl = useScreenshotUrl(before)
  const after = useAfter(note)
  const [position, setPosition] = useState(50)

  return (
    <div class="compare" style={{ "--p": `${position}%` }}>
      <div class="lay before">{beforeUrl ? <img src={beforeUrl} alt="" /> : null}</div>
      <div class="lay after">
        {after.status === "ready" ? <img src={after.url} alt="" /> : null}
        {after.status === "unavailable" ? "Element not on the page" : null}
      </div>
      <span class="bar" />
      <span class="lbl b">BEFORE</span>
      <span class="lbl a">AFTER</span>
      <span class="knob" aria-hidden="true">
        <Icon name="compare" size={14} />
      </span>
      <input
        type="range"
        class="slide"
        min={0}
        max={100}
        step={1}
        value={position}
        aria-label="Compare before and after"
        onInput={(event) => setPosition(Number(event.currentTarget.value))}
        onKeyDown={(event) => {
          const delta = { ArrowLeft: -COMPARE_STEP, ArrowRight: COMPARE_STEP }[event.key]
          if (delta === undefined) return
          event.preventDefault()
          setPosition((current) => Math.min(100, Math.max(0, current + delta)))
        }}
      />
    </div>
  )
}

function HistoryNote(props: { round: Round; note: Note; index: number; agentName: string }) {
  const { round, note, index, agentName } = props
  const [comparing, setComparing] = useState(false)
  const state = displayNoteState(round, note)
  const finished = state === "done" || state === "answered"
  const file = sourceFile(note)
  const before = note.capture?.screenshot?.ref
  const comparable = before !== undefined
  const { resolution } = note
  const roundState = round.state
  const sent = roundState.stage === "draft" ? undefined : clock(roundState.queuedAt)
  const announced =
    roundState.stage === "announced" ||
    roundState.stage === "claimed" ||
    roundState.stage === "orphaned"
      ? roundState.announcedAt
      : undefined
  const delivered = announced === undefined ? undefined : clock(announced)
  const when = [
    sent && `sent ${sent}`,
    delivered && delivered !== sent && `delivered ${delivered}`,
    roundState.stage === "claimed" && `picked up ${clock(roundState.claimedAt)}`,
    roundState.stage === "orphaned" && `not delivered ${clock(roundState.orphanedAt)}`,
    finished && resolution.status !== "open" && `${resolution.status} ${clock(resolution.at)}`,
  ].filter(Boolean)

  return (
    <article class={`hn ${note.intent}`} id={`hn-${round.id}-${note.id}`}>
      <div class="num">
        <IntentGlyph intent={note.intent} size={20} />
        {number(index)}
      </div>
      <div class="body">
        <div class="hl1">
          <span class="it">{INTENT_LABEL[note.intent]}</span>
          <StateChip state={state} />
        </div>
        <p class="q">{note.body}</p>
        {resolution.status === "answered" ? (
          <section class="reply claude" aria-label={`Reply from ${agentName}`}>
            <Avatar agent="claude" size={20} />
            <div>
              <div class="who">
                {agentName}
                <span>answered {clock(resolution.at)}</span>
              </div>
              <p>{resolution.reply}</p>
            </div>
          </section>
        ) : null}
        <div class="prov">
          <span class="cmp">{targetLabel(note)}</span>
          {file ? (
            <>
              <span class="sep">·</span>
              <span class="fl">{file}</span>
            </>
          ) : null}
        </div>
        <div class="when">{when.join(" · ")}</div>
        {comparable ? (
          <div class="row2">
            <button
              type="button"
              class="chipbtn"
              aria-expanded={comparing}
              onClick={() => setComparing(!comparing)}
            >
              <Icon name="compare" size={13} />
              {comparing ? "Hide compare" : "Before / after"}
            </button>
          </div>
        ) : null}
        {comparing && comparable ? <Compare note={note} before={before} /> : null}
      </div>
    </article>
  )
}

function Strip({ round }: { round: Round }) {
  const { root } = useOverlay()
  return (
    <div class="strip">
      {round.notes.map((note, index) => (
        <StripFrame key={note.id} round={round} note={note} index={index} root={root} />
      ))}
    </div>
  )
}

function StripFrame(props: { round: Round; note: Note; index: number; root: ShadowRoot }) {
  const { round, note, index, root } = props
  const screenshot = useScreenshotUrl(note.capture?.screenshot?.ref)
  const state = displayNoteState(round, note)
  const finished = state === "done" || state === "answered"
  const colour = finished
    ? "var(--keep)"
    : state === "delivered"
      ? "var(--cobalt)"
      : "var(--change)"
  return (
    <button
      type="button"
      class="sframe"
      aria-label={`Note ${index + 1}`}
      style={{ "--sc": colour }}
      onClick={() => {
        root.getElementById(`hn-${round.id}-${note.id}`)?.scrollIntoView({ block: "nearest" })
        reveal(note)
      }}
    >
      {screenshot ? <img src={screenshot} alt={`Screenshot of note ${index + 1}`} /> : null}
      <span class="fn">{number(index)}</span>
      <span class="stamp">{finished ? <Icon name="check" size={8} /> : null}</span>
    </button>
  )
}

function HistoryRound({ round }: { round: Round }) {
  const { model } = useOverlay()
  const outcome = roundOutcome(round)
  const pairing = model.pairing.value
  const owner =
    pairing?.owner === round.owner
      ? pairing
      : model.liveSessions.value.find((session) => session.owner === round.owner)
  const agentName = !owner ? "Agent" : owner.agent === "claude" ? "Claude" : owner.agent
  const ownerName = owner ? sessionName(owner, model.pageId.value) : agentName
  const sent = round.state.stage === "draft" ? undefined : clock(round.state.queuedAt)

  return (
    <section class="round" id={`round-${round.id}`} aria-label={`Round ${round.id.slice(1)}`}>
      <header class="rh">
        <div class="rh1">
          <h3>Round {round.id.slice(1)}</h3>
          <span
            class={outcome.tone === "done" ? "out" : `out ${outcome.tone}`}
            role="status"
            aria-label={outcome.label}
          >
            {outcome.tone === "done" ? <Icon name="check" size={13} /> : null}
            {round.state.stage === "orphaned"
              ? `${outcome.label} — ${ownerName} ended before picking this up`
              : outcome.label}
          </span>
          <span class="ticks" aria-hidden="true">
            {round.notes.map((note) => (
              <i key={note.id} class={displayNoteState(round, note)} />
            ))}
          </span>
        </div>
        <div class="rh2">
          <Avatar agent={owner?.agent ?? "agent"} size={16} />
          <b>{agentName}</b>
          {owner ? <span>in {ownerName}</span> : null}
          {sent ? <span class="sent">· {sent}</span> : null}
        </div>
      </header>
      {round.state.stage === "orphaned" ? (
        <AttachBox
          heading="This round didn't reach a session"
          hint="Attach this page to a live session to deliver it."
        />
      ) : null}
      <Strip round={round} />
      {round.notes.map((note, index) => (
        <HistoryNote key={note.id} round={round} note={note} index={index} agentName={agentName} />
      ))}
    </section>
  )
}

function HistoryTab() {
  const { model } = useOverlay()
  const rounds = [...model.rounds.value].reverse()
  useFreshSessions(rounds.some((round) => round.state.stage === "orphaned"))

  if (rounds.length === 0) {
    return (
      <div class="empty-r">
        <h3>No rounds sent yet</h3>
        <p>Sent rounds show here with what the agent did.</p>
      </div>
    )
  }
  return (
    <>
      {rounds.map((round) => (
        <HistoryRound key={round.id} round={round} />
      ))}
    </>
  )
}

function Sheet({ sending }: { sending: Sending }) {
  useSheet(sheetCss)
  const { model } = useOverlay()
  const { tab } = model.sheet.value
  const pairing = model.pairing.value
  const sentNotes = model.rounds.value.reduce((sum, round) => sum + round.notes.length, 0)

  function pickTab(next: SheetTab) {
    model.sheet.value = { ...model.sheet.value, tab: next }
    model.focus.value = -1
  }

  return (
    <aside class="sheet" aria-label="Round sheet">
      <div class="sh-h">
        <div>
          <h2>Round {nextRoundNumber(model.rounds.value)}</h2>
          <div class="sub">
            <Meter state={model.dock.value} still />
            {pairing ? (
              <>
                <span>to</span>
                <Avatar agent={pairing.agent} size={16} />
                <b>{model.name.value}</b>
                <span class="host">{model.where.value}</span>
              </>
            ) : (
              <span>Not attached</span>
            )}
          </div>
        </div>
        <button
          type="button"
          class="iconbtn"
          aria-label="Close round sheet"
          data-tip="Close"
          data-kbd="Esc"
          onClick={() => model.toggleSheet()}
        >
          <Icon name="x" />
        </button>
      </div>
      <div class="tabs" role="tablist">
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={tab === "round"}
          onClick={() => pickTab("round")}
        >
          This round <span class="ct">{model.drafts.value.length}</span>
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={tab === "conversation"}
          onClick={() => pickTab("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={tab === "history"}
          onClick={() => pickTab("history")}
        >
          History <span class="ct">{sentNotes}</span>
        </button>
      </div>
      <div
        class={tab === "conversation" ? "sh-b conv" : "sh-b"}
        role="tabpanel"
        aria-label={TAB_LABEL[tab]}
      >
        {tab === "round" ? <RoundTab /> : null}
        {tab === "conversation" ? <Conversation /> : null}
        {tab === "history" ? <HistoryTab /> : null}
      </div>
      {tab === "round" ? <Footer sending={sending} /> : null}
    </aside>
  )
}

export function RoundSheet(): JSX.Element | null {
  const { model } = useOverlay()
  const sending = useSendRound()
  return model.sheet.value.open ? <Sheet sending={sending} /> : null
}
