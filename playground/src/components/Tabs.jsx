import { useId, useRef, useState } from "react"

export function Tabs({ label, tabs }) {
  const [active, setActive] = useState(tabs[0].id)
  const base = useId()
  const buttons = useRef({})

  const move = (event, index) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key]
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null
    const target = next ?? (step === undefined ? null : (index + step + tabs.length) % tabs.length)
    if (target === null) return
    event.preventDefault()
    const tab = tabs[target]
    setActive(tab.id)
    buttons.current[tab.id]?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[tab.id] = node
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => move(event, index)}
            className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              active === tab.id
                ? "border-red-600 text-red-700 dark:border-red-400 dark:text-red-300"
                : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={active !== tab.id}
          className="pt-6"
        >
          {tab.content}
        </div>
      ))}
    </div>
  )
}
