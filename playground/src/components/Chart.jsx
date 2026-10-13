const WIDTH = 640
const HEIGHT = 240
const PAD = { top: 16, right: 16, bottom: 28, left: 40 }

export function Chart({ title, labels, values }) {
  const max = Math.ceil(Math.max(...values) / 10) * 10
  const innerW = WIDTH - PAD.left - PAD.right
  const innerH = HEIGHT - PAD.top - PAD.bottom
  const x = (index) => PAD.left + (index / (values.length - 1)) * innerW
  const y = (value) => PAD.top + innerH - (value / max) * innerH
  const line = values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)} ${y(value)}`).join(" ")
  const area = `${line} L${x(values.length - 1)} ${PAD.top + innerH} L${x(0)} ${PAD.top + innerH} Z`
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * max)

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title} className="h-auto w-full">
      <defs>
        <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#dc2626" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#dc2626" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="stroke-slate-200 dark:stroke-slate-800" />
          <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" className="fill-slate-400 text-[11px]">
            {tick}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#chart-fill)" />
      <path d={line} fill="none" stroke="#dc2626" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {values.map((value, index) => (
        <g key={labels[index]}>
          <circle cx={x(index)} cy={y(value)} r="4" className="fill-white stroke-red-600 dark:fill-slate-950" strokeWidth="2">
            <title>{`${labels[index]}: ${value}`}</title>
          </circle>
          <text x={x(index)} y={HEIGHT - 8} textAnchor="middle" className="fill-slate-400 text-[11px]">
            {labels[index]}
          </text>
        </g>
      ))}
    </svg>
  )
}
