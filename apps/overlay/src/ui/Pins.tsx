import type { Box, ElementAnchor, Intent, Note, NoteId, RoundId } from "@iter8/protocol"
import { effect } from "@preact/signals"
import type { JSX } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { type AnchorResolution, type OverlayModel, toDraftBody } from "../model"
import { resolveAnchor } from "../pick/anchor"
import { useOverlay, useSheet } from "./context"
import { Avatar, Icon, IntentGlyph } from "./glyphs"
import pinsCss from "./pins.css" with { type: "text" }

const INTENT_LABEL = {
  fix: "Fix",
  change: "Change",
  question: "Question",
  keep: "Keep",
} as const satisfies Record<Intent, string>

/** At most one re-anchoring pass per this interval, however many mutations the page makes. */
const PASS_INTERVAL_MS = 250
const IDLE_TIMEOUT_MS = 500
const YIELD_EVERY = 20
const CARD_WIDTH = 284
const CARD_EDGE = 12
const CARD_GAP = 10
const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" })

type Source = {
  note: Note
  kind: "draft" | "sent" | "agent"
  number: number
  round: RoundId | null
}

type PinView = {
  key: string
  source: Source
  index: number
  region: Box | null
}

type Hover = { key: string; left: number; right: number; top: number }

function sourcesOf(model: OverlayModel): Source[] {
  const sentIds = new Set(model.lastSentNoteIds.value)
  return [
    ...model.orderedDrafts.value.map((note, i) => ({
      note,
      kind: "draft" as const,
      number: i + 1,
      round: null,
    })),
    ...model.rounds.value.flatMap((round) =>
      round.notes.flatMap((note, i) =>
        sentIds.has(note.id)
          ? [{ note, kind: "sent" as const, number: i + 1, round: round.id }]
          : [],
      ),
    ),
    ...model.agentNotes.value.map((note) => ({
      note,
      kind: "agent" as const,
      number: 0,
      round: null,
    })),
  ]
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

async function yieldToMain(): Promise<void> {
  // scheduler.yield is missing in Safari and older Firefox.
  if ("scheduler" in globalThis) await globalThis.scheduler.yield()
  else await new Promise((resolve) => setTimeout(resolve))
}

function lostReason(model: OverlayModel, source: Source): "missing" | "ambiguous" | undefined {
  const resolution = model.anchors.value.get(source.note.id)
  return resolution && resolution.status !== "anchored" ? resolution.reason : undefined
}

export function Pins(): JSX.Element | null {
  useSheet(pinsCss)
  const { model, connection } = useOverlay()
  const nodes = useRef(new Map<string, HTMLElement | SVGElement>())
  const elements = useRef(new Map<string, WeakRef<Element>>())
  const views = useRef<PinView[]>([])
  const place = useRef<() => void>(() => {})
  const repick = useRef<NoteId | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    let disposed = false
    let running = false
    let rerun = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let idle: number | null = null
    let frame = 0
    let lastStart = Number.NEGATIVE_INFINITY

    function placeAll() {
      frame = 0
      if (disposed || !model.prefs.peek().pinsVisible) return
      const reads: { view: PinView; rect: { left: number; top: number; right: number } | null }[] =
        []
      for (const view of views.current) {
        if (view.region) {
          const left = view.region.x - window.scrollX
          const top = view.region.y - window.scrollY
          reads.push({ view, rect: { left, top, right: left + view.region.width } })
          continue
        }
        const el = elements.current.get(view.key)?.deref()
        const rect = el?.isConnected ? el.getBoundingClientRect() : null
        reads.push({
          view,
          rect: rect && (rect.width > 0 || rect.height > 0) ? rect : null,
        })
      }
      const positions = new Map<string, { x: number; y: number }>()
      for (const { view, rect } of reads) {
        const node = nodes.current.get(view.key)
        if (!node) continue
        if (!rect) {
          node.removeAttribute("data-placed")
          continue
        }
        node.setAttribute("data-placed", "")
        const agent = view.source.kind === "agent"
        const sub = view.index > 0
        const x = agent ? rect.right - 8 : rect.left + (sub ? 0 : 2)
        const y = agent ? rect.top + 6 : rect.top + (sub ? 0 : 2)
        positions.set(view.key, { x, y })
        node.style.translate = `${x}px ${y}px`
      }
      for (const view of views.current) {
        if (view.index === 0 || view.source.kind === "agent") continue
        const path = nodes.current.get(`link:${view.key}`)
        const from = positions.get(`${view.source.kind}:${view.source.note.id}:0`)
        const to = positions.get(view.key)
        if (!path) continue
        if (!from || !to) {
          path.setAttribute("d", "")
          continue
        }
        const midX = (from.x + to.x) / 2
        const midY = Math.min(from.y, to.y) - 28
        path.setAttribute("d", `M${from.x} ${from.y} Q${midX} ${midY} ${to.x} ${to.y}`)
      }
    }

    function requestPlace() {
      if (frame === 0 && !disposed) frame = requestAnimationFrame(placeAll)
    }
    place.current = requestPlace

    async function pass() {
      running = true
      lastStart = performance.now()
      const sources = sourcesOf(model)
      const nextElements = new Map<string, WeakRef<Element>>()
      const nextAnchors = new Map<NoteId, AnchorResolution>()
      let handled = 0
      for (const source of sources) {
        const anchors = anchorsOf(source.note)
        if (anchors.length === 0) continue
        const results = anchors.map((anchor) => resolveAnchor(anchor))
        const lost = results.find((result) => result.kind === "lost")
        if (lost) {
          nextAnchors.set(source.note.id, {
            status: source.kind === "agent" ? "unanchored" : "moved",
            reason: lost.reason,
          })
        } else {
          results.forEach((result, i) => {
            if (result.kind === "anchored")
              nextElements.set(`${source.kind}:${source.note.id}:${i}`, new WeakRef(result.el))
          })
          const first = results[0]
          if (first?.kind === "anchored")
            nextAnchors.set(source.note.id, { status: "anchored", el: new WeakRef(first.el) })
        }
        handled += 1
        if (handled % YIELD_EVERY === 0) {
          await yieldToMain()
          if (disposed) return
        }
      }
      running = false
      elements.current = nextElements
      const held = model.anchors.peek()
      const same =
        held.size === nextAnchors.size &&
        [...nextAnchors].every(([id, next]) => {
          const was = held.get(id)
          if (!was || was.status !== next.status) return false
          if (was.status === "anchored" && next.status === "anchored")
            return was.el.deref() === next.el.deref()
          return (
            was.status !== "anchored" && next.status !== "anchored" && was.reason === next.reason
          )
        })
      if (!same) model.anchors.value = nextAnchors
      requestPlace()
      syncDraftStatus(sources, nextAnchors)
      if (rerun) {
        rerun = false
        request()
      }
    }

    function syncDraftStatus(sources: Source[], resolved: Map<NoteId, AnchorResolution>) {
      const editing = model.composer.peek()?.editing
      for (const { note, kind } of sources) {
        const resolution = resolved.get(note.id)
        if (kind !== "draft" || !resolution || note.id === editing) continue
        const wanted = resolution.status === "anchored" ? "anchored" : "moved"
        if (note.anchorStatus === wanted) continue
        const body = toDraftBody(
          { intent: note.intent, body: note.body, target: note.target, anchorStatus: wanted },
          note.capture,
        )
        connection.putDraft(note.id, body)
        model.noteUpdated({ ...note, ...body })
      }
    }

    function startPass() {
      timer = null
      idle = requestIdleCallback(
        () => {
          idle = null
          void pass().catch(() => {
            running = false
          })
        },
        { timeout: IDLE_TIMEOUT_MS },
      )
    }

    function request() {
      if (disposed) return
      if (running) {
        rerun = true
        return
      }
      if (timer !== null || idle !== null) return
      timer = setTimeout(startPass, Math.max(0, lastStart + PASS_INTERVAL_MS - performance.now()))
    }

    const observer = new MutationObserver(request)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    const onMove = () => requestPlace()
    window.addEventListener("scroll", onMove, { capture: true, passive: true })
    window.addEventListener("resize", onMove, { passive: true })

    const stopNotes = effect(() => {
      model.drafts.value
      model.rounds.value
      model.agentNotes.value
      model.lastSentNoteIds.value
      request()
    })
    const stopVisible = effect(() => {
      if (model.prefs.value.pinsVisible) requestPlace()
    })
    const stopRepick = effect(() => {
      const composer = model.composer.value
      const mode = model.mode.value
      const id = repick.current
      if (id === null) return
      if (mode === "idle") {
        repick.current = null
        return
      }
      if (!composer || composer.editing || composer.target.kind === "region") {
        if (composer) repick.current = null
        return
      }
      repick.current = null
      const note = model.drafts.peek().find((draft) => draft.id === id)
      if (note) {
        const body = toDraftBody(
          {
            intent: note.intent,
            body: note.body,
            target: composer.target,
            anchorStatus: "anchored",
          },
          undefined,
        )
        connection.putDraft(id, body)
        model.noteUpdated({ ...note, ...body })
      }
      model.setMode("idle")
    })

    return () => {
      disposed = true
      observer.disconnect()
      window.removeEventListener("scroll", onMove, { capture: true })
      window.removeEventListener("resize", onMove)
      stopNotes()
      stopVisible()
      stopRepick()
      if (timer !== null) clearTimeout(timer)
      if (idle !== null) cancelIdleCallback(idle)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [model, connection])

  const sources = sourcesOf(model)
  const anchored = model.anchors.value
  const focusedId = model.draftOrder.value[model.focus.value]
  const pinsVisible = model.prefs.value.pinsVisible

  const pins: PinView[] = []
  const lost: Source[] = []
  for (const source of sources) {
    const { note } = source
    if (note.target.kind === "region") {
      pins.push({ key: `${source.kind}:${note.id}:0`, source, index: 0, region: note.target.box })
      continue
    }
    const resolution = anchored.get(note.id)
    if (!resolution) continue
    if (resolution.status !== "anchored") {
      lost.push(source)
      continue
    }
    const count = anchorsOf(note).length
    for (let index = 0; index < count; index += 1)
      pins.push({ key: `${source.kind}:${note.id}:${index}`, source, index, region: null })
  }
  views.current = pins

  useLayoutEffect(() => {
    place.current()
  })

  useEffect(() => {
    if (focusedId === undefined) return
    const node = nodes.current.get(`draft:${focusedId}:0`)
    if (!node) return
    node.classList.remove("pulse")
    void node.getBoundingClientRect()
    node.classList.add("pulse")
  }, [focusedId])

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!hover || !card) return
    const height = card.getBoundingClientRect().height
    const right = hover.right + CARD_GAP
    const left =
      right + CARD_WIDTH > window.innerWidth - CARD_EDGE
        ? hover.left - CARD_WIDTH - CARD_GAP
        : right
    const top = Math.min(
      Math.max(hover.top - 6, CARD_EDGE),
      Math.max(CARD_EDGE, window.innerHeight - height - CARD_EDGE),
    )
    card.style.left = `${left}px`
    card.style.top = `${top}px`
  }, [hover])

  function bind(key: string) {
    return (node: HTMLElement | SVGElement | null) => {
      if (node) nodes.current.set(key, node)
      else nodes.current.delete(key)
    }
  }

  function showCard(key: string, event: Event) {
    const target = event.currentTarget
    if (!(target instanceof Element)) return
    const rect = target.getBoundingClientRect()
    setHover({ key, left: rect.left, right: rect.right, top: rect.top })
  }

  function openPin(source: Source) {
    setHover(null)
    const mode = model.mode.value
    if (mode === "compose" || mode === "markup") return
    if (source.kind === "draft") model.openComposer({ editing: source.note.id })
    else if (source.kind === "sent") model.sheet.value = { open: true, tab: "history" }
  }

  function startRepick(id: NoteId) {
    const mode = model.mode.value
    if (mode === "compose" || mode === "markup") return
    repick.current = id
    model.setMode("pick")
  }

  const hovered = hover && pins.find((pin) => pin.key === hover.key)
  const { author } = hovered?.source.note ?? {}
  const dock = model.prefs.value.dock
  const moved = lost.filter(({ kind }) => kind !== "agent")
  const unanchored = lost.filter(({ kind }) => kind === "agent")

  if (pins.length === 0 && lost.length === 0) return null

  return (
    <div class={pinsVisible ? "layer chrome pinlayer" : "layer chrome pinlayer off"}>
      <svg class="links" aria-hidden="true">
        {pins.map((pin) =>
          pin.index === 0 || pin.source.kind === "agent" ? null : (
            <path
              key={pin.key}
              ref={bind(`link:${pin.key}`)}
              class={`${pin.source.note.intent} ${pin.source.kind === "sent" ? "sent" : ""}`}
            />
          ),
        )}
      </svg>
      <div>
        {pins.map((pin) => {
          const { source } = pin
          const { note } = source
          if (source.kind === "agent" && note.author.kind === "agent")
            return (
              <button
                key={pin.key}
                ref={bind(pin.key)}
                type="button"
                class={note.author.agent === "claude" ? "apin claude" : "apin"}
                aria-label={`${note.author.name} note`}
                onPointerEnter={(event) => showCard(pin.key, event)}
                onPointerLeave={() => setHover(null)}
                onFocus={(event) => showCard(pin.key, event)}
                onBlur={() => setHover(null)}
              >
                <Avatar agent={note.author.agent} size={26} />
              </button>
            )
          const classes = [
            "pin",
            note.intent,
            source.kind === "sent" ? "sent" : "",
            pin.index > 0 ? "sub" : "",
            source.kind === "draft" && note.id === focusedId ? "focus" : "",
          ]
          return (
            <button
              key={pin.key}
              ref={bind(pin.key)}
              type="button"
              class={classes.filter(Boolean).join(" ")}
              aria-label={`Note ${source.number}, ${INTENT_LABEL[note.intent]}`}
              aria-hidden={pin.index > 0 ? "true" : undefined}
              tabIndex={pin.index > 0 ? -1 : undefined}
              onPointerEnter={(event) => showCard(pin.key, event)}
              onPointerLeave={() => setHover(null)}
              onFocus={(event) => showCard(pin.key, event)}
              onBlur={() => setHover(null)}
              onClick={() => openPin(source)}
            >
              {source.number}
            </button>
          )
        })}
      </div>
      <div
        ref={cardRef}
        class={`pop pcard${hovered ? " on" : ""}${author?.kind === "agent" ? " agent" : ""}`}
        role="tooltip"
      >
        {hovered && author?.kind === "agent" && (
          <>
            <div class="t">
              <Avatar agent={author.agent} size={18} />
              <span class="who">{author.name}</span>
              <span class="mono">{TIME.format(new Date(hovered.source.note.createdAt))}</span>
            </div>
            <p>{hovered.source.note.body}</p>
          </>
        )}
        {hovered && author?.kind === "user" && (
          <>
            <div class="t">
              <IntentGlyph intent={hovered.source.note.intent} size={16} />
              <b>{INTENT_LABEL[hovered.source.note.intent]}</b>
              <span>· note {hovered.source.number}</span>
              <span class="mono">{targetLabel(hovered.source.note)}</span>
            </div>
            <p>{hovered.source.note.body}</p>
            <div class="f">
              {hovered.source.kind === "sent" ? (
                <>
                  <Icon name="check" size={12} /> Sent with round {hovered.source.round}
                </>
              ) : (
                <>
                  <Icon name="edit" size={12} /> Click to edit
                </>
              )}
            </div>
          </>
        )}
      </div>
      {lost.length > 0 && (
        <div
          class={`pop on lost${model.sheet.value.open ? " beside-sheet" : ""}`}
          data-v={dock[0]}
          data-h={dock[1] === "l" ? "l" : "r"}
        >
          <h4>
            {lost.length === 1
              ? "1 note lost its element"
              : `${lost.length} notes lost their element`}
          </h4>
          {moved.length > 0 && (
            <ul aria-label="Moved notes">
              {moved.map((source) => (
                <LostRow
                  key={source.note.id}
                  source={source}
                  reason={lostReason(model, source)}
                  onRepick={source.kind === "draft" ? () => startRepick(source.note.id) : null}
                />
              ))}
            </ul>
          )}
          {unanchored.length > 0 && (
            <ul aria-label="Unanchored notes">
              {unanchored.map((source) => (
                <LostRow
                  key={source.note.id}
                  source={source}
                  reason={lostReason(model, source)}
                  onRepick={null}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function LostRow({
  source,
  reason,
  onRepick,
}: {
  source: Source
  reason: "missing" | "ambiguous" | undefined
  onRepick: (() => void) | null
}) {
  const { note } = source
  return (
    <li>
      {note.author.kind === "agent" ? (
        <Avatar agent={note.author.agent} size={18} />
      ) : (
        <IntentGlyph intent={note.intent} size={16} />
      )}
      <span class="what">
        <span>{note.body}</span>
        <span class="why">{reason === "ambiguous" ? "more than one match" : "element gone"}</span>
      </span>
      <span class="tag">{source.kind === "agent" ? "Unanchored" : "Moved"}</span>
      {onRepick && (
        <button type="button" class="chipbtn" onClick={onRepick}>
          Re-pick
        </button>
      )}
    </li>
  )
}
