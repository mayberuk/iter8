import { domToCanvas } from "modern-screenshot"
import { parentAcrossShadow } from "../pick/anchor"

/** Big enough that the crop shows where on the page the picked element sits, not only the element. */
const CONTEXT_MIN_WIDTH = 320
const CONTEXT_MIN_HEIGHT = 160

/**
 * A 14,452 px, 17,554-node page took 12.6 s to clone on the main thread, so the context stops
 * climbing before it outgrows two viewports either way.
 */
const CONTEXT_MAX_VIEWPORTS = 2

/** Cloning ran at 0.72 ms a node, so 300 nodes is about 215 ms of one task. */
const CONTEXT_NODE_BUDGET = 300

const MAX_SHOT_BYTES = 2 * 1024 * 1024

type Size = { width: number; height: number }
type Rect = { left: number; top: number; width: number; height: number }

/**
 * The nearest ancestor, across shadow roots, of at least 320x160; failing that the largest one
 * still within two viewports and 300 nodes. Omitted when the target itself is over either budget.
 */
export function chooseCrop(
  target: Element,
  measure: (el: Element) => Size,
  viewport: Size,
  countNodes: (el: Element, limit: number) => number,
): { el: Element } | { omitted: "too-large" | "too-many-nodes" } {
  let fits: Element | null = null
  for (let node = target; ; ) {
    const box = measure(node)
    const over =
      box.width > viewport.width * CONTEXT_MAX_VIEWPORTS ||
      box.height > viewport.height * CONTEXT_MAX_VIEWPORTS
        ? "too-large"
        : countNodes(node, CONTEXT_NODE_BUDGET) > CONTEXT_NODE_BUDGET
          ? "too-many-nodes"
          : null
    if (over !== null) return fits === null ? { omitted: over } : { el: fits }
    fits = node
    if (box.width >= CONTEXT_MIN_WIDTH && box.height >= CONTEXT_MIN_HEIGHT) return { el: node }
    const parent = parentAcrossShadow(node)
    if (parent === null) return { el: node }
    node = parent
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
 * Renders the crop around `target` to a PNG, cut to the viewport, or to `clip` (page coordinates)
 * when given. Anything over budget, off screen or failing to render is answered as omitted; only
 * an abort rejects.
 */
export async function captureCrop(
  target: Element,
  opts: { signal: AbortSignal; exclude: Element; clip?: DOMRectReadOnly },
): Promise<{ png: Blob; width: number; height: number } | { omitted: string }> {
  const { signal, exclude, clip } = opts
  signal.throwIfAborted()
  const chosen = chooseCrop(
    target,
    (el) => el.getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    (el, limit) => countElements(el, limit, exclude),
  )
  if ("omitted" in chosen) return chosen
  const origin = chosen.el.getBoundingClientRect()
  const within =
    clip === undefined
      ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
      : {
          left: clip.left - window.scrollX,
          top: clip.top - window.scrollY,
          width: clip.width,
          height: clip.height,
        }
  const crop = intersect(origin, within)
  if (crop === null) return { omitted: "off screen" }

  const scale = Math.min(window.devicePixelRatio || 1, 2)
  try {
    // Cropped from the whole canvas rather than through the library's `width`/`height`, which
    // set the clone's own size and reflow it.
    const whole = await domToCanvas(chosen.el, {
      scale,
      filter: (node) => !exclude.contains(node),
      backgroundColor: getComputedStyle(document.body).backgroundColor,
    })
    signal.throwIfAborted()
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(crop.width * scale))
    canvas.height = Math.max(1, Math.round(crop.height * scale))
    const pen = canvas.getContext("2d")
    if (pen === null) return { omitted: "no 2d canvas" }
    pen.drawImage(
      whole,
      Math.round((crop.left - origin.left) * scale),
      Math.round((crop.top - origin.top) * scale),
      canvas.width,
      canvas.height,
      0,
      0,
      canvas.width,
      canvas.height,
    )
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    if (png === null) return { omitted: "encode failed" }
    if (png.size > MAX_SHOT_BYTES) return { omitted: "over 2 MiB" }
    return { png, width: canvas.width, height: canvas.height }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    return { omitted: `render failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}
