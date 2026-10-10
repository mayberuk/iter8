import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { useOverlay } from "./context"

const SHOW_AFTER_MS = 380
const EDGE = 8
const GAP = 10
/** Below this distance from the top a tooltip has no room above its control, so it drops below. */
const ROOM_ABOVE = 60

type Tip = { text: string; kbd: string; box: DOMRect }

function tipTarget(event: Event): HTMLElement | null {
  const target = event.composedPath()[0]
  return target instanceof Element ? target.closest<HTMLElement>("[data-tip]") : null
}

export function Tooltip() {
  const { root } = useOverlay()
  const [tip, setTip] = useState<Tip | null>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const hide = () => {
      clearTimeout(timer)
      setTip(null)
      setAt(null)
    }
    const onOver = (event: Event) => {
      const el = tipTarget(event)
      const text = el?.dataset.tip
      if (!el || !text || root.querySelector(".dock.dragging")) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        setAt(null)
        setTip({ text, kbd: el.dataset.kbd ?? "", box: el.getBoundingClientRect() })
      }, SHOW_AFTER_MS)
    }
    const onOut = (event: Event) => {
      if (tipTarget(event)) hide()
    }
    root.addEventListener("pointerover", onOver, { passive: true })
    root.addEventListener("pointerout", onOut, { passive: true })
    root.addEventListener("pointerdown", hide, { passive: true })
    return () => {
      clearTimeout(timer)
      root.removeEventListener("pointerover", onOver)
      root.removeEventListener("pointerout", onOut)
      root.removeEventListener("pointerdown", hide)
    }
  }, [root])

  useLayoutEffect(() => {
    const el = ref.current
    if (!tip || at || !el) return
    const { width, height } = el.getBoundingClientRect()
    const box = tip.box
    const left = Math.min(
      Math.max(box.left + box.width / 2 - width / 2, EDGE),
      window.innerWidth - width - EDGE,
    )
    const top = box.top > ROOM_ABOVE ? box.top - height - GAP : box.bottom + GAP
    setAt({ left, top })
  }, [tip, at])

  if (!tip) return null
  return (
    <div
      ref={ref}
      class={at ? "tip on" : "tip"}
      role="tooltip"
      style={at ? { left: `${at.left}px`, top: `${at.top}px` } : undefined}
    >
      <span>{tip.text}</span>
      {tip.kbd === "drag" ? (
        <span class="sub">drag in Pick</span>
      ) : tip.kbd ? (
        <kbd>{tip.kbd}</kbd>
      ) : null}
    </div>
  )
}
