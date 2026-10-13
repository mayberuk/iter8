import type { Box, Capture, NoteId, Screenshot, Theme } from "@iter8/protocol"
import { batch, type Signal, useSignal, useSignalEffect } from "@preact/signals"
import type { JSX } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { captureRegion } from "../enrich/crop"
import { type MarkupTool, type Shape, toDraftBody } from "../model"
import { regionTarget } from "../pick/snapshot"
import { useOverlay, useSheet } from "./context"
import { Icon } from "./glyphs"
import markupCss from "./markup.css" with { type: "text" }

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? "⌘" : "Ctrl"

const DRAG_START = 6
const MIN_REGION = 8
const MIN_SHAPE = 4
const ARROW_WIDTH = 3
const BOX_WIDTH = 2.5
const HIGHLIGHT_ALPHA = 0.32
/** The arrowhead is the sketch's 10-unit marker drawn at five times the stroke width. */
const HEAD_BACK = 10.5
const HEAD_FRONT = 4.5
const HEAD_HALF = 7.5

/** `captureRegion` words these omissions as caps; any other reason is a failed render. */
const CAP_COPY = new Map([
  ["too-large", "This area is too large to capture — try a smaller region"],
  ["too-many-nodes", "This part of the page is too heavy to capture"],
  ["over 2 MiB", "This capture is too big to keep — try a smaller region"],
])

const FAILED_COPY = "Couldn’t capture this area — try again"

const TOOLS = [
  { tool: "arrow", label: "Arrow", key: "A" },
  { tool: "box", label: "Box", key: "B" },
  { tool: "hl", label: "Highlight", key: "H" },
] as const satisfies readonly { tool: MarkupTool; label: string; key: string }[]

type Crop = Awaited<ReturnType<typeof captureRegion>>

type Held = {
  region: Box
  controller: AbortController
  result: Promise<Crop>
  colors: { arrow: string; hl: string }
  background: string
  url: string | null
  flat: Promise<Blob | null> | null
  before: ReadonlySet<NoteId> | null
  noteId: NoteId | null
  uploading: boolean
  outcome: Screenshot | "omitted" | null
}

/** Fired on the shadow root with the flattened PNG (or null) once a marked-up composer can show it. */
export const SHOT_READY = "iter8-shot-ready"

type View =
  | { status: "capturing" }
  | { status: "ready"; url: string; width: number; height: number; background: string }
  | { status: "omitted"; region: Box; message: string }

function useEntered(): boolean {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return entered
}

function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const color = getComputedStyle(el).backgroundColor
    if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color
  }
  return "#fff"
}

function pageTheme(): Theme {
  const scheme = getComputedStyle(document.documentElement).colorScheme.split(/\s+/)
  const dark = scheme.includes("dark")
  if (dark !== scheme.includes("light")) return dark ? "dark" : "light"
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function drawShape(pen: CanvasRenderingContext2D, shape: Shape, colors: Held["colors"]) {
  const x = Math.min(shape.x1, shape.x2)
  const y = Math.min(shape.y1, shape.y2)
  const width = Math.abs(shape.x2 - shape.x1)
  const height = Math.abs(shape.y2 - shape.y1)
  if (shape.tool === "arrow") {
    pen.strokeStyle = colors.arrow
    pen.fillStyle = colors.arrow
    pen.lineWidth = ARROW_WIDTH
    pen.lineCap = "round"
    pen.beginPath()
    pen.moveTo(shape.x1, shape.y1)
    pen.lineTo(shape.x2, shape.y2)
    pen.stroke()
    pen.save()
    pen.translate(shape.x2, shape.y2)
    pen.rotate(Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1))
    pen.beginPath()
    pen.moveTo(-HEAD_BACK, -HEAD_HALF)
    pen.lineTo(HEAD_FRONT, 0)
    pen.lineTo(-HEAD_BACK, HEAD_HALF)
    pen.closePath()
    pen.fill()
    pen.restore()
  } else if (shape.tool === "box") {
    pen.strokeStyle = colors.arrow
    pen.lineWidth = BOX_WIDTH
    pen.beginPath()
    pen.roundRect(x, y, width, height, 4)
    pen.stroke()
  } else {
    pen.globalAlpha = HIGHLIGHT_ALPHA
    pen.fillStyle = colors.hl
    pen.beginPath()
    pen.roundRect(x, y, width, height, 2)
    pen.fill()
    pen.globalAlpha = 1
  }
}

async function flatten(
  png: Blob,
  region: Box,
  held: Pick<Held, "colors" | "background">,
  shapes: readonly Shape[],
): Promise<Blob> {
  const bitmap = await createImageBitmap(png)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const pen = canvas.getContext("2d")
  if (pen === null) throw new Error("no 2d canvas")
  pen.fillStyle = held.background
  pen.fillRect(0, 0, canvas.width, canvas.height)
  pen.drawImage(bitmap, 0, 0)
  bitmap.close()
  pen.scale(canvas.width / region.width, canvas.height / region.height)
  for (const shape of shapes) drawShape(pen, shape, held.colors)
  const flat = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
  if (flat === null) throw new Error("encode failed")
  return flat
}

function withOutcome(
  capture: Capture | undefined,
  outcome: Screenshot | "omitted",
  errors: Capture["consoleErrors"],
): Capture {
  const base: Capture = capture ?? {
    completeness: "partial",
    omittedParts: ["landmark", "surroundingText", "computedStyles", "sourceLead"],
    url: location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    theme: pageTheme(),
    ...(errors === undefined ? {} : { consoleErrors: errors }),
  }
  if (outcome !== "omitted") return { ...base, screenshot: outcome }
  return {
    ...base,
    completeness: base.completeness === "complete" ? "partial" : base.completeness,
    omittedParts: [...base.omittedParts, "screenshot"],
  }
}

const SWALLOWED = ["mousedown", "mouseup", "click", "dblclick", "auxclick"] as const
const SELECTION_EDGE = 1.5
/** Wide enough for "9999 × 9999" in the badge's font. */
const BADGE_WIDTH = 100
const BADGE_HEIGHT = 20
const BADGE_PILL = 17
const BADGE_PAD = 5

function ShotLayer(): JSX.Element {
  const { model, host } = useOverlay()
  const entered = useEntered()
  const layer = useRef<HTMLDivElement>(null)
  const horizontal = useRef<HTMLDivElement>(null)
  const vertical = useRef<HTMLDivElement>(null)
  const badge = useRef<HTMLCanvasElement>(null)
  const selection = useRef<HTMLDivElement>(null)
  const ratio = window.devicePixelRatio || 1

  // The layer is driven from window capture listeners rather than its own handlers: an event
  // delivered to the layer would first pass the page's capture-phase handlers on document.
  // Layout timing, so the listeners exist by the time the layer is first painted.
  useLayoutEffect(() => {
    const surface = layer.current
    if (!surface) return
    let drag: { x0: number; y0: number; moved: boolean } | null = null
    let point: { x: number; y: number } | null = null
    let frame = 0
    let ink: { fill: string; shadow: string; text: string; font: string } | null = null

    function overlayControl(event: Event): boolean {
      const path = event.composedPath()
      const first = path[0]
      return path.includes(host) && !(first instanceof Node && surface?.contains(first))
    }

    function claims(event: Event): boolean {
      if (drag === null && overlayControl(event)) return false
      event.preventDefault()
      event.stopImmediatePropagation()
      return true
    }

    function rectTo(x: number, y: number) {
      if (!drag) return null
      return {
        x: Math.min(drag.x0, x),
        y: Math.min(drag.y0, y),
        width: Math.abs(x - drag.x0),
        height: Math.abs(y - drag.y0),
      }
    }

    function hideSelection() {
      if (selection.current) selection.current.style.visibility = "hidden"
    }

    function placeSelection(box: HTMLElement, r: NonNullable<ReturnType<typeof rectTo>>) {
      const parts = [
        [r.x, r.y, r.width, r.height],
        [r.x, r.y, r.width, SELECTION_EDGE],
        [r.x + r.width - SELECTION_EDGE, r.y, SELECTION_EDGE, r.height],
        [r.x, r.y + r.height - SELECTION_EDGE, r.width, SELECTION_EDGE],
        [r.x, r.y, SELECTION_EDGE, r.height],
      ]
      parts.forEach(([x, y, width, height], i) => {
        const part = box.children[i]
        if (!(part instanceof HTMLElement)) return
        part.style.translate = `${x}px ${y}px`
        part.style.scale = `${width} ${height}`
      })
      box.style.visibility = "visible"
    }

    // Drawn rather than set as text: a text change lays out the page on every pointer move.
    function drawBadge(canvas: HTMLCanvasElement, text: string) {
      const context = canvas.getContext("2d")
      if (!context) return
      if (!ink) {
        const style = getComputedStyle(canvas)
        ink = {
          fill: style.getPropertyValue("--cobalt").trim(),
          shadow: style.getPropertyValue("--cobalt-d").trim(),
          text: style.color,
          font: style.font,
        }
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, BADGE_WIDTH, BADGE_HEIGHT)
      context.font = ink.font
      const width = Math.min(
        BADGE_WIDTH,
        Math.ceil(context.measureText(text).width) + BADGE_PAD * 2,
      )
      context.fillStyle = ink.shadow
      context.beginPath()
      context.roundRect(0, 2, width, BADGE_PILL, 4)
      context.fill()
      context.fillStyle = ink.fill
      context.beginPath()
      context.roundRect(0, 0, width, BADGE_PILL, 4)
      context.fill()
      context.fillStyle = ink.text
      context.textBaseline = "middle"
      context.fillText(text, BADGE_PAD, BADGE_PILL / 2)
    }

    function paint() {
      frame = 0
      if (!point) return
      const { x, y } = point
      if (horizontal.current) horizontal.current.style.translate = `0 ${y}px`
      if (vertical.current) vertical.current.style.translate = `${x}px 0`
      const rect = drag?.moved ? rectTo(x, y) : null
      if (badge.current) {
        badge.current.style.visibility = "visible"
        badge.current.style.translate = `${x + 12}px ${y + 12}px`
        drawBadge(
          badge.current,
          rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}` : `${x}, ${y}`,
        )
      }
      if (selection.current && rect) placeSelection(selection.current, rect)
    }

    function onMove(event: PointerEvent) {
      if (drag === null && overlayControl(event)) return
      const { clientX, clientY } = event
      point = { x: clientX, y: clientY }
      if (drag && !drag.moved && Math.hypot(clientX - drag.x0, clientY - drag.y0) > DRAG_START)
        drag.moved = true
      if (!frame) frame = requestAnimationFrame(paint)
    }

    function onDown(event: PointerEvent) {
      if (!claims(event) || event.button !== 0) return
      drag = { x0: event.clientX, y0: event.clientY, moved: false }
    }

    function onUp(event: PointerEvent) {
      if (!claims(event)) return
      const moved = drag?.moved
      const region = rectTo(event.clientX, event.clientY)
      drag = null
      hideSelection()
      if (!moved || !region || region.width <= MIN_REGION || region.height <= MIN_REGION) return
      batch(() => {
        model.setMode("markup")
        model.markup.value = { region, tool: "arrow", shapes: [] }
      })
    }

    function onCancel() {
      drag = null
      hideSelection()
    }

    function onOther(event: Event) {
      claims(event)
    }

    window.addEventListener("pointermove", onMove, { capture: true, passive: true })
    window.addEventListener("pointerdown", onDown, { capture: true })
    window.addEventListener("pointerup", onUp, { capture: true })
    window.addEventListener("pointercancel", onCancel, { capture: true, passive: true })
    for (const type of SWALLOWED) window.addEventListener(type, onOther, { capture: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove, { capture: true })
      window.removeEventListener("pointerdown", onDown, { capture: true })
      window.removeEventListener("pointerup", onUp, { capture: true })
      window.removeEventListener("pointercancel", onCancel, { capture: true })
      for (const type of SWALLOWED) window.removeEventListener(type, onOther, { capture: true })
    }
  }, [model, host, ratio])

  return (
    <div class={entered ? "layer shotlayer on" : "layer shotlayer"} ref={layer}>
      <div class="xh h" ref={horizontal} />
      <div class="xh v" ref={vertical} />
      <div class="xsel" ref={selection}>
        <i class="fill" />
        <i />
        <i />
        <i />
        <i />
      </div>
      <canvas
        class="coords"
        ref={badge}
        width={BADGE_WIDTH * ratio}
        height={BADGE_HEIGHT * ratio}
        style={{ width: `${BADGE_WIDTH}px`, height: `${BADGE_HEIGHT}px` }}
      />
      <div class="hintbar">
        <span>
          <Icon name="shot" size={14} /> Drag a region
        </span>
        <i class="sep" />
        <span>
          <kbd>↵</kbd> full viewport
        </span>
        <i class="sep" />
        <span>
          <kbd>Esc</kbd> cancel
        </span>
      </div>
    </div>
  )
}

function ShapeMark({ shape }: { shape: Shape }): JSX.Element {
  const x = Math.min(shape.x1, shape.x2)
  const y = Math.min(shape.y1, shape.y2)
  const width = Math.abs(shape.x2 - shape.x1)
  const height = Math.abs(shape.y2 - shape.y1)
  if (shape.tool === "arrow")
    return (
      <line
        class="mark mark-arrow"
        x1={shape.x1}
        y1={shape.y1}
        x2={shape.x2}
        y2={shape.y2}
        stroke-width={ARROW_WIDTH}
        stroke-linecap="round"
        marker-end="url(#ah)"
      />
    )
  if (shape.tool === "box")
    return (
      <rect
        class="mark mark-box"
        x={x}
        y={y}
        width={width}
        height={height}
        rx={4}
        stroke-width={BOX_WIDTH}
      />
    )
  return <rect class="mark mark-hl" x={x} y={y} width={width} height={height} rx={2} />
}

function MarkupDialog({ view }: { view: Signal<View> }): JSX.Element | null {
  const { model } = useOverlay()
  const entered = useEntered()
  const dialog = useRef<HTMLDivElement>(null)
  const drawing = useRef(false)
  const surface = useRef<SVGSVGElement>(null)

  useEffect(() => dialog.current?.focus({ preventScroll: true }), [])

  const markup = model.markup.value
  const current = view.value
  const region = markup?.region ?? (current.status === "omitted" ? current.region : null)
  if (!region) return null

  const maxWidth = Math.max(120, Math.min(760, window.innerWidth - 120))
  const maxHeight = Math.max(120, Math.min(440, window.innerHeight - 220))
  const fit = Math.min(maxWidth / region.width, maxHeight / region.height, 1.6)
  const stage = {
    width: `${Math.round(region.width * fit)}px`,
    height: `${Math.round(region.height * fit)}px`,
  }

  function replaceShapes(update: (shapes: Shape[]) => Shape[]) {
    const held = model.markup.value
    if (held) model.markup.value = { ...held, shapes: update(held.shapes) }
  }

  function pointIn(event: PointerEvent) {
    const box = surface.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 1, 1)
    return {
      x: ((event.clientX - box.left) / box.width) * (region?.width ?? 0),
      y: ((event.clientY - box.top) / box.height) * (region?.height ?? 0),
    }
  }

  function onDrawStart(event: PointerEvent) {
    if (event.button !== 0 || !markup) return
    surface.current?.setPointerCapture(event.pointerId)
    const { x, y } = pointIn(event)
    drawing.current = true
    replaceShapes((shapes) => [...shapes, { tool: markup.tool, x1: x, y1: y, x2: x, y2: y }])
  }

  function onDrawMove(event: PointerEvent) {
    if (!drawing.current) return
    const { x, y } = pointIn(event)
    replaceShapes((shapes) => {
      const last = shapes.at(-1)
      return last ? [...shapes.slice(0, -1), { ...last, x2: x, y2: y }] : shapes
    })
  }

  function onDrawEnd() {
    if (!drawing.current) return
    drawing.current = false
    replaceShapes((shapes) => {
      const last = shapes.at(-1)
      return last && Math.hypot(last.x2 - last.x1, last.y2 - last.y1) < MIN_SHAPE
        ? shapes.slice(0, -1)
        : shapes
    })
  }

  function finish() {
    if (!markup) return
    const { x, y, width, height } = markup.region
    model.openComposer({
      target: regionTarget(new DOMRect(x, y, width, height)),
      shot: { shapes: markup.shapes },
    })
  }

  const header = (
    <div class="mk-h">
      <b>Mark up</b>
      <span class="dims">
        {Math.round(region.width)} × {Math.round(region.height)}
      </span>
      {markup && (
        <>
          <fieldset class="seg" aria-label="Markup tool">
            {TOOLS.map(({ tool, label, key }) => (
              <button
                type="button"
                key={tool}
                aria-pressed={markup.tool === tool}
                aria-label={label}
                data-tip={label}
                data-kbd={key}
                onClick={() => {
                  model.markup.value = { ...markup, tool }
                }}
              >
                <Icon name={tool} />
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            class="iconbtn"
            aria-label="Undo last mark"
            data-tip="Undo mark"
            data-kbd={`${MOD}Z`}
            onClick={() => replaceShapes((shapes) => shapes.slice(0, -1))}
          >
            <Icon name="undo" />
          </button>
        </>
      )}
    </div>
  )

  const retake = (
    <button type="button" class="btn ghost" onClick={() => model.setMode("shot")}>
      Retake
    </button>
  )

  return (
    <div
      class={entered ? "markup on" : "markup"}
      role="dialog"
      aria-label="Mark up screenshot"
      tabIndex={-1}
      ref={dialog}
    >
      {header}
      {current.status === "omitted" || !markup ? (
        <>
          <div class="mk-heavy">{current.status === "omitted" ? current.message : FAILED_COPY}</div>
          <div class="mk-f">
            <span class="spacer" />
            {retake}
          </div>
        </>
      ) : (
        <>
          <div
            class="mk-stage"
            style={{
              ...stage,
              ...(current.status === "ready" ? { background: current.background } : {}),
            }}
          >
            {current.status === "ready" ? (
              <img
                src={current.url}
                alt=""
                style={{
                  width: `${region.width * fit}px`,
                  height: `${region.height * fit}px`,
                }}
              />
            ) : (
              <div class="wait">Capturing…</div>
            )}
            <svg
              class="draw"
              role="img"
              aria-label="Capture to mark up"
              ref={surface}
              viewBox={`0 0 ${region.width} ${region.height}`}
              preserveAspectRatio="none"
              onPointerDown={onDrawStart}
              onPointerMove={onDrawMove}
              onPointerUp={onDrawEnd}
              onPointerCancel={onDrawEnd}
            >
              <defs>
                <marker
                  id="ah"
                  viewBox="0 0 10 10"
                  refX="7"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto"
                >
                  <path class="mark-arrow-head" d="M0 0 10 5 0 10z" />
                </marker>
              </defs>
              {markup.shapes.map((shape, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: marks only append or pop, so position is identity
                <ShapeMark key={i} shape={shape} />
              ))}
            </svg>
          </div>
          <div class="mk-f">
            <span class="hint">Drag on the capture to draw. Marks travel with the note.</span>
            {retake}
            <button type="button" class="btn primary" onClick={finish}>
              Add to round <kbd>↵</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function Markup(): JSX.Element | null {
  useSheet(markupCss)
  const { model, connection, host, root, errors } = useOverlay()
  const held = useRef<Held | null>(null)
  const previous = useRef(model.composer.peek())
  const view = useSignal<View>({ status: "capturing" })

  function release() {
    const current = held.current
    if (!current) return
    if (!current.uploading) current.controller.abort()
    if (current.url !== null) URL.revokeObjectURL(current.url)
    held.current = null
  }

  function start(region: Box) {
    const controller = new AbortController()
    const tokens = getComputedStyle(root.querySelector(".root") ?? host)
    const clip = new DOMRect(
      region.x + window.scrollX,
      region.y + window.scrollY,
      region.width,
      region.height,
    )
    const result = captureRegion(clip, { signal: controller.signal, exclude: host }).catch(
      (): Crop => ({ omitted: "cancelled" }),
    )
    const current: Held = {
      region,
      controller,
      result,
      colors: {
        arrow: tokens.getPropertyValue("--mark-arrow").trim(),
        hl: tokens.getPropertyValue("--mark-hl").trim(),
      },
      background: pageBackground(),
      url: null,
      flat: null,
      before: null,
      noteId: null,
      uploading: false,
      outcome: null,
    }
    held.current = current
    view.value = { status: "capturing" }
    void result.then((crop) => {
      if (held.current !== current) return
      if ("omitted" in crop) {
        view.value = {
          status: "omitted",
          region,
          message: CAP_COPY.get(crop.omitted) ?? FAILED_COPY,
        }
        // Without markup state the key handler ignores Enter, so a failed capture cannot open a
        // composer that claims a screenshot is attached.
        if (model.mode.peek() === "markup") model.markup.value = null
        return
      }
      current.url = URL.createObjectURL(crop.png)
      view.value = {
        status: "ready",
        url: current.url,
        width: crop.width,
        height: crop.height,
        background: current.background,
      }
    })
  }

  function finish(current: Held) {
    if (held.current === current) release()
    else if (current.url !== null) URL.revokeObjectURL(current.url)
  }

  /** Puts the uploaded screenshot on the saved note once both the upload and the note's id exist. */
  function settle(current: Held) {
    const { outcome, noteId } = current
    if (outcome === null || noteId === null) return
    const note = model.drafts.peek().find((draft) => draft.id === noteId)
    const attached =
      outcome === "omitted"
        ? note?.capture?.omittedParts.includes("screenshot")
        : note?.capture?.screenshot?.ref === outcome.ref
    if (note && !attached) {
      const body = toDraftBody(
        {
          intent: note.intent,
          body: note.body,
          target: note.target,
          anchorStatus: note.anchorStatus,
        },
        withOutcome(note.capture, outcome, errors()),
      )
      connection.putDraft(note.id, body)
      model.noteUpdated({ ...note, ...body })
    }
    finish(current)
  }

  function prepare(current: Held, shapes: readonly Shape[]) {
    current.before = new Set(model.draftOrder.peek())
    current.flat = current.result
      .then((crop) =>
        "omitted" in crop ? null : flatten(crop.png, current.region, current, shapes),
      )
      .catch(() => null)
    void current.flat.then((blob) => {
      if (blob !== null) {
        root.dispatchEvent(new CustomEvent(SHOT_READY, { detail: blob }))
        return
      }
      const composer = model.composer.peek()
      if (!composer?.shot) return
      current.uploading = true
      current.outcome = "omitted"
      model.pushToast("Couldn’t attach the screenshot", { tone: "failed" })
      model.composer.value = {
        ...composer,
        capture: withOutcome(composer.capture, "omitted", errors()),
      }
    })
  }

  async function upload(current: Held) {
    current.uploading = true
    const blob = await current.flat
    let outcome: Screenshot | "omitted" = "omitted"
    if (blob) {
      try {
        outcome = await connection.uploadScreenshot(blob)
      } catch {}
    }
    if (outcome === "omitted") model.pushToast("Couldn’t attach the screenshot", { tone: "failed" })
    current.outcome = outcome
    settle(current)
  }

  useSignalEffect(() => {
    const region = model.markup.value?.region
    if (!region || held.current?.region === region) return
    release()
    start(region)
  })

  useSignalEffect(() => {
    const mode = model.mode.value
    if (mode !== "markup" && mode !== "compose" && !held.current?.uploading) release()
  })

  useSignalEffect(() => {
    const composer = model.composer.value
    const was = previous.current
    previous.current = composer
    const current = held.current
    if (!current) return
    if (!composer) {
      if (was?.shot && was.saving && current.before !== null) {
        current.noteId = model.draftOrder.peek().find((id) => !current.before?.has(id)) ?? null
        if (current.noteId !== null) settle(current)
        else finish(current)
      } else if (was?.shot) finish(current)
      return
    }
    if (!composer.shot || composer.editing) return
    if (current.flat === null) prepare(current, composer.shot.shapes)
    if (composer.saving && !current.uploading) void upload(current)
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: release only reads refs, so any copy of it is current
  useEffect(() => release, [])

  const mode = model.mode.value
  if (mode === "shot") return <ShotLayer />
  if (mode === "markup") return <MarkupDialog view={view} />
  return null
}
