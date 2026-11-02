import { Intent } from "@iter8/protocol"
import { batch } from "@preact/signals"
import type { Connection } from "../connection"
import type { Mode, OverlayModel } from "../model"
import { partTarget, resolvePart } from "../parts"
import { parentAcrossShadow } from "../pick/anchor"
import { regionTarget, snapshotElement } from "../pick/snapshot"

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
const TYPING_EVENTS = ["keydown", "keypress", "keyup", "beforeinput", "input"] as const

function togglesPalette(event: KeyboardEvent): boolean {
  return (IS_MAC ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "k"
}

function editable(target: EventTarget | undefined): target is HTMLElement {
  if (target instanceof HTMLInputElement) return !/^(radio|checkbox|button)$/.test(target.type)
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(TEXTAREA|SELECT)$/.test(target.tagName))
  )
}

/** The one capture-phase key handler; it consumes a key only when it acts on it. */
export function listenKeys(deps: {
  model: OverlayModel
  connection: Connection
  root: ShadowRoot
  renderGeneration: () => number
}): () => void {
  const { model, connection, root } = deps

  function toggleTool(tool: Mode) {
    const mode = model.mode.value
    model.setMode(mode === tool || (tool === "shot" && mode === "markup") ? "idle" : tool)
  }

  async function save() {
    const composer = model.composer.value
    const body = model.beginSave()
    if (!composer || !body) return
    try {
      if (composer.editing) {
        const existing = model.drafts.value.find((note) => note.id === composer.editing)
        connection.putDraft(composer.editing, body)
        if (existing) model.noteSaved({ ...existing, ...body })
      } else {
        model.noteSaved(await connection.createDraft(body))
      }
    } catch {
      model.saveFailed()
      model.pushToast("Couldn't save the note — try again", { tone: "failed" })
    }
  }

  async function remove(index: number) {
    const id = model.draftOrder.value[index]
    if (id === undefined) return
    try {
      await connection.deleteDraft(id)
      model.noteDeleted(id)
    } catch {
      model.pushToast("Couldn't delete the note — try again", { tone: "failed" })
    }
  }

  function climb(direction: "up" | "down") {
    const hover = model.hover.value?.deref()
    if (!hover || root.contains(hover)) return
    if (direction === "up") {
      const parent = parentAcrossShadow(hover)
      if (!parent || parent === document.body || parent === document.documentElement) return
      batch(() => {
        model.climbStack.value = [...model.climbStack.value, new WeakRef(hover)]
        model.hover.value = new WeakRef(parent)
      })
      return
    }
    const stack = model.climbStack.value
    const child = stack.at(-1)?.deref() ?? hover.firstElementChild
    if (!child) return
    batch(() => {
      model.climbStack.value = stack.slice(0, -1)
      model.hover.value = new WeakRef(child)
    })
  }

  function annotatePicked(): boolean {
    const generation = deps.renderGeneration()
    const picked = model.multi.value.flatMap((ref) => ref.deref() ?? [])
    if (picked.length >= 2) {
      const anchors = picked.map((el) => snapshotElement(el, generation))
      model.openComposer({ target: { kind: "elements", anchors } })
      return true
    }
    const hover = model.hover.value?.deref() ?? picked[0]
    if (!hover) return false
    if (root.contains(hover)) {
      const found = resolvePart(hover)
      if (!found) return false
      model.openComposer({ target: partTarget(found, model.serviceVersion.peek()) })
      return true
    }
    model.openComposer({ target: { kind: "element", anchor: snapshotElement(hover, generation) } })
    return true
  }

  function finishMarkup() {
    const markup = model.markup.value
    if (!markup) return
    const { x, y, width, height } = markup.region
    model.openComposer({
      target: regionTarget(new DOMRect(x, y, width, height)),
      shot: { shapes: markup.shapes },
    })
  }

  function togglePins() {
    const visible = !model.prefs.value.pinsVisible
    model.setPrefs({ pinsVisible: visible })
    model.pushToast(visible ? "Pins shown" : "Pins hidden", { ttlMs: 1400 })
  }

  /** Returns whether the key was acted on. */
  function act(event: KeyboardEvent, typing: boolean): boolean {
    const key = event.key
    const mod = IS_MAC ? event.metaKey : event.ctrlKey
    const mode = model.mode.value

    if (togglesPalette(event)) {
      model.paletteOpen.value = !model.paletteOpen.value
      return true
    }
    if (model.paletteOpen.value) return false
    if (event.altKey && event.shiftKey && event.code === "KeyA") {
      toggleTool("pick")
      return true
    }

    if (mode === "compose") {
      if (mod && key === "Enter") {
        void save()
        return true
      }
      if (key === "Escape") return model.escape()
      const digit = /^Digit([1-4])$/.exec(event.code)?.[1]
      const intent = digit === undefined ? undefined : Intent.options[Number(digit) - 1]
      if (intent && (event.altKey || !typing || model.composer.value?.body === "")) {
        model.setIntent(intent)
        return true
      }
      return false
    }

    if (key === "Escape") return model.escape()

    if (mode === "markup") {
      const markup = model.markup.value
      if (!markup) return false
      const tool = ({ a: "arrow", b: "box", h: "hl" } as const)[key.toLowerCase()]
      if (tool && !mod) {
        model.markup.value = { ...markup, tool }
        return true
      }
      if (mod && key.toLowerCase() === "z") {
        model.markup.value = { ...markup, shapes: markup.shapes.slice(0, -1) }
        return true
      }
      if (key === "Enter") {
        finishMarkup()
        return true
      }
      return false
    }

    if (typing) return false

    if (key === " ") {
      model.peek.value = true
      return true
    }
    if (mode === "shot" && key === "Enter") {
      batch(() => {
        model.setMode("markup")
        model.markup.value = {
          region: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
          tool: "arrow",
          shapes: [],
        }
      })
      return true
    }
    if (mode === "pick") {
      if (key === "ArrowUp" || key === "ArrowDown") {
        if (!model.hover.value) return false
        climb(key === "ArrowUp" ? "up" : "down")
        return true
      }
      if (key === "Enter") return annotatePicked()
    }

    const sheet = model.sheet.value
    const focus = model.focus.value
    if (sheet.open && sheet.tab === "round" && !mod) {
      if (key === "j") {
        model.focusNext()
        return true
      }
      if (key === "k") {
        model.focusPrev()
        return true
      }
      if (focus >= 0) {
        if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
          model.moveNote(focus, focus + (key === "ArrowUp" ? -1 : 1))
          return true
        }
        const id = model.draftOrder.value[focus]
        if ((key === "e" || key === "Enter") && id !== undefined) {
          model.openComposer({ editing: id })
          return true
        }
        if (key === "Backspace" || key === "Delete") {
          void remove(focus)
          return true
        }
      }
    }

    if (mod || event.altKey) return false
    switch (key.toLowerCase()) {
      case "c":
        toggleTool("pick")
        return true
      case "s":
        toggleTool("shot")
        return true
      case "r":
        model.toggleSheet("round")
        return true
      case "p":
        togglePins()
        return true
      case "?":
        model.setShortcutsOpen(!model.shortcutsOpen.value)
        return true
      default:
        return false
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing) return
    const target = event.composedPath()[0]
    const ours = target instanceof Node && root.contains(target)
    const typing = editable(target)
    if (typing && !ours && !togglesPalette(event)) return
    // A focused control of ours answers Enter and Space itself.
    if (
      ours &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === "Enter" || event.key === " ") &&
      target instanceof Element &&
      target.closest("button, input, [role=button], [role=menuitem]")
    )
      return
    if (!act(event, typing)) return
    event.preventDefault()
    event.stopPropagation()
  }

  function endPeek(event?: KeyboardEvent) {
    if (event && event.key !== " ") return
    if (model.peek.value) model.peek.value = false
  }
  const onKeyUp = (event: KeyboardEvent) => endPeek(event)
  const onBlur = (event: FocusEvent) => {
    if (event.target === window) endPeek()
  }
  // Past the shadow root our field is retargeted to the host, which page hotkeys treat as non-editable.
  const hideTyping = (event: Event) => {
    if (editable(event.composedPath()[0])) event.stopPropagation()
  }

  window.addEventListener("keydown", onKeyDown, { capture: true })
  window.addEventListener("keyup", onKeyUp, { capture: true, passive: true })
  window.addEventListener("blur", onBlur, { capture: true, passive: true })
  for (const type of TYPING_EVENTS) root.addEventListener(type, hideTyping, { passive: true })
  return () => {
    window.removeEventListener("keydown", onKeyDown, { capture: true })
    window.removeEventListener("keyup", onKeyUp, { capture: true })
    window.removeEventListener("blur", onBlur, { capture: true })
    for (const type of TYPING_EVENTS) root.removeEventListener(type, hideTyping)
  }
}
