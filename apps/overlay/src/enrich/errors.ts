import type { Capture } from "@iter8/protocol"

type ConsoleError = NonNullable<Capture["consoleErrors"]>[number]

const KEEP_ENTRIES = 20
const KEEP_MS = 5 * 60 * 1000

function describeError(event: Event): Omit<ConsoleError, "at"> {
  if (event instanceof ErrorEvent) {
    const message = event.message || String(event.error)
    if (!event.filename) return { message }
    return { message, source: `${event.filename}:${event.lineno}:${event.colno}` }
  }
  const failed = event.target
  if (failed instanceof HTMLElement) {
    const url = failed.getAttribute("src") ?? failed.getAttribute("href")
    const message = `<${failed.localName}> failed to load`
    return url === null ? { message } : { message, source: url }
  }
  return { message: `${event.type} event` }
}

function describeRejection(event: PromiseRejectionEvent): Omit<ConsoleError, "at"> {
  const { reason } = event
  return { message: reason instanceof Error ? reason.message : String(reason) }
}

/**
 * Listens on `window` in the capture phase, so a page handler that stops propagation cannot hide
 * an error, and so resource load failures, which do not bubble, are seen too. `console` is never
 * patched: that would change a built-in on someone else's page.
 */
export function startErrorBuffer(): {
  recent: () => NonNullable<Capture["consoleErrors"]>
  dispose: () => void
} {
  const entries: { entry: ConsoleError; atMs: number }[] = []
  const record = (described: Omit<ConsoleError, "at">) => {
    const atMs = Date.now()
    entries.push({ entry: { ...described, at: new Date(atMs).toISOString() }, atMs })
    if (entries.length > KEEP_ENTRIES) entries.shift()
  }
  const onError = (event: Event) => record(describeError(event))
  const onRejection = (event: PromiseRejectionEvent) => record(describeRejection(event))
  window.addEventListener("error", onError, { capture: true })
  window.addEventListener("unhandledrejection", onRejection, { capture: true })
  return {
    recent: () => {
      const since = Date.now() - KEEP_MS
      return entries.filter(({ atMs }) => atMs >= since).map(({ entry }) => entry)
    },
    dispose: () => {
      window.removeEventListener("error", onError, { capture: true })
      window.removeEventListener("unhandledrejection", onRejection, { capture: true })
    },
  }
}
