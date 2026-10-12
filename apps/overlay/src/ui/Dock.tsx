import {
  IdempotencyKey,
  type LiveSession,
  type OverlayBoot,
  OverlayPrefs,
  type OwnerId,
  type Round,
  type RoundId,
  type SendResult,
} from "@iter8/protocol"
import { useComputed } from "@preact/signals"
import type { JSX } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import {
  buildSendRequest,
  type ConnectionState,
  type DockState,
  type Mode,
  nextRoundNumber,
  sessionName,
  type ToastTone,
} from "../model"
import { adoptSheet, useOverlay, useSheet } from "./context"
import dockCss from "./dock.css" with { type: "text" }
import { Avatar, Icon, type IconName, Meter, StatusGlyph } from "./glyphs"

type DockAnchor = OverlayPrefs["dock"]
type Theme = OverlayPrefs["theme"]

const ANCHORS = OverlayPrefs.shape.dock.options
const AXES = {
  tl: ["t", "l"],
  tc: ["t", "c"],
  tr: ["t", "r"],
  ml: ["m", "l"],
  mr: ["m", "r"],
  bl: ["b", "l"],
  bc: ["b", "c"],
  br: ["b", "r"],
} as const satisfies Record<DockAnchor, readonly ["t" | "m" | "b", "l" | "c" | "r"]>

const MARGIN = 16
/** The round sheet's 416 px plus the gap the dock keeps from it. */
const SHEET_CLEARANCE = 446
/** Below this width an open sheet leaves no room for the dock's labels. */
const COMPACT_BELOW = 1600
const DRAG_THRESHOLD = 5
const SNAP_RADIUS = 90
const SNAP_PULL = 0.55
const POP_GAP = 10
const POP_EDGE = 12
const DOCK_AVATAR_PX = 22
const POP_WIDTH = 320
const MORE_WIDTH = 272
const BUMP_MS = 200
/** The dock stays unseen until the fonts are in, so the width it is placed by is the width it keeps. */
const HIDDEN = { visibility: "hidden" } as const

const THEMES = {
  auto: { label: "Auto", icon: "auto" },
  light: { label: "Light", icon: "sun" },
  dark: { label: "Dark", icon: "moon" },
} as const satisfies Record<Theme, { label: string; icon: IconName }>

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function anchorXY(anchor: DockAnchor, width: number, height: number, sheetOpen: boolean) {
  const [v, h] = AXES[anchor]
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = { l: MARGIN, c: (vw - width) / 2, r: vw - width - MARGIN }[h]
  const y = { t: MARGIN, m: (vh - height) / 2, b: vh - height - MARGIN }[v]
  if (sheetOpen && v !== "m") x = Math.min(x, vw - SHEET_CLEARANCE - width)
  if (sheetOpen && v === "m" && h === "r") x = vw - SHEET_CLEARANCE - width
  return { x, y }
}

function servicePort(): string {
  return location.port || (location.protocol === "https:" ? "443" : "80")
}

function connectionNotice(state: ConnectionState): string | null {
  switch (state.status) {
    case "connecting":
    case "ready":
      return null
    case "unreachable":
      return "Can't reach the iter8 service — retrying"
    case "draining":
      return "iter8 is restarting — reconnecting"
    case "refused":
      return state.reason === "version-mismatch"
        ? "iter8 was updated — reload this page"
        : `Port ${servicePort()} on this machine isn't the iter8 service that opened this page`
  }
}

function ConnectionNotice({ state }: { state: ConnectionState }) {
  const text = connectionNotice(state)
  if (!text) return null
  return (
    <div class="pop on notice" role="status">
      <span>{text}</span>
      {state.status === "refused" && state.reason === "version-mismatch" ? (
        <button type="button" class="btn ghost" onClick={() => location.reload()}>
          Reload
        </button>
      ) : null}
    </div>
  )
}

/** The dock drawn before a handshake has been accepted, when there is no model to read yet. */
export function NoticeDock(props: { root: ShadowRoot; boot: OverlayBoot; state: ConnectionState }) {
  adoptSheet(props.root, dockCss)
  return (
    <div class="root" data-theme="auto">
      <div
        class="dock chrome s-unattached"
        role="toolbar"
        aria-label="iter8 annotation tools"
        style={{ left: "auto", top: "auto", right: `${MARGIN}px`, bottom: `${MARGIN}px` }}
      >
        <div class="idn">
          <span class="vu">
            <Meter state="checking" />
          </span>
          <span class="proj">iter8</span>
          <span class="where">
            {props.boot.machineName}:{servicePort()}
          </span>
        </div>
      </div>
      <div class="dockpops" style={{ right: `${MARGIN}px`, bottom: `${MARGIN + 52 + POP_GAP}px` }}>
        <ConnectionNotice state={props.state} />
      </div>
    </div>
  )
}

export function useSendRound(): {
  send: () => Promise<void>
  sendNow: () => Promise<void>
  nudge: (round: Round) => Promise<void>
  nowAvailable: boolean
  blocked: "no-pairing" | "gone" | "empty" | null
  label: "Send" | "Queue"
} {
  const { model, connection } = useOverlay()
  const nudging = useRef(new Set<RoundId>())
  const busy = model.pairing.value?.state.status === "busy"
  const blocked = model.sendBlocked.value
  const label = busy ? "Queue" : "Send"

  async function requestNow(round: Round, failure: string, tone: ToastTone) {
    try {
      model.applySendNowResult(await connection.sendNow(round.id))
    } catch {
      model.pushToast(failure, { tone })
    }
  }

  async function submit(andNow: boolean) {
    const pairing = model.pairing.value
    const { sending } = model
    if (sending.inFlight || !pairing || model.sendBlocked.value) return
    const noteIds = model.draftOrder.value
    // A retry of the same drafts reuses its key, so a send that landed before a dropped reply is not sent twice.
    const revision = JSON.stringify([pairing.generation, model.orderedDrafts.value])
    const key =
      sending.key?.revision === revision
        ? sending.key.key
        : IdempotencyKey.parse(crypto.randomUUID())
    sending.key = { revision, key }
    sending.inFlight = true
    try {
      let result: SendResult
      try {
        result = await connection.send(buildSendRequest(noteIds, pairing, key))
      } catch {
        model.pushToast("Couldn't reach iter8 — your notes are still here, send again", {
          tone: "failed",
        })
        return
      }
      model.applySendResult(result)
      if (andNow && result.outcome === "accepted")
        await requestNow(
          result.round,
          `Round ${result.round.id.slice(1)} queued — couldn't send it now`,
          "amber",
        )
    } finally {
      sending.inFlight = false
    }
  }

  async function nudge(round: Round) {
    if (nudging.current.has(round.id)) return
    nudging.current.add(round.id)
    try {
      await requestNow(round, `Couldn't send round ${round.id.slice(1)} now`, "failed")
    } finally {
      nudging.current.delete(round.id)
    }
  }

  return {
    send: () => submit(false),
    sendNow: () => submit(true),
    nudge,
    nowAvailable: busy && blocked === null,
    blocked,
    label,
  }
}

export function SessionRows(props: {
  sessions: readonly LiveSession[]
  current: OwnerId | null
}): JSX.Element {
  const { model, connection } = useOverlay()
  const attaching = useRef(false)
  const pageId = model.pageId.value
  const names = props.sessions.map((session) => sessionName(session, pageId))

  async function attach(owner: OwnerId) {
    if (attaching.current) return
    attaching.current = true
    try {
      const result = await connection.attach(owner)
      model.applyAttachResult(result)
      if (result.outcome === "accepted") model.menu.value = "none"
    } catch {
      model.pushToast("Couldn't reach iter8 to attach — try again", { tone: "failed" })
    } finally {
      attaching.current = false
    }
  }

  return (
    <div class="rows">
      {props.sessions.map((session, index) => {
        const name = names[index] ?? pageId
        const shared = names.filter((other) => other === name).length > 1
        const current = session.owner === props.current
        return (
          <button
            key={session.owner}
            type="button"
            class={current ? "srow cur" : "srow"}
            aria-label={`Attach to ${name}${shared ? ` · ${session.process.label}` : ""}`}
            onClick={() => void attach(session.owner)}
          >
            <Meter state="live" still size="small" />
            <Avatar agent={session.agent} size={18} />
            <span class="nm">{name}</span>
            <span class="wh">{session.process.label}</span>
            {current ? (
              <span class="ck">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

function SessionMenu() {
  const { model } = useOverlay()
  const state = model.dock.value
  const pairing = model.pairing.value
  const sessions = model.liveSessions.value.filter(
    (session) =>
      session.state.status !== "gone" && !(state === "gone" && session.owner === pairing?.owner),
  )
  const heading =
    state === "gone"
      ? "Session ended"
      : state === "unattached"
        ? "Attach this page to a session"
        : "Send rounds to"
  return (
    <div
      class={state === "gone" ? "pop on sess gone" : "pop on sess"}
      role="dialog"
      aria-label={heading}
    >
      <h4>{heading}</h4>
      {state === "gone" ? (
        <p>
          {model.name.value} · {model.where.value} is gone. Attach this page to:
        </p>
      ) : null}
      {sessions.length ? (
        <SessionRows sessions={sessions} current={pairing?.owner ?? null} />
      ) : (
        <p>No other session is running on {model.machineName.value}</p>
      )}
    </div>
  )
}

function Notices() {
  const { model } = useOverlay()
  const pairing = model.pairing.value
  const sessions = model.liveSessions.value.filter(
    (session) => session.state.status !== "gone" && session.owner !== pairing?.owner,
  )
  const orphaned = model.rounds.value.filter((round) => round.state.stage === "orphaned")
  return (
    <>
      <ConnectionNotice state={model.connection.value} />
      {model.notices.value.map((notice) =>
        notice.type === "reload-pending" ? (
          <div key="reload" class="pop on notice" role="status">
            <span>This page changed — it reloads when you save or cancel this note</span>
          </div>
        ) : (
          <div
            key={`port-${notice.port}`}
            class="pop on notice"
            role="status"
            data-tip={notice.url}
          >
            <span>
              A request to port {notice.port} failed — that port isn't reachable from this page
            </span>
            <button
              type="button"
              class="iconbtn"
              aria-label="Dismiss"
              onClick={() => model.dismissUpstreamFailure(notice.port)}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        ),
      )}
      {orphaned.map((round) => (
        <div key={round.id} class="pop on notice" role="status">
          <span>Round {round.id.slice(1)} wasn't delivered</span>
          {sessions.length ? <SessionRows sessions={sessions} current={null} /> : null}
        </div>
      ))}
    </>
  )
}

function MoreMenu() {
  const { model } = useOverlay()
  const prefs = model.prefs.value

  function pickTheme(theme: Theme) {
    model.setPrefs({ theme })
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches
    model.pushToast(
      `Theme ${THEMES[theme].label}${theme === "auto" ? ` · ${dark ? "dark" : "light"} right now` : ""}`,
      { ttlMs: 1600 },
    )
  }

  function togglePins() {
    model.menu.value = "none"
    model.setPrefs({ pinsVisible: !prefs.pinsVisible })
    model.pushToast(prefs.pinsVisible ? "Pins hidden" : "Pins shown", { ttlMs: 1400 })
  }

  function openShortcuts() {
    model.menu.value = "none"
    model.setShortcutsOpen(true)
  }

  return (
    <div class="pop on sess morepop" role="menu" aria-label="More options">
      <h4>Appearance</h4>
      <div class="tabs tseg" role="radiogroup" aria-label="Theme">
        {(Object.keys(THEMES) as Theme[]).map((theme) => (
          <label key={theme} class="tab">
            <input
              type="radio"
              name="iter8-theme"
              checked={prefs.theme === theme}
              onChange={() => pickTheme(theme)}
            />
            <Icon name={THEMES[theme].icon} size={14} />
            {THEMES[theme].label}
          </label>
        ))}
      </div>
      <div class="msep" />
      <button type="button" class="srow" role="menuitem" onClick={togglePins}>
        <Icon name="eye" size={14} />
        <span class="nm">{prefs.pinsVisible ? "Hide pins" : "Show pins"}</span>
        <span class="wh">
          <kbd>P</kbd>
        </span>
      </button>
      <button type="button" class="srow" role="menuitem" onClick={openShortcuts}>
        <Icon name="keys" size={14} />
        <span class="nm">Keyboard shortcuts</span>
        <span class="wh">
          <kbd>?</kbd>
        </span>
      </button>
    </div>
  )
}

const STATE_WORD: Partial<Record<DockState, string>> = {
  unattached: "not attached",
  busy: "busy",
  delivered: "delivered",
}

function sendTip(
  blocked: ReturnType<typeof useSendRound>["blocked"],
  busy: boolean,
  listener: "armed" | "none" | undefined,
  name: string,
): string {
  if (blocked === "gone") return "Session ended — reattach first"
  if (blocked === "no-pairing") return "Attach this page to a session first"
  if (blocked === "empty") return "Nothing in this round yet"
  if (busy) return `Delivers when ${name}’s turn ends`
  if (listener === "none") return `Queued until your next prompt in ${name}`
  return `Wakes ${name} now`
}

type Drag = {
  x0: number
  y0: number
  ox: number
  oy: number
  width: number
  height: number
  moved: boolean
  best: DockAnchor
  frame: number
}

export function Dock() {
  useSheet(dockCss)
  const { model, connection } = useOverlay()
  const { send, blocked, label } = useSendRound()

  const dockRef = useRef<HTMLDivElement>(null)
  const iter8Ref = useRef<HTMLButtonElement>(null)
  const popsRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const morePopRef = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const justDragged = useRef(false)
  const placed = useRef(false)
  const [fontsReady, setFontsReady] = useState(document.fonts.status !== "loading")
  const [near, setNear] = useState<DockAnchor | null>(null)
  const [viewport, setViewport] = useState(0)
  const [resized, setResized] = useState(0)
  const [bump, setBump] = useState(false)

  const composeTool = useComputed<Mode | null>(() => {
    const composer = model.composer.value
    if (!composer) return null
    if (composer.target.kind !== "region") return "pick"
    return composer.shot ? null : "region"
  })

  const prefs = model.prefs.value
  const state = model.dock.value
  const pairing = model.pairing.value
  const mode = model.mode.value
  const menu = model.menu.value
  const sheetOpen = model.sheet.value.open
  const count = model.draftOrder.value.length
  const name = model.name.value
  const where = model.where.value
  const word = pairing?.state.status === "gone" ? pairing.state.reason : (STATE_WORD[state] ?? null)
  const tip = sendTip(blocked, pairing?.state.status === "busy", pairing?.listener, name)

  const previousCount = useRef(count)
  useEffect(() => {
    const grew = count > previousCount.current
    previousCount.current = count
    if (!grew) return
    setBump(true)
    const timer = setTimeout(() => setBump(false), BUMP_MS)
    return () => clearTimeout(timer)
  }, [count])

  const needsSession = state === "gone" || state === "unattached"
  useEffect(() => {
    if (needsSession) model.menu.value = "session"
  }, [needsSession, model])

  useEffect(() => {
    if (menu !== "session") return
    let live = true
    connection
      .listSessions()
      .then((sessions) => {
        if (live) model.liveSessions.value = sessions
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [menu, connection, model])

  useEffect(() => {
    if (menu === "none") return
    const onPointerDown = (event: PointerEvent) => {
      const path = event.composedPath()
      const inside = [popsRef, morePopRef, moreRef, dockRef].some(
        (ref) => ref.current && path.includes(ref.current),
      )
      if (!inside) model.menu.value = "none"
    }
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true })
    return () => window.removeEventListener("pointerdown", onPointerDown, { capture: true })
  }, [menu, model])

  useEffect(() => {
    const onResize = () => setViewport((tick) => tick + 1)
    window.addEventListener("resize", onResize, { capture: true, passive: true })
    return () => window.removeEventListener("resize", onResize, { capture: true })
  }, [])

  useEffect(() => {
    const observer = new ResizeObserver(() => setResized((tick) => tick + 1))
    for (const el of [dockRef.current, iter8Ref.current]) if (el) observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      if (drag.current) cancelAnimationFrame(drag.current.frame)
    },
    [],
  )

  useEffect(() => {
    if (fontsReady) return
    let live = true
    document.fonts.ready.then(() =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (live) setFontsReady(true)
        }),
      ),
    )
    return () => {
      live = false
    }
  }, [fontsReady])

  const dragging = near !== null
  const roundNumber = nextRoundNumber(model.rounds.value)
  const compact = sheetOpen && window.innerWidth < COMPACT_BELOW
  const hasAvatar = pairing !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dock's rendered content sets its width, so a change re-places it in the same frame; viewport and resized are re-measure ticks.
  useLayoutEffect(() => {
    const dock = dockRef.current
    const iter8 = iter8Ref.current
    if (!dock || !iter8 || dragging) return
    const shown = prefs.collapsed ? iter8 : dock
    const other = prefs.collapsed ? dock : iter8
    const width = shown.offsetWidth
    const height = shown.offsetHeight
    const otherWidth = other.offsetWidth
    const otherHeight = other.offsetHeight
    const more = moreRef.current
    const moreRight = more ? more.offsetLeft + more.offsetWidth : 0
    const at = anchorXY(prefs.dock, width, height, sheetOpen)
    // The first placement would animate in from the stylesheet's 0,0, and a font landing changes the width the dock was placed by.
    const instant = !placed.current || !fontsReady
    if (instant) for (const el of [dock, iter8]) el.style.transition = "none"
    shown.style.translate = `${at.x}px ${at.y}px`
    other.style.translate = `${at.x + width / 2 - otherWidth / 2}px ${at.y + height / 2 - otherHeight / 2}px`
    if (instant) {
      placed.current = true
      void dock.offsetWidth
      for (const el of [dock, iter8]) el.style.transition = ""
    }

    const above = at.y > window.innerHeight / 2
    const pops = popsRef.current
    if (pops) {
      pops.classList.toggle("below", !above)
      pops.style.left = `${clamp(at.x, POP_EDGE, window.innerWidth - POP_WIDTH - POP_EDGE)}px`
      pops.style.top = above ? "auto" : `${at.y + height + POP_GAP}px`
      pops.style.bottom = above ? `${window.innerHeight - at.y + POP_GAP}px` : "auto"
    }
    const morePop = morePopRef.current
    if (more && morePop) {
      const right = at.x + moreRight
      morePop.style.left = `${clamp(right - MORE_WIDTH, POP_EDGE, window.innerWidth - MORE_WIDTH - POP_EDGE)}px`
      morePop.style.top = above ? "auto" : `${at.y + height + POP_GAP}px`
      morePop.style.bottom = above ? `${window.innerHeight - at.y + POP_GAP}px` : "auto"
    }
  }, [
    prefs.dock,
    prefs.collapsed,
    sheetOpen,
    compact,
    menu,
    viewport,
    resized,
    dragging,
    name,
    where,
    word,
    state,
    count,
    roundNumber,
    label,
    hasAvatar,
  ])

  function toggleTool(tool: Mode) {
    model.setMode(mode === tool || (tool === "shot" && mode === "markup") ? "idle" : tool)
  }

  function toggleMenu(which: "session" | "more") {
    model.menu.value = menu === which ? "none" : which
  }

  function onGripDown(event: PointerEvent) {
    const dock = dockRef.current
    if (event.button !== 0 || !dock) return
    const rect = dock.getBoundingClientRect()
    drag.current = {
      x0: event.clientX,
      y0: event.clientY,
      ox: event.clientX - rect.left,
      oy: event.clientY - rect.top,
      width: dock.offsetWidth,
      height: dock.offsetHeight,
      moved: false,
      best: prefs.dock,
      frame: 0,
    }
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function onGripMove(event: PointerEvent) {
    const current = drag.current
    const dock = dockRef.current
    if (!current || !dock) return
    if (
      !current.moved &&
      Math.hypot(event.clientX - current.x0, event.clientY - current.y0) < DRAG_THRESHOLD
    )
      return
    if (!current.moved) {
      current.moved = true
      if (model.menu.value !== "none") model.menu.value = "none"
    }
    let x = event.clientX - current.ox
    let y = event.clientY - current.oy
    let best: DockAnchor = current.best
    let distance = Number.POSITIVE_INFINITY
    for (const anchor of ANCHORS) {
      const at = anchorXY(anchor, current.width, current.height, sheetOpen)
      const d = Math.hypot(at.x - x, at.y - y)
      if (d < distance) {
        distance = d
        best = anchor
      }
    }
    const target = anchorXY(best, current.width, current.height, sheetOpen)
    if (distance < SNAP_RADIUS) {
      const k = (1 - distance / SNAP_RADIUS) * SNAP_PULL
      x += (target.x - x) * k
      y += (target.y - y) * k
    }
    cancelAnimationFrame(current.frame)
    current.frame = requestAnimationFrame(() => {
      dock.style.translate = `${x}px ${y}px`
    })
    current.best = best
    setNear(best)
  }

  function onGripEnd(event: PointerEvent) {
    const current = drag.current
    if (!current) return
    cancelAnimationFrame(current.frame)
    if (event.type === "pointercancel" || current.moved) drag.current = null
    if (!current.moved) return
    justDragged.current = true
    drag.current = null
    setNear(null)
    model.setPrefs({ dock: current.best })
  }

  function onGripClick() {
    drag.current = null
    if (justDragged.current) {
      justDragged.current = false
      return
    }
    toggleMenu("session")
  }

  const pressed = (tool: Mode) =>
    tool === "shot"
      ? mode === "shot" || mode === "markup"
      : mode === tool || (mode === "compose" && composeTool.value === tool)
  const stateClass = `s-${state}`
  const gripLabel = `Session ${name} on ${where}, ${word ?? state}. Drag to move the dock, press to switch session.`

  return (
    <>
      {near ? (
        <div class="layer chrome anchors">
          {ANCHORS.map((anchor) => {
            const width = drag.current?.width ?? 0
            const height = drag.current?.height ?? 0
            const at = anchorXY(anchor, width, height, sheetOpen)
            return (
              <i
                key={anchor}
                class={anchor === near ? "near" : undefined}
                style={{ left: `${at.x + width / 2}px`, top: `${at.y + height / 2}px` }}
              />
            )
          })}
        </div>
      ) : null}
      <div class="dockpops" ref={popsRef}>
        <Notices />
        {menu === "session" && !prefs.collapsed ? <SessionMenu /> : null}
      </div>
      {menu === "more" ? (
        <div class="dockpops" ref={morePopRef} style={{ width: `${MORE_WIDTH}px` }}>
          <MoreMenu />
        </div>
      ) : null}
      <div
        ref={dockRef}
        class={[
          "dock chrome",
          stateClass,
          compact ? "compact" : "",
          near ? "dragging" : "",
          prefs.collapsed ? "hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="toolbar"
        aria-label="iter8 annotation tools"
        inert={prefs.collapsed}
        style={fontsReady ? undefined : HIDDEN}
      >
        <button
          type="button"
          class="idn"
          aria-haspopup="dialog"
          aria-expanded={menu === "session"}
          aria-label={gripLabel}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripEnd}
          onPointerCancel={onGripEnd}
          onClick={onGripClick}
        >
          <span class="vu">
            <Meter state={state} />
          </span>
          {pairing ? <Avatar agent={pairing.agent} size={DOCK_AVATAR_PX} /> : null}
          <span class="proj">{name}</span>
          <span class="where">{where}</span>
          {word ? (
            <span class="stword">
              {state === "busy" ? <StatusGlyph state="working" /> : null}
              {state === "delivered" ? <StatusGlyph state="delivered" /> : null}
              <span class="w">{word}</span>
            </span>
          ) : null}
          <span class="sheen" aria-hidden="true">
            <span class="sheen-copy">
              <i class="vu skip" />
              {pairing ? <i class="skip" style={{ width: `${DOCK_AVATAR_PX}px` }} /> : null}
              <span class="hn">{name}</span>
              <span class="hw">{where}</span>
              {word ? (
                <span class="hs">
                  {state === "busy" || state === "delivered" ? <i class="skip hs-icon" /> : null}
                  <span>{word}</span>
                </span>
              ) : null}
            </span>
          </span>
        </button>
        <i class="vr" />
        <div class="seg">
          <button
            type="button"
            aria-pressed={pressed("pick")}
            aria-label="Pick element"
            data-tip="Pick element"
            data-kbd="C"
            onClick={() => toggleTool("pick")}
          >
            <Icon name="pick" />
          </button>
          <button
            type="button"
            aria-pressed={pressed("region")}
            aria-label="Draw region"
            data-tip="Region · place something here"
            data-kbd="drag"
            onClick={() => toggleTool("region")}
          >
            <Icon name="region" />
          </button>
          <button
            type="button"
            aria-pressed={pressed("shot")}
            aria-label="Screenshot"
            data-tip="Screenshot"
            data-kbd="S"
            onClick={() => toggleTool("shot")}
          >
            <Icon name="shot" />
          </button>
        </div>
        <i class="vr" />
        <button
          type="button"
          class="counter"
          aria-label="Open round sheet"
          data-tip="Round sheet"
          data-kbd="R"
          onClick={() => model.toggleSheet("round")}
        >
          <span class="rl">Round {roundNumber}</span>
          <span class={["n", count ? "" : "zero", bump ? "bump" : ""].filter(Boolean).join(" ")}>
            {count}
          </span>
        </button>
        <button
          type="button"
          class="send"
          disabled={blocked !== null}
          data-tip={tip}
          onClick={() => void send()}
        >
          <Icon name="send" size={15} />
          <span>{label}</span>
        </button>
        <button
          type="button"
          ref={moreRef}
          class="iconbtn"
          aria-haspopup="menu"
          aria-expanded={menu === "more"}
          aria-label="More options"
          data-tip="Appearance and more"
          onClick={() => toggleMenu("more")}
        >
          <Icon name="more" />
        </button>
        <button
          type="button"
          class="iconbtn"
          aria-label="Collapse dock"
          data-tip="Collapse"
          onClick={() => {
            model.menu.value = "none"
            model.setPrefs({ collapsed: true })
          }}
        >
          <Icon name="collapse" />
        </button>
      </div>
      <button
        ref={iter8Ref}
        type="button"
        class={
          prefs.collapsed ? `iter8btn chrome ${stateClass}` : `iter8btn chrome hidden ${stateClass}`
        }
        aria-label="Expand iter8 dock"
        inert={!prefs.collapsed}
        style={fontsReady ? undefined : HIDDEN}
        onClick={() => model.setPrefs({ collapsed: false })}
      >
        <span class="vu">
          <Meter state={state} />
        </span>
        {count ? <span class="badge">{count}</span> : null}
      </button>
    </>
  )
}
