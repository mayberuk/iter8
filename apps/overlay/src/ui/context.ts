import type { Capture, OverlayBoot } from "@iter8/protocol"
import { createContext } from "preact"
import { useContext } from "preact/hooks"
import type { Connection } from "../connection"
import type { OverlayModel } from "../model"

type Overlay = {
  model: OverlayModel
  connection: Connection
  root: ShadowRoot
  host: HTMLElement
  boot: OverlayBoot
  errors: () => NonNullable<Capture["consoleErrors"]>
  renderGeneration: () => number
}

export const OverlayContext = createContext<Overlay | null>(null)

export function useOverlay(): Overlay {
  const overlay = useContext(OverlayContext)
  if (!overlay) throw new Error("useOverlay needs an OverlayContext provider")
  return overlay
}

const adopted = new WeakMap<ShadowRoot, Set<string>>()

/** Constructed sheets, because a page's CSP can refuse a `<style>` element but not these. */
export function adoptSheet(root: ShadowRoot, cssText: string): void {
  const known = adopted.get(root) ?? new Set<string>()
  adopted.set(root, known)
  if (known.has(cssText)) return
  known.add(cssText)
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(cssText)
  root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
}

/** Adopts during render, so a component's first paint is already styled. */
export function useSheet(cssText: string): void {
  adoptSheet(useOverlay().root, cssText)
}
