import type { NoteTarget } from "@iter8/protocol"

export const PARTS = {
  overlay: { name: "iter8 overlay", source: "apps/overlay/src/ui/App.tsx" },
  dock: { name: "Dock", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.collapsed": { name: "Collapsed dock button", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.identity": { name: "Dock session button", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.ring": { name: "Dock status ring", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.tools": { name: "Dock tool buttons", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.round": { name: "Dock round counter", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.send": { name: "Dock send button", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.more": { name: "Dock more button", source: "apps/overlay/src/ui/Dock.tsx" },
  "dock.collapse": { name: "Dock collapse button", source: "apps/overlay/src/ui/Dock.tsx" },
  sheet: { name: "Round sheet", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.header": { name: "Round sheet header", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.tabs": { name: "Round sheet tabs", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.round-list": { name: "This round list", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.note": { name: "Note row", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.history": { name: "History list", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "sheet.history-note": { name: "History note", source: "apps/overlay/src/ui/RoundSheet.tsx" },
  "chat.messages": { name: "Chat message list", source: "apps/overlay/src/ui/Conversation.tsx" },
  "chat.agent-message": { name: "Agent message", source: "apps/overlay/src/ui/Conversation.tsx" },
  "chat.user-bubble": {
    name: "Your message bubble",
    source: "apps/overlay/src/ui/Conversation.tsx",
  },
  "chat.round-divider": { name: "Round divider", source: "apps/overlay/src/ui/Conversation.tsx" },
  "chat.working": { name: "Working line", source: "apps/overlay/src/ui/Conversation.tsx" },
  "chat.background": {
    name: "Background work line",
    source: "apps/overlay/src/ui/Conversation.tsx",
  },
  "chat.composer": { name: "Chat composer", source: "apps/overlay/src/ui/Conversation.tsx" },
  composer: { name: "Note composer", source: "apps/overlay/src/ui/Composer.tsx" },
  markup: { name: "Screenshot markup dialog", source: "apps/overlay/src/ui/Markup.tsx" },
  palette: { name: "Command palette", source: "apps/overlay/src/ui/Palette.tsx" },
} as const satisfies Record<string, { name: string; source: string }>

export type PartKey = keyof typeof PARTS

const PART_ATTRIBUTE = "data-iter8-part"

export function part(key: PartKey): { "data-iter8-part": PartKey } {
  return { [PART_ATTRIBUTE]: key }
}

function isPartKey(key: string | null | undefined): key is PartKey {
  return key !== null && key !== undefined && Object.hasOwn(PARTS, key)
}

/**
 * The nearest tagged ancestor of `hit`. The catch-all `overlay` part has no box of its own, so a
 * hit under only that part stays the hit itself.
 */
export function resolvePart(hit: Element): { key: PartKey; el: Element } | null {
  const tagged = hit.closest(`[${PART_ATTRIBUTE}]`)
  if (tagged === null) return null
  const key = tagged.getAttribute(PART_ATTRIBUTE)
  if (!isPartKey(key)) return null
  return { key, el: key === "overlay" ? hit : tagged }
}

export function findPart(root: ShadowRoot, key: string): Element | null {
  return isPartKey(key) ? root.querySelector(`[${PART_ATTRIBUTE}="${key}"]`) : null
}

/**
 * The picked part while it stays on the page, else whatever now holds its key at the same position
 * among that key's elements, so a re-render that replaces it does not lose it.
 */
export function refindPart(
  root: ShadowRoot,
  key: string,
  picked: Element | null,
): () => Element | null {
  const tagged = () =>
    isPartKey(key) ? Array.from(root.querySelectorAll(`[${PART_ATTRIBUTE}="${key}"]`)) : []
  const at = picked === null ? 0 : tagged().indexOf(picked)
  return () => (picked?.isConnected ? picked : at < 0 ? null : (tagged()[at] ?? null))
}

export function partTarget(
  found: { key: PartKey; el: Element },
  iter8Version: string,
): Extract<NoteTarget, { kind: "iter8" }> {
  const { left, top, width, height } = found.el.getBoundingClientRect()
  return {
    kind: "iter8",
    part: { key: found.key, ...PARTS[found.key] },
    iter8Version,
    box: { x: left, y: top, width, height },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
  }
}
