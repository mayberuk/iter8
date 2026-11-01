import type {
  Box,
  Capture,
  ElementAnchor,
  NoteId,
  NoteTarget,
  ResolvedSourceLead,
} from "@iter8/protocol"
import { batch, computed, effect, untracked, useComputed } from "@preact/signals"
import type { JSX } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import { enrich, enrichPart } from "../enrich/run"
import { loadSourceLookup } from "../enrich/source"
import { type Mode, toDraftBody } from "../model"
import { findPart, PARTS, partTarget, refindPart, resolvePart } from "../parts"
import { parentAcrossShadow, resolveAnchor, resolveSelector } from "../pick/anchor"
import { identityOf, regionTarget, snapshotElement } from "../pick/snapshot"
import { Composer, shake } from "./Composer"
import { useOverlay, useSheet } from "./context"
import { omittedShotCopy, SHOT_READY } from "./Markup"
import pickCss from "./pick.css" with { type: "text" }

const ACTIVE: ReadonlySet<Mode> = new Set(["pick", "region", "compose"])
const SWALLOWED = ["mousedown", "mouseup", "click", "dblclick", "auxclick"] as const
const DRAG_PX = 6
const REGION_MIN_PX = 8
/** The sketch's lens spring: tracks a fast pointer without overshooting the target. */
const STIFFNESS = 560
const DAMPING = 36
/** Caps a step after a stalled frame, where a larger one would make the spring explode. */
const MAX_STEP_S = 0.05
/** Within this many pixels and pixels per second the ring snaps, so a settled lens stops writing. */
const SETTLE = 0.1
const EDGE = 12
const COMPOSER_GAP = 16
const CHIP_GAP = 14
/**
 * The chip's text waits for the hover to hold this long: each change repaints the page's root
 * layer (6 ms at 4x CPU on the heavy page), and a sweep there changes the hover every 50–80 ms.
 */
const CHIP_DWELL_MS = 120
const CLIMB_DEPTH = 4

type Rect = { x: number; y: number; w: number; h: number }
type Size = { w: number; h: number }
type Lead = ResolvedSourceLead | "pending" | null

type Run = {
  controller: AbortController
  target: NoteTarget
  before: ReadonlySet<NoteId>
  noteId: NoteId | null
  attach: boolean
  marked: boolean
  lastInput: number
  capture: Capture | null
}

/**
 * Where the composer goes beside its targets. While the round sheet is open and the composer fits
 * left of it, the sheet's resting edge bounds the composer; a viewport too narrow for that lets the
 * composer overlap the sheet, and the stacking order keeps it on top.
 */
export function composerSpot(input: {
  targets: readonly Rect[]
  panel: { w: number; h: number }
  viewport: { w: number; h: number }
  dock: { top: number; bottom: number; anchor: string } | null
  sheetLeft: number | null
}): { x: number; y: number; side: "left" | "right" } {
  const { targets, panel, viewport, dock, sheetLeft } = input
  const left = Math.min(...targets.map((r) => r.x))
  const top = Math.min(...targets.map((r) => r.y))
  const right = Math.max(...targets.map((r) => r.x + r.w))
  const bottom = Math.max(...targets.map((r) => r.y + r.h))
  const beside = sheetLeft !== null && sheetLeft - 2 * EDGE >= panel.w
  const limit = beside ? sheetLeft - EDGE : viewport.w - EDGE
  const floor = dock?.anchor.startsWith("b") ? dock.top - EDGE : viewport.h - EDGE
  const ceiling = dock?.anchor.startsWith("t") ? dock.bottom + EDGE : EDGE
  const fitsRight = right + COMPOSER_GAP + panel.w < limit
  const fitsLeft = left - COMPOSER_GAP - panel.w > EDGE
  let x: number
  let y = Math.min(Math.max(top, ceiling), floor - panel.h)
  let side: "left" | "right" = "left"
  if (fitsRight) x = right + COMPOSER_GAP
  else if (fitsLeft) {
    x = left - COMPOSER_GAP - panel.w
    if (beside) x = Math.min(x, limit - panel.w)
    side = "right"
  } else {
    x = Math.min(Math.max(left, EDGE), limit - panel.w)
    y = bottom + COMPOSER_GAP
    if (y + panel.h > floor) y = Math.max(ceiling, top - panel.h - COMPOSER_GAP)
  }
  return { x, y, side }
}

function viewRect(el: Element): Rect {
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

function boxRect(box: Box): Rect {
  return { x: box.x - window.scrollX, y: box.y - window.scrollY, w: box.width, h: box.height }
}

const HOLE_RADIUS = 6

function roundedPath({ x, y, w, h }: Rect, radius = HOLE_RADIUS): string {
  const k = Math.max(0, Math.min(radius, w / 2, h / 2))
  return `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`
}

function anchorsOf(target: NoteTarget): readonly ElementAnchor[] {
  switch (target.kind) {
    case "element":
      return [target.anchor]
    case "elements":
      return target.anchors
    case "region":
    case "iter8":
      return []
  }
}

function withoutScreenshot(capture: Capture): Capture {
  const { screenshot: _screenshot, ...rest } = capture
  return rest
}

/** A marked-up capture's screenshot is attached by the markup layer, which enrichment never sees. */
function keepMarkedShot(next: Capture, held: Capture | undefined): Capture {
  if (held?.screenshot) return { ...next, screenshot: held.screenshot }
  if (!held?.omittedParts.includes("screenshot") || next.omittedParts.includes("screenshot"))
    return next
  return {
    ...next,
    completeness: next.completeness === "complete" ? "partial" : next.completeness,
    omittedParts: [...next.omittedParts, "screenshot"],
  }
}

function tagOf(el: Element): string {
  const first = el.classList[0]
  return first ? `${el.localName}.${first}` : el.localName
}

function describe(el: Element, rect: Rect, root: ShadowRoot) {
  const found = root.contains(el) ? resolvePart(el) : null
  if (found) {
    return {
      tag: "iter8",
      dims: `${Math.round(rect.w)} × ${Math.round(rect.h)}`,
      name: PARTS[found.key].name,
      path: [PARTS[found.key].source],
      part: true,
    }
  }
  const { name, text } = identityOf(el)
  const path: Element[] = []
  for (
    let at: Element | null = el;
    at && at !== document.body && at !== document.documentElement && path.length < CLIMB_DEPTH;
    at = parentAcrossShadow(at)
  )
    path.unshift(at)
  return {
    tag: tagOf(el),
    dims: `${Math.round(rect.w)} × ${Math.round(rect.h)}`,
    name: name ?? text,
    path: path.map(tagOf),
    part: false,
  }
}

async function afterPaint(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await scheduler.yield()
}

export function PickLayer(): JSX.Element | null {
  useSheet(pickCss)
  const { model, connection, root, host, boot, errors, renderGeneration } = useOverlay()
  const layerRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<HTMLDivElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLDivElement>(null)
  const marksRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const markEls = useRef<Element[]>([])
  const picked = useRef<Element[]>([])
  const targets = useRef<(Element | null)[]>([])
  const run = useRef<Run | null>(null)
  const stored = useRef<Capture | undefined>(undefined)
  const lookup = useRef<ReturnType<typeof loadSourceLookup> | null>(null)
  const [info, setInfo] = useState<ReturnType<typeof describe> | null>(null)
  const [lead, setLead] = useState<Lead>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const [attach, setAttach] = useState(true)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const target = useComputed(() => model.composer.value?.target ?? null).value

  useEffect(() => {
    if (thumb === null) return
    return () => URL.revokeObjectURL(thumb)
  }, [thumb])

  useEffect(() => {
    const onReady = (event: Event) => {
      if (!(event instanceof CustomEvent) || !model.composer.peek()?.shot) return
      if (event.detail instanceof Blob) setThumb(URL.createObjectURL(event.detail))
    }
    root.addEventListener(SHOT_READY, onReady)
    return () => root.removeEventListener(SHOT_READY, onReady)
  }, [root, model])

  useEffect(() => {
    function deliver(current: Run) {
      const capture = current.capture
      if (!capture) return
      const applied = current.attach ? capture : withoutScreenshot(capture)
      if (current.noteId === null) {
        const open = model.composer.peek()
        if (open?.target === current.target)
          model.enrichmentDone(current.marked ? keepMarkedShot(applied, open.capture) : applied)
        return
      }
      const note = model.drafts.peek().find((draft) => draft.id === current.noteId)
      if (!note) return
      const body = toDraftBody(
        {
          intent: note.intent,
          body: note.body,
          target: note.target,
          anchorStatus: note.anchorStatus,
        },
        current.marked ? keepMarkedShot(applied, note.capture) : applied,
      )
      connection.putDraft(note.id, body)
      model.noteUpdated({ ...note, ...body })
    }

    function elementAt(box: Box): Element {
      const x = box.x - window.scrollX + box.width / 2
      const y = box.y - window.scrollY + box.height / 2
      return (
        document
          .elementsFromPoint(x, y)
          .find(
            (el) =>
              el !== host &&
              el !== document.body &&
              el !== document.documentElement &&
              !host.contains(el),
          ) ?? document.body
      )
    }

    async function enrichRun(current: Run, first: Element | null) {
      const { signal } = current.controller
      const shown = () => run.current === current
      try {
        await afterPaint()
        signal.throwIfAborted()
        if (current.target.kind === "iter8") {
          const { capture, shotOmitted } = await enrichPart(
            refindPart(root, current.target.part.key, first),
            {
              signal,
              uploadScreenshot: (png) => {
                if (shown()) setThumb(URL.createObjectURL(png))
                return connection.uploadScreenshot(png)
              },
              idleSinceInput: () => performance.now() - current.lastInput,
            },
          )
          current.capture = capture
          if (shown() && capture.screenshot === undefined) {
            setAttach(false)
            setUnavailable(omittedShotCopy(shotOmitted))
          }
          deliver(current)
          return
        }
        const el = current.target.kind === "region" ? elementAt(current.target.box) : first
        const anchor = anchorsOf(current.target)[0]
        if (!el) {
          if (shown()) setLead(null)
          return
        }
        lookup.current ??= loadSourceLookup(boot.sourceBundleUrl)
        const lookupSource = await lookup.current
        signal.throwIfAborted()
        const { capture, shotOmitted } = await enrich(
          { el, anchor: anchor ?? snapshotElement(el, renderGeneration()) },
          {
            signal,
            lookupSource,
            symbolicate: async (raw) => {
              const resolved = await connection.symbolicate(raw)
              if (shown()) setLead(resolved)
              return resolved
            },
            uploadScreenshot: (png) => {
              if (shown()) setThumb(URL.createObjectURL(png))
              return connection.uploadScreenshot(png)
            },
            errors,
            shot: !current.marked,
            ...(current.target.kind === "region"
              ? {
                  clip: new DOMRect(
                    current.target.box.x,
                    current.target.box.y,
                    current.target.box.width,
                    current.target.box.height,
                  ),
                }
              : {}),
            idleSinceInput: () => performance.now() - current.lastInput,
            exclude: host,
          },
        )
        current.capture = capture
        if (shown() && current.target.kind !== "region") setLead(capture.sourceLead ?? null)
        if (shown() && !current.marked && capture.screenshot === undefined) {
          setAttach(false)
          setUnavailable(omittedShotCopy(shotOmitted))
        }
        deliver(current)
      } catch {
        if (!signal.aborted && shown()) setLead(null)
      }
    }

    function start(composer: { target: NoteTarget; shot: object | null }) {
      const current: Run = {
        controller: new AbortController(),
        target: composer.target,
        before: new Set(model.draftOrder.peek()),
        noteId: null,
        attach: true,
        marked: composer.shot !== null,
        lastInput: performance.now(),
        capture: null,
      }
      run.current = current
      const candidates = [
        ...picked.current,
        ...[model.hover.peek(), ...model.multi.peek()].flatMap((ref) => ref?.deref() ?? []),
      ]
      picked.current = []
      targets.current =
        composer.target.kind === "iter8"
          ? [candidates.find((el) => root.contains(el)) ?? null]
          : anchorsOf(composer.target).map((anchor) => {
              const matches = resolveSelector(anchor.selector)
              return candidates.find((el) => matches.includes(el)) ?? matches[0] ?? null
            })
      setLead(
        composer.target.kind === "element" || composer.target.kind === "elements"
          ? "pending"
          : null,
      )
      setThumb(null)
      setAttach(true)
      setUnavailable(null)
      void enrichRun(current, targets.current[0] ?? null)
    }

    function showStored(composer: {
      target: NoteTarget
      editing: NoteId
      capture: Capture | undefined
    }) {
      const { editing, capture } = composer
      stored.current = capture
      targets.current =
        composer.target.kind === "iter8"
          ? [findPart(root, composer.target.part.key)]
          : anchorsOf(composer.target).map((anchor) => {
              const resolved = resolveAnchor(anchor)
              return resolved.kind === "anchored" ? resolved.el : null
            })
      setLead(
        composer.target.kind === "element" || composer.target.kind === "elements"
          ? (capture?.sourceLead ?? null)
          : null,
      )
      setThumb(null)
      setAttach(capture?.screenshot !== undefined)
      setUnavailable(capture?.omittedParts.includes("screenshot") ? "No screenshot taken" : null)
      const ref = capture?.screenshot?.ref
      if (ref === undefined) return
      connection
        .fetchScreenshot(ref)
        .then((blob) => {
          if (model.composer.peek()?.editing === editing) setThumb(URL.createObjectURL(blob))
        })
        .catch(() => {})
    }

    function bindSaved(current: Run) {
      run.current = null
      const id = model.draftOrder.peek().find((noteId) => !current.before.has(noteId))
      if (id === undefined) {
        current.controller.abort()
        return
      }
      current.noteId = id
      const note = model.drafts.peek().find((draft) => draft.id === id)
      if (current.capture && !note?.capture) deliver(current)
    }

    let previous = model.composer.peek()
    const stop = effect(() => {
      const composer = model.composer.value
      const was = previous
      previous = composer
      if (composer?.target === was?.target && composer?.editing === was?.editing) return
      untracked(() => {
        const current = run.current
        if (!composer && was?.saving && current?.target === was.target) bindSaved(current)
        else if (current) {
          current.controller.abort()
          run.current = null
        }
        stored.current = undefined
        if (!composer) {
          targets.current = []
          setLead(null)
          setThumb(null)
        } else if (composer.editing) showStored({ ...composer, editing: composer.editing })
        else start(composer)
      })
    })
    return () => {
      stop()
      run.current?.controller.abort()
      run.current = null
    }
  }, [model, connection, host, boot, errors, renderGeneration, root])

  useEffect(() => {
    const ring = ringRef.current
    const veil = veilRef.current
    const layer = layerRef.current
    if (!ring || !veil) return
    const reduced = matchMedia("(prefers-reduced-motion: reduce)")

    function attach(): () => void {
      let drag: {
        x0: number
        y0: number
        shift: boolean
        raw: Element | null
        rect: Rect | null
      } | null = null
      let pending: { raw: Element | null } | null = null
      let pointer: { x: number; y: number } | null = null
      let lastRaw: Element | null = null
      let alt = false
      let partGesture = false
      let partDown: Element | null = null
      let spring: { cur: Rect; vel: Rect } | null = null
      let candidate: Element | null = null
      let candidateSince = 0
      let described: Element | null = null
      let describedAt = 0
      let lastTime = 0
      let frame = 0
      const written = new Map<Element, string>()

      function write(el: Element & ElementCSSInlineStyle, css: string) {
        if (written.get(el) === css) return
        written.set(el, css)
        el.style.cssText = css
      }

      function setClass(el: Element, name: string) {
        if (el.className !== name) el.className = name
      }

      function usable(node: EventTarget | undefined): Element | null {
        if (!(node instanceof Element)) return null
        if (node === host || node === document.body || node === document.documentElement)
          return null
        return host.contains(node) ? null : node
      }

      function ours(event: Event): boolean {
        return event.composedPath().includes(host)
      }

      function partAt(node: EventTarget | null | undefined) {
        return node instanceof Element && root.contains(node) ? resolvePart(node) : null
      }

      function setAlt(next: boolean) {
        if (alt === next) return
        alt = next
        lastRaw = null
        pending = { raw: null }
        if (next || model.mode.peek() !== "pick") return
        const held = model.hover.peek()?.deref()
        if (held && root.contains(held))
          batch(() => {
            model.hover.value = null
            model.climbStack.value = []
          })
      }

      function onModifier(event: KeyboardEvent) {
        if (event.key === "Alt") setAlt(event.type === "keydown")
      }

      function onBlur(event: FocusEvent) {
        if (event.target === window) setAlt(false)
      }

      function swallow(event: Event) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }

      function onSwallowed(event: Event) {
        if (!ours(event) || partGesture) swallow(event)
      }

      function onMove(event: PointerEvent) {
        pointer = { x: event.clientX, y: event.clientY }
        setAlt(event.altKey)
        if (drag) {
          const moved =
            drag.rect !== null ||
            Math.hypot(event.clientX - drag.x0, event.clientY - drag.y0) > DRAG_PX
          if (!moved) return
          drag.rect = {
            x: Math.min(drag.x0, event.clientX),
            y: Math.min(drag.y0, event.clientY),
            w: Math.abs(event.clientX - drag.x0),
            h: Math.abs(event.clientY - drag.y0),
          }
          return
        }
        if (ours(event)) {
          if (alt) pending = { raw: null }
          return
        }
        pending = { raw: usable(event.composedPath()[0]) }
      }

      function onScroll() {
        if (pointer && !drag) pending = { raw: null }
      }

      /**
       * Keeps the rest of a gesture that dismissed the composer from reaching the page, after the
       * mode change has already removed the regular listeners. One listener does both jobs: a
       * second one registered after the blocker would never run, because the blocker stops
       * propagation on the same target.
       */
      function swallowRestOfGesture() {
        const types = ["pointerup", "pointerdown", "pointercancel", ...SWALLOWED] as const
        const release = () => {
          for (const type of types) window.removeEventListener(type, hold, true)
        }
        function hold(event: Event) {
          if (event.type === "pointerdown" || event.type === "pointercancel") {
            release()
            return
          }
          onSwallowed(event)
          if (event.type === "pointerup") setTimeout(release)
        }
        for (const type of types) window.addEventListener(type, hold, true)
      }

      function onDown(event: PointerEvent) {
        setAlt(event.altKey)
        partGesture = false
        if (ours(event)) {
          if (!alt || event.button !== 0 || model.mode.peek() !== "pick") return
          partGesture = true
          partDown = partAt(event.composedPath()[0])?.el ?? null
          swallow(event)
          return
        }
        swallow(event)
        if (event.button !== 0) return
        if (alt && model.mode.peek() === "pick") return
        if (model.mode.peek() === "compose") {
          const composer = model.composer.peek()
          if (composer && composer.body.trim() === "" && !composer.saving) {
            swallowRestOfGesture()
            model.setMode("idle")
          } else shake(panelRef.current)
          return
        }
        drag = {
          x0: event.clientX,
          y0: event.clientY,
          shift: event.shiftKey,
          raw: usable(event.composedPath()[0]),
          rect: null,
        }
      }

      function openPart(found: NonNullable<ReturnType<typeof partAt>>) {
        picked.current = [found.el]
        batch(() => {
          model.hover.value = new WeakRef(found.el)
          model.climbStack.value = []
        })
        model.openComposer({ target: partTarget(found, model.serviceVersion.peek()) })
      }

      function onUp(event: PointerEvent) {
        if (partGesture) setTimeout(() => (partGesture = false))
        if (ours(event)) {
          if (!partGesture) return
          swallow(event)
          const found = partAt(event.composedPath()[0])
          if (found && found.el === partDown && model.mode.peek() === "pick") openPart(found)
          partDown = null
          return
        }
        swallow(event)
        const done = drag
        drag = null
        if (!done) return
        const mode = model.mode.peek()
        if (done.rect) {
          const { x, y, w, h } = done.rect
          if (w < REGION_MIN_PX || h < REGION_MIN_PX) return
          if (mode === "pick" || mode === "region")
            model.openComposer({ target: regionTarget(new DOMRect(x, y, w, h)) })
          return
        }
        if (mode !== "pick") return
        const fresh = done.raw !== null && done.raw !== lastRaw
        const el = fresh ? done.raw : (model.hover.peek()?.deref() ?? done.raw)
        if (!el) return
        if (fresh) {
          lastRaw = el
          batch(() => {
            model.hover.value = new WeakRef(el)
            model.climbStack.value = []
          })
        }
        const multi = model.multi.peek().flatMap((ref) => ref.deref() ?? [])
        if (done.shift) {
          model.multi.value = multi.includes(el)
            ? multi.filter((at) => at !== el).map((at) => new WeakRef(at))
            : [...multi, el].map((at) => new WeakRef(at))
          return
        }
        const chosen = multi.length === 0 ? [el] : multi.includes(el) ? multi : [...multi, el]
        picked.current = chosen
        const generation = renderGeneration()
        const [only, ...more] = chosen.map((at) => snapshotElement(at, generation))
        if (!only) return
        model.openComposer({
          target:
            more.length === 0
              ? { kind: "element", anchor: only }
              : { kind: "elements", anchors: [only, ...more] },
        })
      }

      function hoverFromPointer() {
        const next = pending
        pending = null
        if (!next || drag || model.mode.peek() !== "pick") return
        if (alt) {
          const hit = pointer ? root.elementFromPoint(pointer.x, pointer.y) : null
          const el = (hit && resolvePart(hit)?.el) ?? null
          if (el === (model.hover.peek()?.deref() ?? null)) return
          batch(() => {
            model.hover.value = el ? new WeakRef(el) : null
            model.climbStack.value = []
          })
          return
        }
        const raw =
          next.raw ??
          (pointer ? usable(document.elementFromPoint(pointer.x, pointer.y) ?? undefined) : null)
        if (!raw || raw === lastRaw) return
        lastRaw = raw
        batch(() => {
          model.hover.value = new WeakRef(raw)
          model.climbStack.value = []
        })
      }

      function lens(): {
        rect: Rect
        region: boolean
        tags: boolean
        el?: Element
        inside?: boolean
      } | null {
        if (drag?.rect) return { rect: drag.rect, region: true, tags: true }
        const mode = model.mode.peek()
        if (mode === "pick") {
          const el = model.hover.peek()?.deref()
          return el?.isConnected
            ? { rect: viewRect(el), region: false, tags: true, el, inside: root.contains(el) }
            : null
        }
        if (mode !== "compose") return null
        const composer = model.composer.peek()
        if (composer?.target.kind === "region")
          return { rect: boxRect(composer.target.box), region: true, tags: true }
        const el = targets.current[0]
        return el?.isConnected
          ? { rect: viewRect(el), region: false, tags: false, inside: root.contains(el) }
          : null
      }

      function step(target: Rect, dt: number, snap: boolean): Rect {
        if (!spring || snap) {
          spring = { cur: { ...target }, vel: { x: 0, y: 0, w: 0, h: 0 } }
          return spring.cur
        }
        const { cur, vel } = spring
        let settled = true
        for (const key of ["x", "y", "w", "h"] as const) {
          vel[key] += (STIFFNESS * (target[key] - cur[key]) - DAMPING * vel[key]) * dt
          cur[key] += vel[key] * dt
          if (Math.abs(target[key] - cur[key]) > SETTLE || Math.abs(vel[key]) > SETTLE)
            settled = false
        }
        if (settled) spring = { cur: { ...target }, vel: { x: 0, y: 0, w: 0, h: 0 } }
        return spring.cur
      }

      function placeChip(chip: HTMLDivElement, around: Rect, { w: width, h: height }: Size) {
        const x = Math.min(Math.max(around.x, EDGE), window.innerWidth - width - EDGE)
        let y = around.y + around.h + CHIP_GAP
        if (y + height > window.innerHeight - EDGE) y = around.y - height - 2 * CHIP_GAP
        if (y < EDGE)
          y = Math.min(Math.max(around.y + CHIP_GAP, EDGE), window.innerHeight - height - EDGE)
        write(chip, `transform:translate(${Math.round(x)}px,${Math.round(y)}px)`)
      }

      /**
       * Bands around the hole and fillets in its corners, moved only by transform: rewriting a
       * clip-path every frame repaints the whole viewport, and the page with it.
       */
      function cutHole(veil: HTMLDivElement, hole: Rect | null) {
        const [top, bottom, left, right, tl, tr, bl, br] = veil.querySelectorAll<HTMLElement>("i")
        if (!(top && bottom && left && right && tl && tr && bl && br)) return
        const width = window.innerWidth
        const height = window.innerHeight
        const x0 = hole ? Math.round(hole.x) : width
        const y0 = hole ? Math.round(hole.y) : height
        const x1 = hole ? Math.max(x0, Math.round(hole.x + hole.w)) : width
        const y1 = hole ? Math.max(y0, Math.round(hole.y + hole.h)) : height
        const sy = (y1 - y0) / height
        const k = Math.min(HOLE_RADIUS, (x1 - x0) / 2, (y1 - y0) / 2)
        const corner = `scale(${k / HOLE_RADIUS})`
        write(top, `transform:translate(0px,${y0 - height}px)`)
        write(bottom, `transform:translate(0px,${y1}px)`)
        write(left, `transform:translate(${x0 - width}px,${y0}px) scale(1,${sy})`)
        write(right, `transform:translate(${x1}px,${y0}px) scale(1,${sy})`)
        write(tl, `transform:translate(${x0}px,${y0}px) ${corner}`)
        write(tr, `transform:translate(${x1 - k}px,${y0}px) ${corner}`)
        write(bl, `transform:translate(${x0}px,${y1 - k}px) ${corner}`)
        write(br, `transform:translate(${x1 - k}px,${y1 - k}px) ${corner}`)
      }

      function measureComposer(panel: HTMLDivElement) {
        const composer = model.composer.peek()
        if (!composer) return null
        const rects =
          composer.target.kind === "region"
            ? [boxRect(composer.target.box)]
            : targets.current.flatMap((el) => (el?.isConnected ? [viewRect(el)] : []))
        if (rects.length === 0 && composer.target.kind === "iter8") {
          const { x, y, width, height } = composer.target.box
          rects.push({ x, y, w: width, h: height })
        }
        if (rects.length === 0) return null
        const { collapsed } = model.prefs.peek()
        const anchor = model.dockAnchor.peek()
        const dockBox = root
          .querySelector(collapsed ? ".iter8btn" : ".dock")
          ?.getBoundingClientRect()
        const sheet = model.sheet.peek().open ? root.querySelector<HTMLElement>(".sheet") : null
        return composerSpot({
          targets: rects,
          panel: { w: panel.offsetWidth, h: panel.offsetHeight },
          viewport: { w: window.innerWidth, h: window.innerHeight },
          dock: dockBox ? { top: dockBox.top, bottom: dockBox.bottom, anchor } : null,
          sheetLeft: sheet ? sheet.offsetLeft : null,
        })
      }

      /** Every layout read comes before the first style write, so no read in a frame forces layout. */
      function tick(time: number) {
        frame = requestAnimationFrame(tick)
        const dt = lastTime === 0 ? 1 / 60 : Math.min(MAX_STEP_S, (time - lastTime) / 1000)
        lastTime = time
        hoverFromPointer()
        const target = lens()
        const marks = markEls.current
        const markRects = marks.map((el) => (el.isConnected ? viewRect(el) : null))
        const chip = chipRef.current
        const chipSize = chip && described ? { w: chip.offsetWidth, h: chip.offsetHeight } : null
        const panel = panelRef.current
        const spot = panel ? measureComposer(panel) : null
        const hovered = target?.el ?? null
        if (layer) setClass(layer, target?.inside ? "layer pick over" : "layer pick")
        if (hovered !== candidate) {
          candidate = hovered
          candidateSince = time
        }
        if (hovered !== described && (!hovered || time - candidateSince >= CHIP_DWELL_MS)) {
          described = hovered
          describedAt = time
          setInfo(hovered && target ? describe(hovered, target.rect, root) : null)
        }

        let hole: Rect | null = null
        if (target && ring) {
          const shown = ring.classList.contains("on")
          const cur = step(target.rect, dt, reduced.matches || target.region || !shown)
          hole = cur
          write(
            ring,
            `transform:translate(${cur.x.toFixed(1)}px,${cur.y.toFixed(1)}px);width:${Math.max(0, cur.w).toFixed(1)}px;height:${Math.max(0, cur.h).toFixed(1)}px`,
          )
          setClass(ring, `ring on${target.region ? " region" : ""}${target.tags ? "" : " notags"}`)
          const [wtag, htag] = ring.querySelectorAll("span")
          const w = String(Math.round(target.rect.w))
          const h = String(Math.round(target.rect.h))
          if (wtag && wtag.textContent !== w) wtag.textContent = w
          if (htag && htag.textContent !== h) htag.textContent = h
          if (chip && chipSize) placeChip(chip, cur, chipSize)
        } else if (ring) {
          spring = null
          setClass(ring, "ring")
        }
        if (chip) {
          const fresh = described !== null && described === hovered && describedAt < time
          setClass(chip, fresh ? "chip on" : "chip")
        }

        const mode = model.mode.peek()
        const veilOn = target !== null || mode === "region"
        if (veil) {
          setClass(veil, veilOn ? "veil on" : "veil")
          if (veilOn) {
            const markHoles = markRects.flatMap((r) => (r ? [roundedPath(r)] : []))
            write(
              veil,
              markHoles.length === 0
                ? ""
                : `clip-path:path(evenodd,"M0 0H${window.innerWidth}V${window.innerHeight}H0Z ${markHoles.join(" ")}")`,
            )
            cutHole(veil, hole)
          }
        }
        const nodes = marksRef.current?.children ?? []
        markRects.forEach((r, i) => {
          const node = nodes[i]
          if (!(node instanceof HTMLElement) || !r) return
          write(
            node,
            `transform:translate(${r.x.toFixed(1)}px,${r.y.toFixed(1)}px);width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px`,
          )
        })
        if (panel && spot)
          write(
            panel,
            `translate:${Math.round(spot.x)}px ${Math.round(spot.y)}px;--ox:${spot.side}`,
          )
      }

      window.addEventListener("keydown", onModifier, { capture: true, passive: true })
      window.addEventListener("keyup", onModifier, { capture: true, passive: true })
      window.addEventListener("blur", onBlur, { capture: true, passive: true })
      window.addEventListener("pointermove", onMove, { capture: true, passive: true })
      window.addEventListener("scroll", onScroll, { capture: true, passive: true })
      window.addEventListener("pointerdown", onDown, { capture: true })
      window.addEventListener("pointerup", onUp, { capture: true })
      for (const type of SWALLOWED) window.addEventListener(type, onSwallowed, { capture: true })
      frame = requestAnimationFrame(tick)

      return () => {
        window.removeEventListener("keydown", onModifier, { capture: true })
        window.removeEventListener("keyup", onModifier, { capture: true })
        window.removeEventListener("blur", onBlur, { capture: true })
        window.removeEventListener("pointermove", onMove, { capture: true })
        window.removeEventListener("scroll", onScroll, { capture: true })
        window.removeEventListener("pointerdown", onDown, { capture: true })
        window.removeEventListener("pointerup", onUp, { capture: true })
        for (const type of SWALLOWED)
          window.removeEventListener(type, onSwallowed, { capture: true })
        cancelAnimationFrame(frame)
        if (ring) setClass(ring, "ring")
        if (layer) setClass(layer, "layer pick")
        if (veil) setClass(veil, "veil")
        if (chipRef.current) setClass(chipRef.current, "chip")
        setInfo(null)
      }
    }

    const active = computed(() => ACTIVE.has(model.mode.value))
    return effect(() => {
      if (active.value) return untracked(attach)
    })
  }, [model, root, host, renderGeneration])

  const mode = model.mode.value
  const multi = model.multi.value.flatMap((ref) => ref.deref() ?? [])
  const marks =
    mode === "pick"
      ? multi
      : mode === "compose"
        ? targets.current.slice(1).flatMap((el) => el ?? [])
        : []
  markEls.current = marks

  function onAttach(on: boolean) {
    setAttach(on)
    const current = run.current
    if (current) {
      current.attach = on
      if (!current.capture) return
      const composer = model.composer.peek()
      if (composer)
        model.composer.value = {
          ...composer,
          capture: on ? current.capture : withoutScreenshot(current.capture),
        }
      return
    }
    const composer = model.composer.peek()
    const capture = stored.current
    if (composer?.editing && capture)
      model.composer.value = { ...composer, capture: on ? capture : withoutScreenshot(capture) }
  }

  function onInput() {
    if (run.current) run.current.lastInput = performance.now()
  }

  return (
    <>
      <div ref={layerRef} class="layer pick">
        <div ref={veilRef} class="veil">
          <i />
          <i />
          <i />
          <i />
          <i class="tl" />
          <i class="tr" />
          <i class="bl" />
          <i class="br" />
        </div>
        <div ref={marksRef}>
          {marks.map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: marks are numbered by position
            <div key={i} class="mark">
              {mode === "pick" && <b>{i + 1}</b>}
            </div>
          ))}
        </div>
        <div ref={ringRef} class="ring">
          <i />
          <i />
          <i />
          <i />
          <span class="wtag" />
          <span class="htag" />
        </div>
        <div
          ref={chipRef}
          class="chip"
          role="status"
          aria-live="polite"
          aria-hidden={info ? undefined : "true"}
        >
          {info && (
            <>
              <div class="c1">
                <span class="comp tag">{info.tag}</span>
                <span class="dim">{info.dims}</span>
              </div>
              <div class="nm">{info.name ? `“${info.name}”` : "—"}</div>
              <div class="path">
                {info.path.map((label, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ancestors are listed by depth
                  <span key={i}>
                    {i > 0 && <i>›</i>}
                    {i === info.path.length - 1 ? <strong>{label}</strong> : <span>{label}</span>}
                  </span>
                ))}
              </div>
              {info.part ? (
                <div class="hints">
                  <span>click for a note about iter8</span>
                  <span>
                    release <kbd>⌥</kbd> for the page
                  </span>
                </div>
              ) : (
                <>
                  <div class="hints">
                    {multi.length > 0 ? (
                      <>
                        <span class="count">{multi.length} selected</span>
                        <span>click adds and opens</span>
                      </>
                    ) : (
                      <>
                        <span>
                          <kbd>↑</kbd>
                          <kbd>↓</kbd> climb
                        </span>
                        <span>
                          <kbd>⇧</kbd> click to add
                        </span>
                        <span>drag for region</span>
                        <span>
                          <kbd>↵</kbd> note
                        </span>
                      </>
                    )}
                  </div>
                  <div class="hints">
                    <span>
                      hold <kbd>⌥</kbd> to pick iter8 itself
                    </span>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div class="layer typing">
        {target && (
          <Composer
            panelRef={panelRef}
            lead={lead}
            thumb={thumb}
            attach={attach}
            unavailable={unavailable}
            onAttach={onAttach}
            onInput={onInput}
          />
        )}
      </div>
    </>
  )
}
