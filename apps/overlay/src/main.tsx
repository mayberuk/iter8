import { type HelloResult, OverlayBoot } from "@iter8/protocol"
import { effect } from "@preact/signals"
import { render } from "preact"
import { type ConnectionEvent, createConnection } from "./connection"
import { startErrorBuffer } from "./enrich/errors"
import { type ConnectionState, createOverlayModel, type OverlayModel } from "./model"
import { createRenderGeneration } from "./pick/snapshot"
import { App } from "./ui/App"
import { adoptSheet, OverlayContext } from "./ui/context"
import { NoticeDock } from "./ui/Dock"
import { registerFonts } from "./ui/fonts"
import { listenKeys } from "./ui/keys"
import tokensCss from "./ui/tokens.css" with { type: "text" }

/** The connection retries only after a socket closes, so a hello that never got through retries here. */
const UNREACHABLE_RETRY_MS = 2000

export function mount(input: OverlayBoot): () => void {
  const boot = OverlayBoot.parse(input)
  if (document.querySelector("iter8-overlay")) return () => {}

  const host = document.createElement("iter8-overlay")
  host.style.cssText = "position:fixed;inset:0;z-index:2147483000;pointer-events:none"
  document.documentElement.append(host)
  const root = host.attachShadow({ mode: "open" })
  adoptSheet(root, tokensCss)
  registerFonts()

  const generation = createRenderGeneration()
  const errorBuffer = startErrorBuffer()
  const disposers: (() => void)[] = []
  let model: OverlayModel | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let savedPrefs = ""
  let torn = false

  const connection = createConnection({
    boot,
    host: location.host,
    secure: location.protocol === "https:",
    fetch: Object.assign(window.fetch.bind(window), { preconnect: fetch.preconnect }),
    WebSocket: window.WebSocket,
    onMessage: (message) => model?.applyServerMessage(message),
    onEvent,
  })

  function start() {
    connection.start().catch(() => onEvent({ kind: "unreachable" }))
  }

  function showState(state: ConnectionState) {
    if (model) model.connection.value = state
    else render(<NoticeDock root={root} boot={boot} state={state} />, root)
  }

  function onEvent(event: ConnectionEvent) {
    if (torn) return
    if (retry !== null) clearTimeout(retry)
    retry = null
    switch (event.kind) {
      case "ready":
        ready(event.hello)
        return
      case "refused":
        showState({ status: "refused", reason: event.hello.reason })
        return
      case "unreachable":
        showState({ status: "unreachable" })
        retry = setTimeout(start, UNREACHABLE_RETRY_MS)
        return
      case "draining":
        return
    }
  }

  function ready(hello: Extract<HelloResult, { outcome: "accepted" }>) {
    savedPrefs = JSON.stringify(hello.state.prefs)
    if (model) {
      model.applyHello(hello)
      return
    }
    const created = createOverlayModel({ hello, now: Date.now })
    model = created
    disposers.push(
      effect(() => {
        const prefs = created.prefs.value
        const text = JSON.stringify(prefs)
        if (text === savedPrefs) return
        savedPrefs = text
        connection.savePrefs(prefs)
      }),
      effect(() => {
        if (!created.reloadNow.value) return
        void connection.flush().then(
          () => location.reload(),
          () => {
            created.reloadNow.value = false
            created.pushToast("A note change didn't save — the page was not reloaded", {
              tone: "failed",
            })
          },
        )
      }),
      effect(() => {
        const until = created.deliveredUntil.value
        if (until === null) return
        const timer = setTimeout(created.expireDelivered, Math.max(0, until - Date.now()))
        return () => clearTimeout(timer)
      }),
      listenKeys({ model: created, connection, root, renderGeneration: generation.current }),
    )
    render(
      <OverlayContext.Provider
        value={{
          model: created,
          connection,
          root,
          host,
          boot,
          errors: errorBuffer.recent,
          renderGeneration: generation.current,
        }}
      >
        <App />
      </OverlayContext.Provider>,
      root,
    )
  }

  const removal = new MutationObserver(() => {
    if (!host.isConnected) teardown()
  })
  removal.observe(document.documentElement, { childList: true })

  function teardown() {
    if (torn) return
    torn = true
    removal.disconnect()
    if (retry !== null) clearTimeout(retry)
    for (const dispose of disposers.splice(0)) dispose()
    connection.close()
    errorBuffer.dispose()
    generation.dispose()
    render(null, root)
    host.remove()
  }

  render(<NoticeDock root={root} boot={boot} state={{ status: "connecting" }} />, root)
  start()
  return teardown
}
