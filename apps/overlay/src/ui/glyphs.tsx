import type { Intent } from "@iter8/protocol"
import type { JSX } from "preact"
import { useId } from "preact/hooks"

const X_PATH = "m4 4 8 8M12 4l-8 8"

const ICONS = {
  pick: () => (
    <>
      <path d="M3 3l4.2 10.2 1.6-4.4 4.4-1.6z" />
      <path d="M9.2 9.2 13 13" />
    </>
  ),
  region: () => (
    <>
      <path d="M2.5 5V3.5a1 1 0 0 1 1-1H5M11 2.5h1.5a1 1 0 0 1 1 1V5M13.5 11v1.5a1 1 0 0 1-1 1H11M5 13.5H3.5a1 1 0 0 1-1-1V11" />
      <path d="M6 8h4M8 6v4" />
    </>
  ),
  shot: () => (
    <>
      <path d="M4.5 1.5v9a1 1 0 0 0 1 1h9" />
      <path d="M1.5 4.5h9a1 1 0 0 1 1 1v9" />
    </>
  ),
  send: () => <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />,
  x: () => <path d={X_PATH} />,
  edit: () => <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  trash: () => <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 9h6.6l.7-9" />,
  grip: () => (
    <>
      <circle cx="6" cy="4" r=".9" />
      <circle cx="10" cy="4" r=".9" />
      <circle cx="6" cy="8" r=".9" />
      <circle cx="10" cy="8" r=".9" />
      <circle cx="6" cy="12" r=".9" />
      <circle cx="10" cy="12" r=".9" />
    </>
  ),
  check: () => <path d="m3.5 8.5 3 3 6-7" />,
  file: () => (
    <>
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </>
  ),
  arrow: () => <path d="M3 13 13 3M7 3h6v6" />,
  box: () => <rect x="2.5" y="3.5" width="11" height="9" rx="1" />,
  hl: () => (
    <>
      <path d="M2 12.5h12" />
      <path d="m4 10 5.5-7 3 2.3L7 12.3H4z" />
    </>
  ),
  undo: () => (
    <>
      <path d="M5.5 3 2.5 6l3 3" />
      <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H7" />
    </>
  ),
  search: () => (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  keys: () => (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 7h.5M6.5 7h.5M9 7h.5M11.5 7h.5M5 9.5h6" />
    </>
  ),
  term: () => (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6 2 2-2 2M8.5 10.5h3" />
    </>
  ),
  layers: () => (
    <>
      <path d="M8 2 14 5 8 8 2 5z" />
      <path d="m2 8 6 3 6-3M2 11l6 3 6-3" />
    </>
  ),
  compare: () => (
    <>
      <path d="M8 1.5v13" />
      <rect x="2" y="3.5" width="12" height="9" rx="1.2" />
    </>
  ),
  eye: () => (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  history: () => (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7" />
      <path d="M2.5 2.5v3.2h3.2M8 5v3.2l2 1.3" />
    </>
  ),
  collapse: () => (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  more: () => (
    <>
      <circle cx="3.5" cy="8" r=".6" />
      <circle cx="8" cy="8" r=".6" />
      <circle cx="12.5" cy="8" r=".6" />
    </>
  ),
  sun: () => (
    <>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </>
  ),
  moon: () => <path d="M13.2 10.2A5.6 5.6 0 0 1 5.8 2.8a5.6 5.6 0 1 0 7.4 7.4z" />,
  auto: () => (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" />
    </>
  ),
}

export type IconName = keyof typeof ICONS

/** Two stacked copies of the strokes: a shaded one offset 1px down, the coloured one on top. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths = ICONS[name]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      style={{ overflow: "visible" }}
    >
      <g class="ic-d" transform="translate(0 1)">
        {paths()}
      </g>
      <g stroke="currentColor">{paths()}</g>
    </svg>
  )
}

const INTENT_GLYPHS: Record<
  Intent,
  { shape: () => JSX.Element; face?: () => JSX.Element; detail: () => JSX.Element }
> = {
  fix: {
    shape: () => (
      <rect x="1.5" y="6.5" width="17" height="7" rx="3.5" transform="rotate(-40 10 10)" />
    ),
    detail: () => (
      <g transform="rotate(-40 10 10)">
        <rect class="hi" x="7.2" y="6.5" width="5.6" height="7" />
        <circle class="hi" cx="4.2" cy="10" r=".9" />
        <circle class="hi" cx="15.8" cy="10" r=".9" />
      </g>
    ),
  },
  change: {
    shape: () => (
      <path
        transform="rotate(-45 10 10)"
        d="M2.4 7.5H14l5 2.5-5 2.5H2.4a1.4 1.4 0 0 1-1.4-1.4V8.9a1.4 1.4 0 0 1 1.4-1.4z"
      />
    ),
    detail: () => (
      <g transform="rotate(-45 10 10)">
        <path d="M14 7.5l5 2.5-5 2.5z" fill="#F7E4C2" />
        <path d="M17.3 8.85 19 10l-1.7 1.15z" class="gd" />
        <rect class="hi" x="3.6" y="7.5" width="1.5" height="5" />
      </g>
    ),
  },
  question: {
    shape: () => (
      <path d="M4.5 2.5h11a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9.2l-3.7 3.3v-3.3h-1a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z" />
    ),
    detail: () => (
      <>
        <path class="ln" d="M7.9 6.7a2.15 2.15 0 1 1 2.9 2c-.5.25-.8.6-.8 1.15v.25" />
        <circle cx="10" cy="12.15" r="1.05" fill="#fff" />
      </>
    ),
  },
  keep: {
    shape: () => (
      <>
        <rect x="2" y="3.5" width="16" height="4.2" rx="2.1" />
        <circle cx="3.7" cy="13.4" r="1.75" />
        <circle cx="7.9" cy="13.4" r="1.75" />
        <circle cx="12.1" cy="13.4" r="1.75" />
        <circle cx="16.3" cy="13.4" r="1.75" />
      </>
    ),
    face: () => (
      <>
        <rect x="2" y="3.5" width="16" height="4.2" rx="2.1" />
        <circle class="dt" cx="3.7" cy="13.4" r="1.75" />
        <circle class="dt" cx="7.9" cy="13.4" r="1.75" />
        <circle class="dt" cx="12.1" cy="13.4" r="1.75" />
        <circle class="dt" cx="16.3" cy="13.4" r="1.75" />
      </>
    ),
    detail: () => <rect class="hi" x="4" y="4.4" width="7" height="1.1" rx=".55" />,
  },
}

export function IntentGlyph({ intent, size = 20 }: { intent: Intent; size?: number }) {
  const glyph = INTENT_GLYPHS[intent]
  return (
    <svg
      class={`gl g-${intent}`}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      style={{ "--c": `var(--${intent})`, "--cd": `var(--${intent}-d)` }}
      aria-hidden="true"
    >
      <g class="mv">
        <g class="gd" transform="translate(0 1.7)">
          {glyph.shape()}
        </g>
        <g class="gf">{(glyph.face ?? glyph.shape)()}</g>
        {glyph.detail()}
      </g>
    </svg>
  )
}

const STATUS_GLYPHS = {
  queued: () => (
    <>
      <path
        class="d"
        transform="translate(0 1)"
        d="M2.5 10.5v3.8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3.8h-3.6a2.4 2.4 0 0 1-4.8 0z"
      />
      <path
        class="f"
        d="M2.5 10.5v3.8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3.8h-3.6a2.4 2.4 0 0 1-4.8 0z"
      />
      <g class="slip">
        <rect class="paper" x="5.5" y="2" width="7" height="6.2" rx="1" />
        <rect class="f" x="5.5" y="2" width="7" height="6.2" rx="1" />
        <path class="f" d="M7.3 4.3h3.4M7.3 6.1h2" />
      </g>
    </>
  ),
  delivered: (clipId: string) => (
    <>
      <defs>
        <clipPath id={clipId}>
          <rect x="-2" y="-12" width="22" height="24.2" />
        </clipPath>
      </defs>
      <rect class="d" transform="translate(0 1)" x="2" y="10" width="14" height="5.5" rx="1.6" />
      <g clip-path={`url(#${clipId})`}>
        <g class="note">
          <rect class="paper" x="5.8" y="2.6" width="6.4" height="9.4" rx=".8" />
          <rect class="f" x="5.8" y="2.6" width="6.4" height="9.4" rx=".8" />
          <path class="f" d="M5.9 3.2 9 5.6l3.1-2.4" />
        </g>
      </g>
      <rect class="paper" x="2" y="10" width="14" height="5.5" rx="1.6" />
      <rect class="f" x="2" y="10" width="14" height="5.5" rx="1.6" />
      <path class="f" d="M5 12.2h8" stroke-width="2" />
    </>
  ),
  working: () => (
    <>
      <g class="trail">
        <path class="d" transform="translate(0 1)" d="M2 13q2.25-3 4.5 0t4.5 0" />
        <path class="f" d="M2 13q2.25-3 4.5 0t4.5 0" />
      </g>
      <g class="nib">
        <path class="paper" d="M11 13l1.2-4.2 3.6-3.6a1.3 1.3 0 0 1 1.8 1.8l-3.6 3.6z" />
        <path
          class="fill"
          d="M11 13l1.2-4.2 3.6-3.6a1.3 1.3 0 0 1 1.8 1.8l-3.6 3.6z"
          opacity=".22"
        />
        <path class="f" d="M11 13l1.2-4.2 3.6-3.6a1.3 1.3 0 0 1 1.8 1.8l-3.6 3.6zM11 13l2.6-2.6" />
      </g>
    </>
  ),
  done: () => (
    <>
      <circle class="d" transform="translate(0 1)" cx="9" cy="9.2" r="6.5" />
      <circle class="f rg" cx="9" cy="9.2" r="6.5" transform="rotate(-90 9 9.2)" />
      <path class="f tick" d="M6.1 9.4l2 2 3.9-4.3" stroke-width="1.8" />
    </>
  ),
  answered: () => (
    <>
      <path
        class="d"
        transform="translate(0 1)"
        d="M3 3.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H8l-3.2 2.8V13H3a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 3 3.5z"
      />
      <path
        class="f"
        d="M3 3.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H8l-3.2 2.8V13H3a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 3 3.5z"
      />
      <path class="f l1" d="M5 6.8h7" />
      <path class="f l2" d="M5 9.5h4.6" />
    </>
  ),
  failed: () => (
    <g transform="translate(1 1)">
      <path class="d" transform="translate(0 1)" d={X_PATH} />
      <path class="f" d={X_PATH} />
    </g>
  ),
}

export type StatusKey = keyof typeof STATUS_GLYPHS

/** `useId` keeps the delivered glyph's clipPath id unique across the many instances in one shadow root. */
export function StatusGlyph({ state }: { state: StatusKey }) {
  const clipId = useId()
  return (
    <svg class={`sg sg-${state}`} viewBox="0 0 18 18" aria-hidden="true">
      {STATUS_GLYPHS[state](clipId)}
    </svg>
  )
}

const METER_VARIANTS = {
  live: "",
  busy: "busy",
  gone: "gone",
  checking: "faint still",
  delivered: "delivered",
  unattached: "faint still",
}

export type MeterKey = keyof typeof METER_VARIANTS

const METER_BAR_X = [0, 4.6, 9.2, 13.8, 18.4]

export function Meter({
  state,
  still = false,
  size = "dock",
}: {
  state: MeterKey
  still?: boolean
  size?: "dock" | "small"
}) {
  const classes = [
    "meter",
    METER_VARIANTS[state],
    still ? "still" : "",
    size === "small" ? "small" : "",
  ]
  return (
    <svg class={classes.filter(Boolean).join(" ")} viewBox="0 0 23 15" aria-hidden="true">
      {/* Scaling an SVG-internal element lays out the page every frame; HTML inside foreignObject composites. */}
      <foreignObject width="23" height="15">
        {METER_BAR_X.map((x) => (
          <span key={x} class="mb" style={{ left: `${x}px` }}>
            <i class="md" />
            <i class="mf" />
          </span>
        ))}
      </foreignObject>
    </svg>
  )
}

/** Renders the `claude-mark` symbol that `Avatar` references; mount it once per shadow root. */
export function ClaudeMarkSymbol() {
  return (
    <svg class="symbols" width="0" height="0" aria-hidden="true">
      <symbol id="claude-mark" viewBox="0 0 100 100">
        <path
          fill="hsl(14.8, 63.1%, 59.6%)"
          d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"
        />
      </symbol>
    </svg>
  )
}

export function Avatar({ agent, size }: { agent: string; size: number }) {
  const isClaude = agent === "claude"
  return (
    <span
      class={isClaude ? "av claude" : "av agent"}
      style={{ "--s": `${size}px` }}
      role="img"
      aria-label={isClaude ? "Claude" : agent}
    >
      {isClaude ? (
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <use href="#claude-mark" />
        </svg>
      ) : (
        <span>{agent.slice(0, 2)}</span>
      )}
    </span>
  )
}
