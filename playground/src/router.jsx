import { useSyncExternalStore } from "react"

const listeners = new Set()

function subscribe(listener) {
  listeners.add(listener)
  window.addEventListener("popstate", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("popstate", listener)
  }
}

export function navigate(to) {
  if (to === window.location.pathname) return
  window.history.pushState(null, "", to)
  window.scrollTo(0, 0)
  for (const listener of listeners) listener()
}

export function usePath() {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname)
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname
}

export function Link({ to, onClick, ...props }) {
  const path = usePath()
  return (
    <a
      {...props}
      href={to}
      aria-current={path === to ? "page" : undefined}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        navigate(to)
      }}
    />
  )
}
