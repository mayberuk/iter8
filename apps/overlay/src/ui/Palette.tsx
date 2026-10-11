import {
  type ElementAnchor,
  Intent,
  type Note,
  type OverlayPrefs,
  type OwnerId,
} from "@iter8/protocol"
import { batch } from "@preact/signals"
import { type ComponentChildren, Fragment } from "preact"
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks"
import { z } from "zod"
import { type Mode, nextRoundNumber, type SheetTab, sessionName } from "../model"
import { useOverlay, useSheet } from "./context"
import { useSendRound } from "./Dock"
import { Icon, type IconName, IntentGlyph } from "./glyphs"
import paletteCss from "./palette.css" with { type: "text" }

type Theme = OverlayPrefs["theme"]
type SendRound = ReturnType<typeof useSendRound>

const Group = z.enum(["Actions", "View", "Appearance", "Notes", "Sessions"])
type Group = z.infer<typeof Group>

type Command = {
  group: Group
  label: string
  sub?: string
  keys?: readonly string[]
  icon?: IconName
  intent?: Intent
  /** Set only where the visible label alone would not tell two rows apart. */
  name?: string
  run: () => void
}

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"

const THEMES = {
  auto: { label: "Auto", icon: "auto", sub: "follows the system" },
  light: { label: "Light", icon: "sun", sub: "" },
  dark: { label: "Dark", icon: "moon", sub: "" },
} as const satisfies Record<Theme, { label: string; icon: IconName; sub: string }>

const COACH_DELAY_MS = 500
const COACH_GAP = 14
const COACH_EDGE = 12

function targetLabel(note: Note): string {
  const { target } = note
  if (target.kind === "region") {
    const size = `${Math.round(target.box.width)}×${Math.round(target.box.height)}`
    return note.capture?.screenshot ? `screenshot ${size}` : `region ${size}`
  }
  const anchors: readonly ElementAnchor[] =
    target.kind === "element" ? [target.anchor] : target.anchors
  const first = anchors[0]
  const tag =
    first?.selector
      .at(-1)
      ?.split(" > ")
      .at(-1)
      ?.match(/^[a-z][\w-]*/i)?.[0] ?? "element"
  const name = first?.name ?? first?.text
  const base = name ? `${tag} “${name.length > 28 ? `${name.slice(0, 26)}…` : name}”` : tag
  return anchors.length > 1 ? `${base} ×${anchors.length}` : base
}

function roundSummary(notes: readonly Note[]): string {
  const parts = Intent.options.flatMap((intent) => {
    const count = notes.filter((note) => note.intent === intent).length
    return count ? [`${count} ${intent}`] : []
  })
  return `${notes.length} note${notes.length === 1 ? "" : "s"}: ${parts.join(", ")}`
}

function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

/** A substring match over words, so "theme dark" finds "Theme: Dark" but "dark theme" does not. */
function matches(command: Command, query: string): boolean {
  const needle = words(query)
  if (needle === "") return true
  return words(`${command.label} ${command.sub ?? ""} ${command.group}`).includes(needle)
}

function useCommands(sendRound: SendRound): Command[] {
  const { model, connection } = useOverlay()
  const mode = model.mode.value
  const prefs = model.prefs.value
  const pairing = model.pairing.value
  const pageId = model.pageId.value
  const drafts = model.orderedDrafts.value
  const round = nextRoundNumber(model.rounds.value)

  function toggleTool(tool: Mode) {
    model.setMode(mode === tool || (tool === "shot" && mode === "markup") ? "idle" : tool)
  }

  function openSheet(tab: SheetTab) {
    model.sheet.value = { open: true, tab }
  }

  function togglePins() {
    const visible = !prefs.pinsVisible
    model.setPrefs({ pinsVisible: visible })
    model.pushToast(visible ? "Pins shown" : "Pins hidden", { ttlMs: 1400 })
  }

  function setCollapsed(collapsed: boolean) {
    model.menu.value = "none"
    model.setPrefs({ collapsed })
  }

  function setTheme(theme: Theme) {
    model.setPrefs({ theme })
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches
    model.pushToast(
      `Theme ${THEMES[theme].label}${theme === "auto" ? ` · ${dark ? "dark" : "light"} right now` : ""}`,
      { ttlMs: 1600 },
    )
  }

  async function attach(owner: OwnerId) {
    try {
      const result = await connection.attach(owner)
      model.applyAttachResult(result)
      if (result.outcome === "accepted") model.menu.value = "none"
    } catch {
      model.pushToast("Couldn't reach iter8 to attach — try again", { tone: "failed" })
    }
  }

  const sessions = model.liveSessions.value.filter((session) => session.state.status !== "gone")
  const sessionNames = sessions.map((session) => sessionName(session, pageId))

  const commands: Command[] = [
    {
      group: "Actions",
      icon: "pick",
      label: "Pick an element",
      keys: ["C"],
      run: () => toggleTool("pick"),
    },
    {
      group: "Actions",
      icon: "region",
      label: "Draw a region",
      sub: "place something here",
      run: () => model.setMode("region"),
    },
    {
      group: "Actions",
      icon: "shot",
      label: "Take a screenshot",
      keys: ["S"],
      run: () => toggleTool("shot"),
    },
    {
      group: "Actions",
      icon: "layers",
      label: "Open round sheet",
      keys: ["R"],
      run: () => openSheet("round"),
    },
    { group: "Actions", icon: "history", label: "Show history", run: () => openSheet("history") },
  ]
  if (sendRound.blocked === null)
    commands.push({
      group: "Actions",
      icon: "send",
      label: `${sendRound.label} round ${round}`,
      sub: roundSummary(drafts),
      run: () => void sendRound.send(),
    })
  commands.push(
    {
      group: "View",
      icon: "eye",
      label: prefs.pinsVisible ? "Hide pins" : "Show pins",
      keys: ["P"],
      run: togglePins,
    },
    {
      group: "View",
      icon: "collapse",
      label: prefs.collapsed ? "Expand dock" : "Collapse dock",
      run: () => setCollapsed(!prefs.collapsed),
    },
    {
      group: "View",
      icon: "keys",
      label: "Keyboard shortcuts",
      keys: ["?"],
      run: () => model.setShortcutsOpen(true),
    },
  )
  for (const theme of Object.keys(THEMES) as Theme[])
    commands.push({
      group: "Appearance",
      icon: THEMES[theme].icon,
      label: `Theme: ${THEMES[theme].label}`,
      sub: prefs.theme === theme ? "current" : THEMES[theme].sub,
      run: () => setTheme(theme),
    })
  drafts.forEach((note, index) => {
    commands.push({
      group: "Notes",
      intent: note.intent,
      label: `${String(index + 1).padStart(2, "0")} ${note.body}`,
      sub: targetLabel(note),
      run: () =>
        batch(() => {
          openSheet("round")
          model.focus.value = index
        }),
    })
  })
  sessions.forEach((session, index) => {
    const current = session.owner === pairing?.owner && pairing.state.status !== "gone"
    if (current) return
    const name = sessionNames[index] ?? pageId
    const shared = sessionNames.filter((other) => other === name).length > 1
    commands.push({
      group: "Sessions",
      icon: "term",
      label: `Attach to ${name}`,
      sub: session.process.label,
      ...(shared ? { name: `Attach to ${name} · ${session.process.label}` } : {}),
      run: () => void attach(session.owner),
    })
  })
  return commands
}

function CommandPalette({ sendRound }: { sendRound: SendRound }) {
  const { model, connection } = useOverlay()
  const commands = useCommands(sendRound)
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = commands.filter((command) => matches(command, query))
  const current = Math.min(selected, Math.max(0, items.length - 1))

  useLayoutEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
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
  }, [connection, model])

  useEffect(() => {
    listRef.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest" })
  })

  function close() {
    model.paletteOpen.value = false
  }

  function run(command: Command) {
    close()
    command.run()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!event.isComposing) {
      switch (event.key) {
        case "ArrowDown":
          setSelected(Math.min(current + 1, items.length - 1))
          event.preventDefault()
          break
        case "ArrowUp":
          setSelected(Math.max(current - 1, 0))
          event.preventDefault()
          break
        case "Enter": {
          const command = items[current]
          if (command) run(command)
          event.preventDefault()
          break
        }
        case "Escape":
          close()
          event.preventDefault()
          break
        case "Tab":
          event.preventDefault()
          break
      }
    }
    event.stopPropagation()
  }

  return (
    <div
      class="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        class="palette"
        role="dialog"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          if (event.target !== inputRef.current) event.preventDefault()
        }}
      >
        <div class="pal-in">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={query}
            placeholder="Type a command or jump to a note"
            aria-label="Command"
            autocomplete="off"
            spellcheck={false}
            onInput={(event) => {
              setQuery(event.currentTarget.value)
              setSelected(0)
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div class="pal-list" ref={listRef}>
          {items.length === 0 ? (
            <div class="pal-empty">No command matches “{query}”</div>
          ) : (
            items.map((command, index) => (
              <Fragment key={`${command.group}:${command.name ?? command.label}`}>
                {command.group !== items[index - 1]?.group ? (
                  <div class="pal-g">{command.group}</div>
                ) : null}
                <button
                  type="button"
                  tabIndex={-1}
                  class={index === current ? "pal-i sel" : "pal-i"}
                  aria-current={index === current}
                  aria-label={command.name}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => setSelected(index)}
                  onClick={() => run(command)}
                >
                  {command.intent ? (
                    <IntentGlyph intent={command.intent} size={16} />
                  ) : command.icon ? (
                    <Icon name={command.icon} />
                  ) : null}
                  <span class="lb">
                    {command.label}
                    {command.sub ? <small>{command.sub}</small> : null}
                  </span>
                  <span class="ks">
                    {command.keys?.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                </button>
              </Fragment>
            ))
          )}
        </div>
        <div class="pal-f">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span class="ver">iter8 {model.serviceVersion.value}</span>
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="krow">
      <span>{label}</span>
      <span class="ks">{children}</span>
    </div>
  )
}

function ShortcutSheet() {
  const { model } = useOverlay()
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  function close() {
    model.setShortcutsOpen(false)
  }

  return (
    <div
      class="scrim"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div class="keysheet" role="dialog" aria-label="Keyboard shortcuts">
        <h2>
          <Icon name="keys" /> Shortcuts
          <button
            ref={closeRef}
            type="button"
            class="iconbtn"
            aria-label="Close shortcuts"
            onClick={close}
          >
            <Icon name="x" />
          </button>
        </h2>
        <div class="kgrid">
          <div>
            <h5>Pick</h5>
            <Row label="Pick mode">
              <kbd>C</kbd> or <kbd>⌥</kbd>
              <kbd>⇧</kbd>
              <kbd>A</kbd>
            </Row>
            <Row label="Parent / child">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
            </Row>
            <Row label="Add to selection">
              <kbd>⇧</kbd> click
            </Row>
            <Row label="Region">drag on the page</Row>
            <Row label="Annotate selection">
              <kbd>↵</kbd>
            </Row>
          </div>
          <div>
            <h5>Note</h5>
            <Row label="Fix · Change · Question · Keep">
              <kbd>1</kbd>
              <kbd>2</kbd>
              <kbd>3</kbd>
              <kbd>4</kbd>
            </Row>
            <Row label="Save">
              <kbd>{MOD}</kbd>
              <kbd>↵</kbd>
            </Row>
            <Row label="Cancel">
              <kbd>Esc</kbd>
            </Row>
            <Row label="Screenshot">
              <kbd>S</kbd>
            </Row>
            <Row label="Full viewport (in screenshot)">
              <kbd>↵</kbd>
            </Row>
          </div>
          <div>
            <h5>Round</h5>
            <Row label="Round sheet">
              <kbd>R</kbd>
            </Row>
            <Row label="Next / previous note">
              <kbd>J</kbd>
              <kbd>K</kbd>
            </Row>
            <Row label="Move note">
              <kbd>⌥</kbd>
              <kbd>↑</kbd>
              <kbd>↓</kbd>
            </Row>
            <Row label="Edit / delete note">
              <kbd>E</kbd> <kbd>⌫</kbd>
            </Row>
          </div>
          <div>
            <h5>Everywhere</h5>
            <Row label="Command palette">
              <kbd>{MOD}</kbd>
              <kbd>K</kbd>
            </Row>
            <Row label="Peek at the page">
              hold <kbd>Space</kbd>
            </Row>
            <Row label="Show or hide pins">
              <kbd>P</kbd>
            </Row>
            <Row label="This sheet">
              <kbd>?</kbd>
            </Row>
          </div>
        </div>
      </div>
    </div>
  )
}

const COACH_STEPS = [
  {
    target: '.dock [aria-label="Pick element"]',
    heading: "Point at anything",
    body: (
      <>
        Press <kbd>C</kbd> to pick. Hover shows the component and its source file; <kbd>↑</kbd>{" "}
        climbs to the parent.
      </>
    ),
  },
  {
    target: ".dock .send",
    heading: "Notes collect into a round",
    body: (
      <>
        Send hands the whole round to the agent session that owns this page. Its replies come back
        here under its own mark.
      </>
    ),
  },
  {
    target: ".dock .idn",
    heading: "Every shortcut, one key",
    body: (
      <>
        Press <kbd>?</kbd> any time. <kbd>{MOD}</kbd>
        <kbd>K</kbd> runs any command by name.
      </>
    ),
  },
] as const

type CoachPlace = { left: number; top: number; below: boolean; ax: number }

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

function Coach() {
  const { model, root } = useOverlay()
  const [armed, setArmed] = useState(false)
  const [place, setPlace] = useState<CoachPlace | null>(null)
  const [, setViewport] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const step = model.coachStep.value
  const covered =
    model.prefs.value.collapsed ||
    model.menu.value !== "none" ||
    model.paletteOpen.value ||
    model.shortcutsOpen.value ||
    model.mode.value === "markup"
  const visible = armed && !covered
  const entry = COACH_STEPS[step]

  useEffect(() => {
    if (model.coachStep.peek() < 0) return
    const timer = setTimeout(() => setArmed(true), COACH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [model])

  useEffect(() => {
    const replace = () => setViewport((tick) => tick + 1)
    const onTransitionEnd = (event: Event) => {
      if (event instanceof TransitionEvent && event.propertyName === "translate") replace()
    }
    window.addEventListener("resize", replace, { capture: true, passive: true })
    root.addEventListener("transitionend", onTransitionEnd, { passive: true })
    return () => {
      window.removeEventListener("resize", replace, { capture: true })
      root.removeEventListener("transitionend", onTransitionEnd)
    }
  }, [root])

  useLayoutEffect(() => {
    const coach = ref.current
    const target = entry && root.querySelector(entry.target)
    if (!visible || !coach || !target) return
    const box = target.getBoundingClientRect()
    const above = box.top > window.innerHeight / 2
    const left = clamp(
      box.left + box.width / 2 - coach.offsetWidth / 2,
      COACH_EDGE,
      window.innerWidth - coach.offsetWidth - COACH_EDGE,
    )
    const next = {
      left,
      top: above ? box.top - coach.offsetHeight - COACH_GAP : box.bottom + COACH_GAP,
      below: !above,
      ax: box.left + box.width / 2 - left,
    }
    if (
      !place ||
      place.left !== next.left ||
      place.top !== next.top ||
      place.below !== next.below ||
      place.ax !== next.ax
    )
      setPlace(next)
  })

  if (!entry) return null
  const last = step === COACH_STEPS.length - 1
  const classes = ["pop", "coach", visible && place ? "on" : "", place?.below ? "below" : ""]
  return (
    <div
      ref={ref}
      class={classes.filter(Boolean).join(" ")}
      role="dialog"
      aria-label="Getting started"
      style={
        place
          ? { left: `${place.left}px`, top: `${place.top}px`, "--ax": `${place.ax}px` }
          : undefined
      }
    >
      <div class="stp">
        {COACH_STEPS.map((other, index) => (
          <i key={other.heading} class={index <= step ? "on" : undefined} />
        ))}
        <span class="of">
          {step + 1} of {COACH_STEPS.length}
        </span>
      </div>
      <h4>{entry.heading}</h4>
      <p>{entry.body}</p>
      <div class="cf">
        <button type="button" class="skip" onClick={() => model.endCoach()}>
          Skip tour
        </button>
        <button
          type="button"
          class="next"
          onClick={() => (last ? model.endCoach() : model.nextCoach(step))}
        >
          {last ? "Got it" : "Next"}
        </button>
      </div>
    </div>
  )
}

export function Palette() {
  useSheet(paletteCss)
  const { model } = useOverlay()
  const sendRound = useSendRound()
  return (
    <>
      {model.shortcutsOpen.value ? <ShortcutSheet /> : null}
      {model.paletteOpen.value ? <CommandPalette sendRound={sendRound} /> : null}
      <Coach />
    </>
  )
}
