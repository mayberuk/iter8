import { Intent, type NoteTarget, type ResolvedSourceLead } from "@iter8/protocol"
import type { JSX, RefObject } from "preact"
import { useEffect, useRef, useState } from "preact/hooks"
import composerCss from "./composer.css" with { type: "text" }
import { useOverlay, useSheet } from "./context"
import { Icon, IntentGlyph } from "./glyphs"

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"
const SHAKE_MS = 340

const INTENT_COPY = {
  fix: { label: "Fix", placeholder: "What’s wrong with it?" },
  change: { label: "Change", placeholder: "What should it become?" },
  question: { label: "Question", placeholder: "What do you want to know?" },
  keep: { label: "Keep", placeholder: "What must stay exactly as it is?" },
} as const satisfies Record<Intent, { label: string; placeholder: string }>

const NONE_REASON = {
  "no-framework": "No framework found for this element",
  "no-frames-resolved": "The source maps had no match for this element",
  "outside-project": "The source file is outside the project",
  "not-loaded": "The source lookup did not finish in time",
} as const satisfies Record<Extract<ResolvedSourceLead, { confidence: "none" }>["reason"], string>

/** Restarts the shake even when one is already running. */
export function shake(el: HTMLElement | null): void {
  if (!el) return
  el.classList.remove("shake")
  void el.offsetWidth
  el.classList.add("shake")
  setTimeout(() => el.classList.remove("shake"), SHAKE_MS)
}

function header(
  target: NoteTarget,
  shot: boolean,
  lead: ResolvedSourceLead | "pending" | null,
): { icon: "pick" | "region" | "shot"; comp: string; name: string; dims: string } {
  if (target.kind === "region") {
    const dims = `${Math.round(target.box.width)} × ${Math.round(target.box.height)}`
    return shot
      ? { icon: "shot", comp: "Screenshot", name: "marked-up capture", dims }
      : { icon: "region", comp: "Region", name: "place something here", dims }
  }
  const anchors = target.kind === "element" ? [target.anchor] : target.anchors
  const first = anchors[0]
  const tag =
    first?.selector
      .at(-1)
      ?.split(" > ")
      .at(-1)
      ?.match(/^[a-z][\w-]*/i)?.[0] ?? "element"
  const component = typeof lead === "object" && lead && "component" in lead ? lead.component : null
  return {
    icon: "pick",
    comp: component ? `<${component}>` : tag,
    name: anchors.length > 1 ? `${anchors.length} elements` : (first?.name ?? first?.text ?? "—"),
    dims: first ? `${Math.round(first.box.width)} × ${Math.round(first.box.height)}` : "",
  }
}

function SourceRow({ lead }: { lead: ResolvedSourceLead | "pending" | null }) {
  if (lead === null) return null
  if (lead === "pending")
    return (
      <div class="cmp-src">
        <Icon name="file" size={12} />
        <span class="pending">Finding source…</span>
      </div>
    )
  if (lead.confidence === "none")
    return (
      <div class="cmp-src uncertain">
        <Icon name="file" size={12} />
        <span class="pending">No source found</span>
        <span
          class="conf"
          role="status"
          aria-label="Source confidence"
          data-tip={NONE_REASON[lead.reason]}
        >
          none
        </span>
      </div>
    )
  const segments = lead.file.split("/")
  const file = segments.pop() ?? lead.file
  const dir = segments.at(-1)
  return (
    <div class={lead.confidence === "exact" ? "cmp-src" : "cmp-src uncertain"}>
      <Icon name="file" size={12} />
      <span class="file" title={lead.file}>
        {dir === undefined ? "" : `${dir}/`}
        <b>
          {file}
          {lead.line === undefined ? "" : `:${lead.line}`}
        </b>
      </span>
      <span class="conf" role="status" aria-label="Source confidence">
        {lead.confidence}
      </span>
    </div>
  )
}

export function Composer({
  panelRef,
  lead,
  thumb,
  attach,
  onAttach,
  onInput,
}: {
  panelRef: RefObject<HTMLDivElement | null>
  lead: ResolvedSourceLead | "pending" | null
  thumb: string | null
  attach: boolean
  onAttach: (on: boolean) => void
  onInput: () => void
}): JSX.Element | null {
  useSheet(composerCss)
  const { model, connection } = useOverlay()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [on, setOn] = useState(false)
  const composer = model.composer.value

  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // `.pop` is visibility:hidden until `on` renders, and a hidden textarea refuses focus.
  useEffect(() => {
    if (on) textRef.current?.focus()
  }, [on])

  const bodyError = composer?.bodyError ?? false
  useEffect(() => {
    if (!bodyError) return
    shake(panelRef.current)
    textRef.current?.focus()
  }, [bodyError, panelRef])

  if (!composer) return null
  const { target, intent, editing, saving } = composer
  const shot = composer.shot !== null
  const head = header(target, shot, lead)

  async function save() {
    const current = model.composer.peek()
    const body = model.beginSave()
    if (!current || !body) {
      if (model.composer.peek()?.bodyError) shake(panelRef.current)
      return
    }
    try {
      if (current.editing) {
        const existing = model.drafts.peek().find((note) => note.id === current.editing)
        connection.putDraft(current.editing, body)
        if (existing) model.noteSaved({ ...existing, ...body })
      } else {
        model.noteSaved(await connection.createDraft(body))
      }
    } catch {
      model.saveFailed()
      model.pushToast("Couldn't save the note — try again", { tone: "failed" })
    }
  }

  async function remove() {
    if (!editing) return
    try {
      await connection.deleteDraft(editing)
      model.noteDeleted(editing)
      model.setMode("idle")
    } catch {
      model.pushToast("Couldn't delete the note — try again", { tone: "failed" })
    }
  }

  function onIntentKey(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    const options = Intent.options
    const next = options[(options.indexOf(intent) + step + options.length) % options.length]
    if (!next) return
    model.setIntent(next)
    panelRef.current?.querySelector<HTMLElement>(`.intent.${next}`)?.focus()
  }

  return (
    <div
      ref={panelRef}
      class={on ? "pop composer on" : "pop composer"}
      role="dialog"
      aria-label={editing ? "Edit note" : "New note"}
    >
      <div class="cmp-h">
        <Icon name={head.icon} size={14} />
        <span class="comp">{head.comp}</span>
        <span class="nm">{head.name}</span>
        <span class="dim">{head.dims}</span>
      </div>
      {target.kind !== "region" && <SourceRow lead={lead} />}
      <div
        class="intents"
        role="radiogroup"
        aria-label="Intent"
        tabIndex={-1}
        onKeyDown={onIntentKey}
      >
        {Intent.options.map((option, i) => (
          // biome-ignore lint/a11y/useSemanticElements: the sketch's intents are pressable cards, not native radio inputs
          <button
            key={option}
            type="button"
            class={`intent ${option}`}
            role="radio"
            aria-checked={option === intent}
            aria-label={INTENT_COPY[option].label}
            tabIndex={option === intent ? 0 : -1}
            onClick={() => model.setIntent(option)}
          >
            <IntentGlyph intent={option} size={24} />
            {INTENT_COPY[option].label}
            <kbd>{i + 1}</kbd>
          </button>
        ))}
      </div>
      <div class="cmp-body">
        <textarea
          ref={textRef}
          aria-label="Note"
          aria-invalid={bodyError}
          aria-describedby="iter8-cmp-err"
          placeholder={INTENT_COPY[intent].placeholder}
          value={composer.body}
          onInput={(event) => {
            model.setBody(event.currentTarget.value)
            onInput()
          }}
        />
        <div id="iter8-cmp-err" class={bodyError ? "err on" : "err"}>
          Add a line so the agent knows what to do.
        </div>
      </div>
      <div class="attach">
        <button
          id="iter8-cmp-attach"
          type="button"
          class="switch"
          role="switch"
          aria-checked={shot || attach}
          aria-label="Attach screenshot of this"
          disabled={shot}
          onClick={() => onAttach(!attach)}
        />
        <label for="iter8-cmp-attach">
          {shot ? "Screenshot attached" : "Attach screenshot of this"}
        </label>
        <div class={shot || attach ? "tw" : "tw off"}>
          {thumb && <img src={thumb} alt="Screenshot attached" />}
        </div>
      </div>
      <div class="cmp-f">
        <span class="hint">
          <kbd>Esc</kbd> cancel
        </span>
        <span class="spacer" />
        {editing && (
          <button type="button" class="btn ghost" onClick={() => void remove()}>
            <Icon name="trash" size={14} />
            Delete
          </button>
        )}
        <button
          type="button"
          class="btn primary"
          aria-label={editing ? "Update note" : "Save note"}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? (
            "Saving…"
          ) : (
            <>
              {editing ? "Update" : "Save note"} <kbd>{MOD}</kbd>
              <kbd>↵</kbd>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
