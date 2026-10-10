import type { Box, ElementAnchor } from "@iter8/protocol"
import { identityOf, pageBox } from "./snapshot"

const FALLBACK_LIMIT = 2000
const NEAR_SLACK_PX = 48

export type AnchorCandidate = {
  role: string | undefined
  name: string | undefined
  text: string | undefined
  box: Box
}

type Choice =
  | { kind: "anchored"; index: number }
  | { kind: "lost"; reason: "missing" | "ambiguous" }

function centreDistance(a: Box, b: Box): number {
  return Math.hypot(
    a.x + a.width / 2 - (b.x + b.width / 2),
    a.y + a.height / 2 - (b.y + b.height / 2),
  )
}

/**
 * An anchor with neither role nor name is recognised only by its text, so a text change loses it
 * rather than re-anchoring to whichever same-tag neighbour is closest.
 */
export function chooseAnchor(
  stored: ElementAnchor,
  candidates: readonly AnchorCandidate[],
): Choice {
  const indexed = candidates.map((candidate, index) => ({ candidate, index }))
  const sameRoleAndName = indexed.filter(
    ({ candidate }) => candidate.role === stored.role && candidate.name === stored.name,
  )
  const exact = sameRoleAndName.filter(({ candidate }) => candidate.text === stored.text)
  const [only] = exact
  if (only !== undefined && exact.length === 1) return { kind: "anchored", index: only.index }

  const identified = stored.role !== undefined || stored.name !== undefined
  const pool = exact.length > 1 ? exact : identified ? sameRoleAndName : []
  const reach = Math.hypot(stored.box.width, stored.box.height) / 2 + NEAR_SLACK_PX
  const [nearest, runnerUp] = pool
    .map(({ candidate, index }) => ({ index, distance: centreDistance(stored.box, candidate.box) }))
    .filter(({ distance }) => distance < reach)
    .sort((a, b) => a.distance - b.distance)

  if (nearest === undefined)
    return { kind: "lost", reason: exact.length > 1 ? "ambiguous" : "missing" }
  if (runnerUp !== undefined && runnerUp.distance <= nearest.distance)
    return { kind: "lost", reason: "ambiguous" }
  return { kind: "anchored", index: nearest.index }
}

export function parentAcrossShadow(el: Element): Element | null {
  if (el.parentElement !== null) return el.parentElement
  const parent = el.parentNode
  return parent instanceof ShadowRoot ? parent.host : null
}

// Agent-authored anchors can carry selectors the browser rejects; those match nothing.
function matchAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector))
  } catch {
    return []
  }
}

function shadowRootsAlong(hosts: readonly string[]): ParentNode[] {
  let roots: ParentNode[] = [document]
  for (const host of hosts)
    roots = roots.flatMap((root) =>
      matchAll(root, host).flatMap((el) => (el.shadowRoot === null ? [] : [el.shadowRoot])),
    )
  return roots
}

export function resolveSelector(selector: readonly string[]): Element[] {
  const last = selector.at(-1)
  if (last === undefined) return []
  return shadowRootsAlong(selector.slice(0, -1)).flatMap((root) => matchAll(root, last))
}

function sameTagElements(selector: readonly string[]): Element[] {
  const tag = selector
    .at(-1)
    ?.split(" > ")
    .at(-1)
    ?.match(/^[a-z][\w-]*/i)?.[0]
  if (tag === undefined) return []
  return shadowRootsAlong(selector.slice(0, -1))
    .flatMap((root) => matchAll(root, tag))
    .slice(0, FALLBACK_LIMIT)
}

function candidateOf(el: Element): AnchorCandidate {
  const { role, name, text } = identityOf(el)
  return { role, name, text, box: pageBox(el) }
}

export function resolveAnchor(
  stored: ElementAnchor,
): { kind: "anchored"; el: Element } | { kind: "lost"; reason: "missing" | "ambiguous" } {
  const matched = resolveSelector(stored.selector)
  const elements = matched.length > 0 ? matched : sameTagElements(stored.selector)
  const choice = chooseAnchor(stored, elements.map(candidateOf))
  if (choice.kind === "lost") return choice
  const el = elements[choice.index]
  if (el === undefined)
    throw new Error(`chooseAnchor picked index ${choice.index} of ${elements.length}`)
  return { kind: "anchored", el }
}
