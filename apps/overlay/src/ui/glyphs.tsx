import type { Intent } from "@iter8/protocol"
import type { JSX } from "preact"
import { useId } from "preact/hooks"

const X_PATH = "m4 4 8 8M12 4l-8 8"

type IconData = {
  viewBox: 16 | 24
  kind: "fill" | "stroke"
  paths: { d: string; fillRule?: "evenodd" }[]
}

const ICONS = {
  pick: {
    viewBox: 16,
    kind: "stroke",
    paths: [{ d: "M3 3l4.2 10.2 1.6-4.4 4.4-1.6z" }, { d: "M9.2 9.2 13 13" }],
  },
  region: {
    viewBox: 16,
    kind: "fill",
    paths: [
      {
        d: "M3.5 11a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m9 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m-3 1a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1zm-6-6c.28 0 .5.22.5.5v3a.5.5 0 0 1-1 0v-3c0-.28.22-.5.5-.5m9 0c.28 0 .5.22.5.5v3a.5.5 0 0 1-1 0v-3c0-.28.22-.5.5-.5m-9-4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m9 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m-3 1a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1z",
      },
    ],
  },
  shot: {
    viewBox: 16,
    kind: "fill",
    paths: [
      {
        d: "M5 1.5a.5.5 0 0 0-1 0V4H1.5a.5.5 0 0 0 0 1H4v4.5A2.5 2.5 0 0 0 6.5 12H11v2.5a.5.5 0 0 0 1 0V12h2.5a.5.5 0 0 0 0-1h-8A1.5 1.5 0 0 1 5 9.5zm6 5V10h1V6.5A2.5 2.5 0 0 0 9.5 4H6v1h3.5c.83 0 1.5.67 1.5 1.5",
      },
    ],
  },
  send: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M17.991 6.01 5.399 10.563l4.195 2.428 3.699-3.7a1 1 0 0 1 1.414 1.415l-3.7 3.7 2.43 4.194L17.99 6.01Zm.323-2.244c1.195-.433 2.353.725 1.92 1.92l-5.282 14.605c-.434 1.198-2.07 1.344-2.709.241l-3.217-5.558-5.558-3.217c-1.103-.639-.957-2.275.241-2.709z",
        fillRule: "evenodd",
      },
    ],
  },
  x: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "m12 13.414 5.657 5.657a1 1 0 0 0 1.414-1.414L13.414 12l5.657-5.657a1 1 0 0 0-1.414-1.414L12 10.586 6.343 4.929A1 1 0 0 0 4.93 6.343L10.586 12l-5.657 5.657a1 1 0 1 0 1.414 1.414z",
        fillRule: "evenodd",
      },
    ],
  },
  edit: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M16.035 3.015a3 3 0 0 1 4.099-.135l.144.135.707.707a3 3 0 0 1 .135 4.098l-.135.144L9.773 19.177a1.5 1.5 0 0 1-.562.354l-.162.047-4.454 1.028a1.001 1.001 0 0 1-1.22-1.088l.02-.113 1.027-4.455a1.5 1.5 0 0 1 .29-.598l.111-.125zm-.707 3.535-8.99 8.99-.636 2.758 2.758-.637 8.99-8.99-2.122-2.12Zm3.536-2.121a1 1 0 0 0-1.32-.083l-.094.083-.708.707 2.122 2.121.707-.707a1 1 0 0 0 .083-1.32l-.083-.094z",
      },
    ],
  },
  trash: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M14.28 2a2 2 0 0 1 1.897 1.368L16.72 5H20a1 1 0 1 1 0 2l-.003.071-.867 12.143A3 3 0 0 1 16.138 22H7.862a3 3 0 0 1-2.992-2.786L4.003 7.07A1.01 1.01 0 0 1 4 7a1 1 0 0 1 0-2h3.28l.543-1.632A2 2 0 0 1 9.721 2zm3.717 5H6.003l.862 12.071a1 1 0 0 0 .997.929h8.276a1 1 0 0 0 .997-.929zM10 10a1 1 0 0 1 .993.883L11 11v5a1 1 0 0 1-1.993.117L9 16v-5a1 1 0 0 1 1-1m4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1m.28-6H9.72l-.333 1h5.226z",
      },
    ],
  },
  grip: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M5.5 17a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m-13-6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M5.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3M12 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6.5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3",
      },
    ],
  },
  check: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M21.192 5.465a1 1 0 0 1 0 1.414L9.95 18.122a1.1 1.1 0 0 1-1.556 0l-5.586-5.586a1 1 0 1 1 1.415-1.415l4.95 4.95L19.777 5.465a1 1 0 0 1 1.414 0Z",
        fillRule: "evenodd",
      },
    ],
  },
  file: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M13.586 2a2 2 0 0 1 1.284.467l.13.119L19.414 7a2 2 0 0 1 .578 1.238l.008.176V20a2 2 0 0 1-1.85 1.995L18 22H6a2 2 0 0 1-1.995-1.85L4 20V4a2 2 0 0 1 1.85-1.995L6 2zM12 4H6v16h12V10h-4.5A1.5 1.5 0 0 1 12 8.5zm2 .414V8h3.586z",
      },
    ],
  },
  arrow: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M18 5a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V8.414l-9.95 9.95a1 1 0 0 1-1.414-1.414L15.586 7H10a1 1 0 1 1 0-2h8Z",
      },
    ],
  },
  box: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zm18 0H4v12h16z",
        fillRule: "evenodd",
      },
    ],
  },
  hl: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2m2.153 13H9.847l-.743 4.46A7.98 7.98 0 0 0 12 20c.894 0 1.753-.147 2.556-.417l.34-.123zM12 4a8 8 0 0 0-4.753 14.436l.627-3.765A2 2 0 0 1 9 13.188v-3.182c0-.382.216-.732.558-.903l3.98-1.99A1.01 1.01 0 0 1 15 8.016v5.172a2 2 0 0 1 1.126 1.483l.627 3.765A8 8 0 0 0 12 4m1 5.618-2 1V13h2z",
        fillRule: "evenodd",
      },
    ],
  },
  undo: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M3.076 5.617A1 1 0 0 1 4 5h10a7 7 0 1 1 0 14H5a1 1 0 1 1 0-2h9a5 5 0 1 0 0-10H6.414l1.793 1.793a1 1 0 0 1-1.414 1.414l-3.5-3.5a1 1 0 0 1-.217-1.09Z",
        fillRule: "evenodd",
      },
    ],
  },
  search: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M10.5 2a8.5 8.5 0 1 0 5.262 15.176l3.652 3.652a1 1 0 0 0 1.414-1.414l-3.652-3.652A8.5 8.5 0 0 0 10.5 2M4 10.5a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0",
        fillRule: "evenodd",
      },
    ],
  },
  keys: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M20 4a2 2 0 0 1 1.995 1.85L22 6v12a2 2 0 0 1-1.85 1.995L20 20H4a2 2 0 0 1-1.995-1.85L2 18V6a2 2 0 0 1 1.85-1.995L4 4zm0 2H4v12h16zm-3 8a1 1 0 0 1 .117 1.993L17 16H7a1 1 0 0 1-.117-1.993L7 14zm-9-3a1 1 0 1 1 0 2H7a1 1 0 1 1 0-2zm4.5 0a1 1 0 0 1 .117 1.993L12.5 13h-1a1 1 0 0 1-.117-1.993L11.5 11zm4.5 0a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2zM8 8a1 1 0 0 1 .117 1.993L8 10H7a1 1 0 0 1-.117-1.993L7 8zm4.5 0a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2zM17 8a1 1 0 0 1 .117 1.993L17 10h-1a1 1 0 0 1-.117-1.993L16 8z",
      },
    ],
  },
  term: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2H5v14h14zm-3 9a1 1 0 0 1 .117 1.993L16 16h-2a1 1 0 0 1-.117-1.993L14 14zM9.05 8.465l2.829 2.828a1 1 0 0 1 0 1.414L9.05 15.536a1 1 0 0 1-1.414-1.415l2.121-2.12-2.12-2.122A1 1 0 1 1 9.05 8.465",
      },
    ],
  },
  layers: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M12.528 1.118a1 1 0 0 1 1.027.05l5.554 3.703A2 2 0 0 1 20 6.535V17a1 1 0 0 1-1.555.832L16 16.202V19a1 1 0 0 1-1.555.832L12 18.202V21a1 1 0 0 1-1.555.832L4.891 18.13A2 2 0 0 1 4 16.465V6a1 1 0 0 1 1.555-.832L8 6.798V4a1 1 0 0 1 1.555-.832L12 4.798V2a1 1 0 0 1 .528-.882M14 6.131l1.11.74A2 2 0 0 1 16 8.535v5.263l2 1.334V6.535L14 3.87v2.26Zm-4 2 1.11.74a2 2 0 0 1 .89 1.664v5.263l2 1.333V8.535L10 5.87zM6 7.87v8.596l4 2.666v-8.596z",
        fillRule: "evenodd",
      },
    ],
  },
  compare: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm6 2H5v14h6zm2 14V5h6v14z",
        fillRule: "evenodd",
      },
    ],
  },
  eye: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M12 4c2.787 0 5.263 1.257 7.026 2.813.885.781 1.614 1.658 2.128 2.531.505.857.846 1.786.846 2.656 0 .87-.34 1.799-.846 2.656-.514.873-1.243 1.75-2.128 2.531C17.263 18.743 14.786 20 12 20c-2.787 0-5.263-1.257-7.026-2.813-.885-.781-1.614-1.658-2.128-2.531C2.34 13.799 2 12.87 2 12c0-.87.34-1.799.846-2.656.514-.873 1.243-1.75 2.128-2.531C6.737 5.257 9.214 4 12 4m0 2c-2.184 0-4.208.993-5.702 2.312-.744.656-1.332 1.373-1.729 2.047C4.163 11.049 4 11.62 4 12c0 .38.163.951.569 1.641.397.674.985 1.39 1.729 2.047C7.792 17.007 9.816 18 12 18s4.208-.993 5.702-2.312c.744-.657 1.332-1.373 1.729-2.047.406-.69.569-1.261.569-1.641 0-.38-.163-.951-.569-1.641-.397-.674-.985-1.39-1.729-2.047C16.208 6.993 14.184 6 12 6m0 3c.088 0 .175.004.261.011a2 2 0 0 0 2.728 2.728A3 3 0 1 1 12 9",
      },
    ],
  },
  history: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M20.66 7c2.762 4.783 1.123 10.9-3.66 13.66-4.123 2.38-9.233 1.491-12.335-1.86a1 1 0 0 1 1.468-1.358 8 8 0 1 0-2.06-6.524l1.281-.335c1.047-.273 1.818.97 1.108 1.787L4.21 14.957c-.568.652-1.665.43-1.892-.444A10.003 10.003 0 0 1 7 3.34C11.783.579 17.899 2.217 20.66 7M12 6a1 1 0 0 1 1 1v4.586l2.707 2.707a1 1 0 1 1-1.414 1.414l-3-3A1 1 0 0 1 11 12V7a1 1 0 0 1 1-1",
      },
    ],
  },
  collapse: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M12 2c.375 0 .745.02 1.11.061a1 1 0 0 1-.22 1.988 8 8 0 1 0 7.061 7.061 1 1 0 1 1 1.988-.22c.04.365.061.735.061 1.11 0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2m-.032 5.877a1 1 0 0 1-.719 1.217A3.002 3.002 0 0 0 12 15a3.002 3.002 0 0 0 2.906-2.25 1 1 0 0 1 1.936.5A5.002 5.002 0 0 1 7 12a5.002 5.002 0 0 1 3.75-4.842 1 1 0 0 1 1.218.719m6.536-5.75a1 1 0 0 1 .617.923v1.83h1.829a1 1 0 0 1 .707 1.707L18.12 10.12a1 1 0 0 1-.707.293H15l-1.828 1.829a1 1 0 0 1-1.415-1.415L13.586 9V6.586a1 1 0 0 1 .293-.707l3.535-3.536a1 1 0 0 1 1.09-.217m-1.383 3.337L15.586 7v1.414H17l1.536-1.535h-.415a1 1 0 0 1-1-1z",
      },
    ],
  },
  more: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3m6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3",
      },
    ],
  },
  sun: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M12 19a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 1-1m6.364-2.05.707.707a1 1 0 0 1-1.414 1.414l-.707-.707a1 1 0 0 1 1.414-1.414m-12.728 0a1 1 0 0 1 1.497 1.32l-.083.094-.707.707a1 1 0 0 1-1.497-1.32l.083-.094zM12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12m0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-8 3a1 1 0 0 1 .117 1.993L4 13H3a1 1 0 0 1-.117-1.993L3 11zm17 0a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2zM4.929 4.929a1 1 0 0 1 1.32-.083l.094.083.707.707a1 1 0 0 1-1.32 1.497l-.094-.083-.707-.707a1 1 0 0 1 0-1.414m14.142 0a1 1 0 0 1 0 1.414l-.707.707a1 1 0 1 1-1.414-1.414l.707-.707a1 1 0 0 1 1.414 0M12 2a1 1 0 0 1 1 1v1a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1",
      },
    ],
  },
  moon: {
    viewBox: 24,
    kind: "fill",
    paths: [
      {
        d: "M13.574 3.137a1.01 1.01 0 0 0-1.097 1.409 6 6 0 0 1-7.931 7.931 1.01 1.01 0 0 0-1.409 1.097A9 9 0 0 0 21 12c0-4.434-3.206-8.118-7.426-8.863m1.307 2.481A7.002 7.002 0 0 1 12 19a7.002 7.002 0 0 1-6.382-4.12 8 8 0 0 0 9.263-9.263Z",
        fillRule: "evenodd",
      },
    ],
  },
  auto: {
    viewBox: 16,
    kind: "fill",
    paths: [{ d: "M8 1a7 7 0 1 1 0 14A7 7 0 0 1 8 1m0 1a6 6 0 0 0-6 6h12a6 6 0 0 0-6-6" }],
  },
} satisfies Record<string, IconData>

export type IconName = keyof typeof ICONS

const INK = {
  fill: { fill: "currentColor" },
  stroke: {
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.5,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  },
} as const

/** Two stacked copies of the paths: a shaded one a CSS pixel lower, the coloured one on top. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const data: IconData = ICONS[name]
  const { viewBox, kind, paths } = data
  const shapes = () => paths.map(({ d, fillRule }) => <path key={d} d={d} fill-rule={fillRule} />)
  return (
    <svg
      class={`ic ic-${kind}`}
      width={size}
      height={size}
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      aria-hidden="true"
      style={{ overflow: "visible" }}
    >
      <g class="ic-d" transform={`translate(0 ${viewBox / size})`} {...INK[kind]}>
        {shapes()}
      </g>
      <g {...INK[kind]}>{shapes()}</g>
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
