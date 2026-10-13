import { createContext, domToForeignObjectSvg } from "modern-screenshot"
import { parentAcrossShadow } from "../pick/anchor"

/** Big enough that the crop shows where on the page the picked element sits, not only the element. */
const CONTEXT_MIN_WIDTH = 320
const CONTEXT_MIN_HEIGHT = 160

/**
 * Cloning ran at 0.72 ms a node, so 300 nodes is about 215 ms of work, which `SLICE_MS` cuts into
 * tasks. Past it the capture is refused: the wait grows with the node count even when no task does.
 */
const NODE_BUDGET = 300

/**
 * 7680x4320, a 4K viewport at the 2x scale cap, drew in 23 ms and encoded in 27 ms in Chromium
 * 156, and the browser refuses a canvas past 16,384 px a side.
 */
const MAX_OUTPUT_PIXELS = 7680 * 4320

/** Cloning yields to the page after this long, so no task nears the 50 ms long-task line. */
const SLICE_MS = 15

/** Pixels an element may sit outside the clip and still count as touching it, for its border and edge. */
const REACH_PX = 1

const MAX_SHOT_BYTES = 2 * 1024 * 1024

/** A shot over MAX_SHOT_BYTES is halved until it fits; below half a CSS pixel per pixel, text blurs past reading. */
const MIN_SHOT_SCALE = 0.5

type Size = { width: number; height: number }
type Rect = { left: number; top: number; width: number; height: number }

/**
 * Where a clone may drop an element without moving what the clip shows: below it in these flows
 * nothing sits above or beside it.
 */
const STACKS_DOWNWARD = new Set([
  "block",
  "flow-root",
  "list-item",
  "table",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
])

/**
 * A table spreads any height beyond its rows over them, so a clone that dropped rows below the
 * clip would stretch the rest; each part with content takes the height of its rows instead.
 */
const TABLE_PARTS = new Set(["table", "thead", "tbody", "tfoot", "tr"])

function isTablePart(el: HTMLElement): boolean {
  return TABLE_PARTS.has(el.localName) || el.style.display.startsWith("table")
}

export type Reads = {
  children: (el: Element) => Iterable<Element>
  box: (el: Element) => Rect
  style: (el: Element) => { display: string; position: string }
}

export type Pruning = { stubs: Set<Node>; dropped: Set<Node>; nodes: number }

/**
 * The nearest ancestor, across shadow roots, of at least 320x160, stopping short of one past the
 * node budget; the target itself when it is already over it.
 */
export function chooseCrop(
  target: Element,
  measure: (el: Element) => Size,
  countNodes: (el: Element, limit: number) => number,
): Element {
  let fits = target
  for (let node = target; ; ) {
    if (countNodes(node, NODE_BUDGET) > NODE_BUDGET) return fits
    fits = node
    const box = measure(node)
    if (box.width >= CONTEXT_MIN_WIDTH && box.height >= CONTEXT_MIN_HEIGHT) return node
    const parent = parentAcrossShadow(node)
    if (parent === null) return node
    node = parent
  }
}

function overlaps(box: Rect, reach: { left: number; top: number; right: number; bottom: number }) {
  return (
    box.left + box.width > reach.left &&
    box.left < reach.right &&
    box.top + box.height > reach.top &&
    box.top < reach.bottom
  )
}

/**
 * Plans a clone of `root` that costs what the clip touches rather than what `root` holds. An
 * element touching the clip is cloned whole; one that does not is kept as an empty box of its own
 * size, so the layout around the clip stays put and a table still paints its collapsed borders, or
 * dropped when it is out of flow or lies below the clip in a downward flow. Null when the clone
 * would pass `limit` elements. `tick` runs once per element planned, to let the caller yield.
 */
export async function pruneFor(
  root: Element,
  clip: Rect,
  read: Reads,
  limit: number,
  tick: () => Promise<void>,
): Promise<Pruning | null> {
  const reach = {
    left: clip.left - REACH_PX,
    top: clip.top - REACH_PX,
    right: clip.left + clip.width + REACH_PX,
    bottom: clip.top + clip.height + REACH_PX,
  }
  const stubs = new Set<Node>()
  const dropped = new Set<Node>()
  let nodes = 0
  const pending = [root]
  for (let el = pending.pop(); el !== undefined; el = pending.pop()) {
    await tick()
    nodes += 1
    if (nodes > limit) return null
    const downward = STACKS_DOWNWARD.has(read.style(el).display)
    for (const child of read.children(el)) {
      const { display, position } = read.style(child)
      const box = read.box(child)
      const touches = overlaps(box, reach)
      const outOfFlow = position === "absolute" || position === "fixed"
      if (display === "none" || (outOfFlow && !touches)) dropped.add(child)
      else if (touches || display === "inline" || display === "contents") pending.push(child)
      else if (downward && box.top >= reach.bottom) dropped.add(child)
      else {
        stubs.add(child)
        nodes += 1
        if (nodes > limit) return null
      }
    }
  }
  return { stubs, dropped, nodes }
}

/** The smallest element containing the whole of `clip` (page coordinates), across shadow roots. */
function smallestContaining(clip: DOMRectReadOnly, exclude: Element): Element {
  const slack = 0.5
  const left = clip.left - window.scrollX
  const top = clip.top - window.scrollY
  let el =
    document
      .elementsFromPoint(left + clip.width / 2, top + clip.height / 2)
      .find((candidate) => candidate !== exclude && !exclude.contains(candidate)) ??
    document.documentElement
  for (;;) {
    const box = el.getBoundingClientRect()
    if (
      box.left <= left + slack &&
      box.top <= top + slack &&
      box.right >= left + clip.width - slack &&
      box.bottom >= top + clip.height - slack
    )
      return el
    const parent = parentAcrossShadow(el)
    if (parent === null) return el
    el = parent
  }
}

/** Counts elements, open shadow roots included and `skip` excluded, stopping once past `limit`. */
function countElements(root: Element, limit: number, skip: Element): number {
  const pending: (Element | ShadowRoot)[] = [root]
  let seen = 0
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node === skip) continue
    if (node instanceof Element) {
      seen += 1
      if (seen > limit) return seen
      if (node.shadowRoot !== null) pending.push(node.shadowRoot)
    }
    for (const child of node.children) pending.push(child)
  }
  return seen
}

function intersect(box: Rect, within: Rect): Rect | null {
  const left = Math.max(box.left, within.left)
  const top = Math.max(box.top, within.top)
  const right = Math.min(box.left + box.width, within.left + within.width)
  const bottom = Math.min(box.top + box.height, within.top + within.height)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}

/**
 * What shows behind `root` on the page: the library's own `backgroundColor` would replace the
 * root's background instead of sitting under it.
 */
function backdropOf(root: Element): string {
  for (let el = parentAcrossShadow(root); el !== null; el = parentAcrossShadow(el)) {
    const color = getComputedStyle(el).backgroundColor
    if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color
  }
  return "#fff"
}

type Shot = { png: Blob; width: number; height: number } | { omitted: string }
type Opts = { signal: AbortSignal; exclude: Element }

async function render(root: Element, within: Rect, { signal, exclude }: Opts): Promise<Shot> {
  signal.throwIfAborted()
  const origin = root.getBoundingClientRect()
  const crop = intersect(origin, within)
  if (crop === null) return { omitted: "off screen" }

  const scale = Math.min(window.devicePixelRatio || 1, 2)
  const pixels = {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
  }
  if (pixels.width * pixels.height > MAX_OUTPUT_PIXELS) return { omitted: "too-large" }

  let sliceStart = performance.now()
  const pause = async () => {
    signal.throwIfAborted()
    await scheduler.yield()
    signal.throwIfAborted()
    sliceStart = performance.now()
  }
  const slice = async () => {
    if (performance.now() - sliceStart >= SLICE_MS) await pause()
  }
  const pruning = await pruneFor(
    root,
    crop,
    {
      children: (el) =>
        Array.from(el.shadowRoot?.children ?? el.children).filter((child) => child !== exclude),
      box: (el) => el.getBoundingClientRect(),
      style: (el) => getComputedStyle(el),
    },
    NODE_BUDGET,
    slice,
  )
  if (pruning === null) return { omitted: "too-many-nodes" }
  const { stubs, dropped } = pruning

  const view = {
    width: (pixels.width + 0.25) / scale,
    height: (pixels.height + 0.25) / scale,
    left: Math.round((crop.left - origin.left) * scale) / scale,
    top: Math.round((crop.top - origin.top) * scale) / scale,
  }
  const styleProperties = Array.from(getComputedStyle(document.documentElement)).filter(
    (name) => !name.startsWith("--"),
  )
  try {
    // The library sizes the SVG to `width`/`height` and applies them to the root too, so the root
    // is put back at its own size; the SVG's viewBox then looks at the clip without a canvas as
    // big as the root. A transform on the root would do nothing for a table row group.
    // Computed values are already resolved and the image holds no stylesheet, so the custom
    // properties every element carries are dead weight: 979 KB of SVG became 407 KB for a full
    // 1280x720 viewport of a Tailwind page.
    const context = await createContext(root, {
      autoDestruct: true,
      scale,
      includeStyleProperties: styleProperties,
      width: view.width,
      height: view.height,
      style: { margin: "0", width: `${origin.width}px`, height: `${origin.height}px` },
      onCreateForeignObjectSvg: (svg) => {
        svg.setAttribute("viewBox", `${view.left} ${view.top} ${view.width} ${view.height}`)
        const frame = svg.querySelector("foreignObject")
        frame?.setAttribute("width", `${origin.width}`)
        frame?.setAttribute("height", `${origin.height}`)
      },
      filter: (node) => {
        if (exclude.contains(node) || dropped.has(node)) return false
        const owner = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode
        return owner === null || !stubs.has(owner)
      },
      onCloneEachNode: async (cloned) => {
        if (cloned instanceof HTMLElement && cloned.hasChildNodes() && isTablePart(cloned))
          cloned.style.height = "auto"
        await slice()
      },
    })
    const svg = await domToForeignObjectSvg(context)
    // Serialising, encoding and parsing the SVG ran as one 71 ms task at 4x for that viewport, so
    // each gets its own.
    await pause()
    const markup = new XMLSerializer()
      .serializeToString(svg)
      .replace(/(?![\t\n\r])[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu, "")
    await pause()
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
    await pause()
    await image.decode()
    signal.throwIfAborted()
    for (let factor = 1; ; factor /= 2) {
      const backed = document.createElement("canvas")
      backed.width = Math.max(1, Math.round(pixels.width * factor))
      backed.height = Math.max(1, Math.round(pixels.height * factor))
      const pen = backed.getContext("2d")
      if (pen === null) return { omitted: "no 2d canvas" }
      pen.fillStyle = backdropOf(root)
      pen.fillRect(0, 0, backed.width, backed.height)
      pen.drawImage(image, 0, 0, backed.width, backed.height)
      const png = await new Promise<Blob | null>((resolve) => backed.toBlob(resolve, "image/png"))
      if (png === null) return { omitted: "encode failed" }
      if (png.size <= MAX_SHOT_BYTES) return { png, width: backed.width, height: backed.height }
      if ((scale * factor) / 2 < MIN_SHOT_SCALE) return { omitted: "over 2 MiB" }
      signal.throwIfAborted()
      await pause()
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    return { omitted: `render failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * Renders the crop around `target`, climbed to enough context, to a PNG cut to the viewport. Anything
 * over budget, off screen or failing to render is answered as omitted; only an abort rejects.
 */
export function captureCrop(target: Element, opts: Opts): Promise<Shot> {
  const root = chooseCrop(
    target,
    (el) => el.getBoundingClientRect(),
    (el, limit) => countElements(el, limit, opts.exclude),
  )
  return render(
    root,
    { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
    opts,
  )
}

/**
 * Renders `clip` (page coordinates) to a PNG, from the smallest element containing all of it.
 * Answers as `captureCrop` does.
 */
export function captureRegion(clip: DOMRectReadOnly, opts: Opts): Promise<Shot> {
  return render(
    smallestContaining(clip, opts.exclude),
    {
      left: clip.left - window.scrollX,
      top: clip.top - window.scrollY,
      width: clip.width,
      height: clip.height,
    },
    opts,
  )
}
