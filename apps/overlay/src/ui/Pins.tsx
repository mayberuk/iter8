import type { Box, ElementAnchor, Intent, Note, NoteId, RoundId } from "@iter8/protocol"
import { effect } from "@preact/signals"
import type { JSX } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { type AnchorResolution, isBeingWorked, type OverlayModel, toDraftBody } from "../model"
import { parentAcrossShadow, resolveAnchor } from "../pick/anchor"
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
/** A pin's 12 px half-size plus the sent badge's 5 px overhang, at the 1.15 hover scale. */
const PIN_REACH = 20
/** An agent pin's box centre relative to its placed point, from its margins in pins.css. */
const AGENT_CENTRE = { x: 10, y: -16 }
/** The pointer must leave the panel's rectangle by this much before it comes back from its fade. */
const FADE_HYSTERESIS = 4
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

/**
 * Where a pin is laid out: `document` and `viewport` pins move with the page on the compositor;
 * a `tracked` pin's element moves inside a scroller or sticks, so a scroll re-places it.
 */
type Frame = "document" | "viewport" | "tracked"

type Point = { x: number; y: number }

function scrolls(overflow: string): boolean {
  return overflow !== "visible" && overflow !== "clip"
}

function frameOf(el: Element): Frame {
  for (let at: Element | null = el; at !== null; at = parentAcrossShadow(at)) {
    if (at === document.documentElement || at === document.body) break
    const style = getComputedStyle(at)
    if (style.position === "sticky") return "tracked"
    if (at !== el && (scrolls(style.overflowX) || scrolls(style.overflowY))) return "tracked"
    if (style.position === "fixed") return "viewport"
  }
  return "document"
}

function viewFrame(view: PinView, frames: ReadonlyMap<string, Frame>): Frame {
  return view.region ? "document" : (frames.get(view.key) ?? "document")
}

function headKey(view: PinView): string {
  return `${view.source.kind}:${view.source.note.id}:0`
}

function isLinked(view: PinView): boolean {
  return view.index > 0 && view.source.kind !== "agent"
}

function sameFrames(a: ReadonlyMap<string, Frame>, b: ReadonlyMap<string, Frame>): boolean {
  return a.size === b.size && [...b].every(([key, frame]) => a.get(key) === frame)
}

function clampToPage(view: PinView, at: Point, extent: Point): Point {
  const offset = view.source.kind === "agent" ? AGENT_CENTRE : { x: 0, y: 0 }
  const clamp = (value: number, max: number) => Math.min(value, max - PIN_REACH)
  return {
    x: clamp(at.x + offset.x, extent.x) - offset.x,
    y: clamp(at.y + offset.y, extent.y) - offset.y,
  }
}

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
  const frames = useRef<ReadonlyMap<string, Frame>>(new Map())
  const [, rerender] = useState(0)
  const views = useRef<PinView[]>([])
  const place = useRef<() => void>(() => {})
  const repick = useRef<NoteId | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const lostRef = useRef<HTMLDivElement>(null)
  const lostRect = useRef<DOMRect | null>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    let disposed = false
    let running = false
    let rerun = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let idle: number | null = null
    let frame = 0
    let lastStart = Number.NEGATIVE_INFINITY

    let full = false

    function placeAll(trackedOnly: boolean) {
      if (disposed || !model.prefs.peek().pinsVisible) return
      const all = views.current
      const byKey = new Map(all.map((view) => [view.key, view]))
      const moves = (key: string) => {
        const view = byKey.get(key)
        return view !== undefined && viewFrame(view, frames.current) !== "document"
      }
      const placing = trackedOnly
        ? all.filter((view) => viewFrame(view, frames.current) === "tracked")
        : all
      const links = all.filter(
        (view) => isLinked(view) && (!trackedOnly || moves(view.key) || moves(headKey(view))),
      )
      if (placing.length === 0 && links.length === 0) return

      const reading = new Map(placing.map((view) => [view.key, view]))
      for (const link of links) {
        reading.set(link.key, link)
        const head = byKey.get(headKey(link))
        if (head) reading.set(head.key, head)
      }
      const rects = new Map<string, { left: number; top: number; right: number } | null>()
      for (const view of reading.values()) {
        if (view.region) {
          const { x, y, width } = view.region
          rects.set(view.key, { left: x, top: y, right: x + width })
          continue
        }
        const el = elements.current.get(view.key)?.deref()
        const rect = el?.isConnected ? el.getBoundingClientRect() : null
        rects.set(view.key, rect && (rect.width > 0 || rect.height > 0) ? rect : null)
      }
      const scroll = { x: window.scrollX, y: window.scrollY }
      const extent = {
        x: document.documentElement.scrollWidth,
        y: document.documentElement.scrollHeight,
      }

      const placed = new Map<string, Point | null>()
      for (const view of reading.values()) {
        const rect = rects.get(view.key)
        if (!rect) {
          placed.set(view.key, null)
          continue
        }
        const offset = view.region ? { x: 0, y: 0 } : scroll
        const agent = view.source.kind === "agent"
        const sub = view.index > 0
        const at = {
          x: offset.x + (agent ? rect.right - 8 : rect.left + (sub ? 0 : 2)),
          y: offset.y + (agent ? rect.top + 6 : rect.top + (sub ? 0 : 2)),
        }
        const viewport = viewFrame(view, frames.current) === "viewport"
        placed.set(view.key, viewport ? at : clampToPage(view, at, extent))
      }

      for (const view of placing) {
        const node = nodes.current.get(view.key)
        if (!node) continue
        const at = placed.get(view.key)
        if (!at) {
          node.removeAttribute("data-placed")
          continue
        }
        node.setAttribute("data-placed", "")
        const viewport = viewFrame(view, frames.current) === "viewport"
        const x = viewport ? at.x - scroll.x : at.x
        const y = viewport ? at.y - scroll.y : at.y
        node.style.translate = `${x}px ${y}px`
      }
      for (const view of links) {
        const path = nodes.current.get(`link:${view.key}`)
        if (!path) continue
        const from = placed.get(headKey(view))
        const to = placed.get(view.key)
        if (!from || !to) {
          path.setAttribute("d", "")
          continue
        }
        const midX = (from.x + to.x) / 2
        const midY = Math.min(from.y, to.y) - 28
        path.setAttribute("d", `M${from.x} ${from.y} Q${midX} ${midY} ${to.x} ${to.y}`)
      }
    }

    function onFrame() {
      frame = 0
      const trackedOnly = !full
      full = false
      placeAll(trackedOnly)
    }

    function requestPlace() {
      full = true
      if (frame === 0 && !disposed) frame = requestAnimationFrame(onFrame)
    }

    function requestPlaceTracked() {
      if (frame === 0 && !disposed) frame = requestAnimationFrame(onFrame)
    }
    place.current = requestPlace

    async function pass() {
      running = true
      lastStart = performance.now()
      const sources = sourcesOf(model)
      const nextElements = new Map<string, WeakRef<Element>>()
      const nextAnchors = new Map<NoteId, AnchorResolution>()
      const nextFrames = new Map<string, Frame>()
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
            if (result.kind !== "anchored") return
            const key = `${source.kind}:${source.note.id}:${i}`
            nextElements.set(key, new WeakRef(result.el))
            nextFrames.set(key, frameOf(result.el))
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
      if (!sameFrames(frames.current, nextFrames)) {
        frames.current = nextFrames
        rerender((n) => n + 1)
      }
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
    const onScroll = () => requestPlaceTracked()
    const onResize = () => requestPlace()
    window.addEventListener("scroll", onScroll, { capture: true, passive: true })
    window.addEventListener("resize", onResize, { passive: true })

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
      window.removeEventListener("scroll", onScroll, { capture: true })
      window.removeEventListener("resize", onResize)
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
      // A fix usually rewrites the element it was about, so a resolved note losing its element is expected.
      if (note.resolution.status === "open") lost.push(source)
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

  const dismissed = model.lostDismissed.value
  const collapsed = lost.length > 0 && lost.every(({ note }) => dismissed.has(note.id))
  const hasLost = lost.length > 0
  const lostKey = lost.map(({ note }) => note.id).join("\n")
  const sheetOpen = model.sheet.value.open
  const dock = model.prefs.value.dock

  useEffect(() => {
    const held = model.lostDismissed.peek()
    const stillLost = new Set(lostKey === "" ? [] : lostKey.split("\n"))
    const kept = [...held].filter((id) => stillLost.has(id))
    if (kept.length !== held.size) model.lostDismissed.value = new Set(kept)
  }, [model, lostKey])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel's position and size follow the collapse state, the sheet, the dock side and its rows, so a change re-measures it
  useLayoutEffect(() => {
    lostRect.current = lostRef.current?.getBoundingClientRect() ?? null
  }, [collapsed, sheetOpen, dock, lostKey])

  useEffect(() => {
    if (!hasLost) return
    let frame = 0
    let at: Point | null = null
    let inside = false
    function settle() {
      frame = 0
      const rect = lostRect.current
      if (!at || !rect) return
      const slack = inside ? FADE_HYSTERESIS : 0
      inside =
        at.x >= rect.left - slack &&
        at.x <= rect.right + slack &&
        at.y >= rect.top - slack &&
        at.y <= rect.bottom + slack
      lostRef.current?.classList.toggle("away", inside)
    }
    const onMove = (event: PointerEvent) => {
      at = { x: event.clientX, y: event.clientY }
      if (frame === 0) frame = requestAnimationFrame(settle)
    }
    const onLeave = (event: PointerEvent) => {
      if (event.relatedTarget !== null) return
      at = null
      inside = false
      lostRef.current?.classList.remove("away")
    }
    const onResize = () => {
      lostRect.current = lostRef.current?.getBoundingClientRect() ?? null
    }
    window.addEventListener("pointermove", onMove, { capture: true, passive: true })
    window.addEventListener("pointerout", onLeave, { capture: true, passive: true })
    window.addEventListener("resize", onResize, { passive: true })
    return () => {
      window.removeEventListener("pointermove", onMove, { capture: true })
      window.removeEventListener("pointerout", onLeave, { capture: true })
      window.removeEventListener("resize", onResize)
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [hasLost])

  function bind(key: string) {
    let bound: HTMLElement | SVGElement | null = null
    return (node: HTMLElement | SVGElement | null) => {
      if (node) {
        bound = node
        nodes.current.set(key, node)
        return
      }
      // A pin that changes frame remounts in the other container, and the new node can bind
      // before the old one unbinds.
      if (nodes.current.get(key) === bound) nodes.current.delete(key)
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
  const moved = lost.filter(({ kind }) => kind !== "agent")
  const unanchored = lost.filter(({ kind }) => kind === "agent")

  if (pins.length === 0 && lost.length === 0) return null

  function pinButton(pin: PinView) {
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
    const sentRound =
      source.kind === "sent" ? model.rounds.value.find(({ id }) => id === source.round) : undefined
    const classes = [
      "pin",
      note.intent,
      source.kind === "sent" ? "sent" : "",
      sentRound && isBeingWorked(sentRound, note, model.pairing.value) ? "working" : "",
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
  }

  const inViewport = (pin: PinView) => viewFrame(pin, frames.current) === "viewport"

  return (
    <div class={pinsVisible ? "layer chrome pinlayer" : "layer chrome pinlayer off"}>
      <div class="docframe">
        <svg class="links" aria-hidden="true">
          {pins.map((pin) =>
            isLinked(pin) ? (
              <path
                key={pin.key}
                ref={bind(`link:${pin.key}`)}
                class={`${pin.source.note.intent} ${pin.source.kind === "sent" ? "sent" : ""}`}
              />
            ) : null,
          )}
        </svg>
        {pins.filter((pin) => !inViewport(pin)).map(pinButton)}
      </div>
      <div class="viewframe">{pins.filter(inViewport).map(pinButton)}</div>
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
              <span class="meta">{TIME.format(new Date(hovered.source.note.createdAt))}</span>
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
              <span class="meta">{targetLabel(hovered.source.note)}</span>
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
      {collapsed && (
        <button
          type="button"
          class={`pop on lost collapsed${sheetOpen ? " beside-sheet" : ""}`}
          data-v={dock[0]}
          data-h={dock[1] === "l" ? "l" : "r"}
          aria-expanded="false"
          onClick={() => {
            model.lostDismissed.value = new Set()
          }}
        >
          <Icon name="pick" size={14} />
          {lost.length} lost
        </button>
      )}
      {hasLost && !collapsed && (
        <div
          ref={lostRef}
          class={`pop on lost${sheetOpen ? " beside-sheet" : ""}`}
          data-v={dock[0]}
          data-h={dock[1] === "l" ? "l" : "r"}
        >
          <div class="lost-h">
            <h4>
              {lost.length === 1
                ? "1 note lost its element"
                : `${lost.length} notes lost their element`}
            </h4>
            <button
              type="button"
              class="iconbtn"
              aria-label="Hide"
              onClick={() => {
                model.lostDismissed.value = new Set(lost.map(({ note }) => note.id))
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
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
