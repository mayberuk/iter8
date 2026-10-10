import { useEffect, useState } from "preact/hooks"
import { type Toast, toDraftBody } from "../model"
import { useOverlay } from "./context"
import { Icon, StatusGlyph } from "./glyphs"

/** Matches the `.toast.out` animation, so a toast leaves the list only after it has faded. */
const LEAVE_MS = 200

function ToastIcon({ tone }: { tone: Toast["tone"] }) {
  switch (tone) {
    case "plain":
      return null
    case "ok":
      return (
        <span class="ok green">
          <Icon name="check" size={12} />
        </span>
      )
    case "amber":
      return (
        <span class="ok amber">
          <StatusGlyph state="queued" />
        </span>
      )
    case "failed":
      return (
        <span class="ok amber">
          <StatusGlyph state="failed" />
        </span>
      )
  }
}

function ToastRow({ toast }: { toast: Toast }) {
  const { model, connection } = useOverlay()
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setLeaving(true), toast.ttlMs)
    return () => clearTimeout(timer)
  }, [toast.ttlMs])

  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => model.dismissToast(toast.id), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [leaving, model, toast.id])

  async function undo() {
    setLeaving(true)
    const taken = model.takeUndo()
    if (!taken) return
    try {
      const created = await connection.createDraft(toDraftBody(taken.note, taken.note.capture))
      model.noteRestored(created, taken.index)
    } catch {
      model.pushToast("Couldn't restore the note — try again", { tone: "failed" })
    }
  }

  const classes = ["toast", toast.action ? "" : "plain", leaving ? "out" : ""]
  return (
    <div class={classes.filter(Boolean).join(" ")} role="status">
      <ToastIcon tone={toast.tone} />
      <span>{toast.text}</span>
      {toast.action === "undo" ? (
        <button type="button" onClick={() => void undo()}>
          <Icon name="undo" size={12} /> Undo
        </button>
      ) : null}
    </div>
  )
}

export function Toasts() {
  const { model } = useOverlay()
  return (
    <div class="toasts">
      {model.toasts.value.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
