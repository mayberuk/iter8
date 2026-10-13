import { createContext, useCallback, useContext, useEffect, useState } from "react"

const ToastContext = createContext(() => {})
const VISIBLE_MS = 4000

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const show = useCallback((message) => setToast({ message, id: Date.now() }), [])

  useEffect(() => {
    if (toast === null) return
    const timer = setTimeout(() => setToast(null), VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [toast])

  return (
    <ToastContext value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4"
      >
        {toast && (
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-3 text-sm text-white shadow-xl ring-1 ring-black/10 dark:bg-slate-100 dark:text-slate-900">
            <svg viewBox="0 0 20 20" className="size-5 text-emerald-400" fill="currentColor" aria-hidden="true">
              <path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3-4.5 4.5a.75.75 0 0 1-1.06 0L6.3 11.36a.75.75 0 1 1 1.06-1.06l1.3 1.3 3.97-3.97a.75.75 0 1 1 1.06 1.06Z" />
            </svg>
            {toast.message}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="ml-2 rounded px-1 text-white/70 hover:text-white dark:text-slate-900/60 dark:hover:text-slate-900"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </ToastContext>
  )
}
