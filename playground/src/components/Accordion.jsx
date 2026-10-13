import { useId, useState } from "react"

export function Accordion({ items }) {
  const [open, setOpen] = useState(0)
  const base = useId()

  return (
    <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
      {items.map((item, index) => {
        const expanded = open === index
        return (
          <div key={item.question}>
            <h3>
              <button
                type="button"
                id={`${base}-button-${index}`}
                aria-expanded={expanded}
                aria-controls={`${base}-panel-${index}`}
                onClick={() => setOpen(expanded ? null : index)}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-base font-medium hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                {item.question}
                <svg
                  viewBox="0 0 20 20"
                  className={`size-5 shrink-0 text-slate-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
                </svg>
              </button>
            </h3>
            <div
              id={`${base}-panel-${index}`}
              role="region"
              aria-labelledby={`${base}-button-${index}`}
              hidden={!expanded}
              className="px-5 pb-5 text-slate-600 dark:text-slate-400"
            >
              {item.answer}
            </div>
          </div>
        )
      })}
    </div>
  )
}
