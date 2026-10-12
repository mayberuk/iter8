import { useEffect, useId, useRef } from "react"
import { createPortal } from "react-dom"

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog({ open, onClose, title, description, children }) {
  const panel = useRef(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement
    // Only #root goes inert: other body children, such as injected tooling, stay usable.
    const background = document.getElementById("root")
    background.inert = true
    const first = panel.current.querySelector(FOCUSABLE) ?? panel.current
    first.focus()
    return () => {
      background.inert = false
      trigger?.focus()
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== "Tab") return
    const stops = Array.from(panel.current.querySelectorAll(FOCUSABLE))
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = document.activeElement
    if (stops.length === 0 || (event.shiftKey && (active === first || active === panel.current))) {
      event.preventDefault()
      ;(last ?? panel.current).focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/10 outline-none dark:bg-slate-900 dark:ring-white/10"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {description}
        </p>
        {children}
      </div>
    </div>,
    document.body,
  )
}
