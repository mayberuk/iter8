import { useState } from "react"
import { Chart } from "../components/Chart.jsx"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const DRAFTS = [22, 31, 28, 44, 52, 49, 61, 70, 66, 84, 91, 108]

const STATS = [
  { label: "Drafts this month", value: "108", delta: "+18.7%" },
  { label: "Notes published", value: "94", delta: "+12.0%" },
  { label: "Median review time", value: "14 min", delta: "−22.0%" },
  { label: "Active repositories", value: "37", delta: "+3" },
]

const ACTIVITY = Array.from({ length: 40 }, (_, index) => ({
  id: index,
  who: ["Maya", "Tomás", "Priya", "Jonas"][index % 4],
  what: ["published release notes for v2.", "approved a draft for api-gateway", "connected the billing repository", "edited the tone guide"][index % 4],
  when: `${index * 7 + 3} min ago`,
}))

export default function Dashboard() {
  const [helpOpen, setHelpOpen] = useState(false)

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <section aria-label="Key numbers" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STATS.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-sm text-slate-500 dark:text-slate-400">{stat.label}</p>
            <p className="mt-2 text-2xl font-bold">{stat.value}</p>
            <p className="mt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">{stat.delta} vs last month</p>
          </div>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section aria-labelledby="chart-heading" className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-2 dark:border-slate-800 dark:bg-slate-900">
          <h2 id="chart-heading" className="font-semibold">
            Drafts generated
          </h2>
          <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">Per month, this year</p>
          <Chart title="Drafts generated per month" labels={MONTHS} values={DRAFTS} />
        </section>

        <section aria-labelledby="activity-heading" className="flex flex-col rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h2 id="activity-heading" className="font-semibold">
            Recent activity
          </h2>
          <ul
            aria-label="Recent activity"
            tabIndex={0}
            className="mt-4 h-72 space-y-4 overflow-y-auto pr-2 text-sm focus-visible:outline-2 focus-visible:outline-red-600"
          >
            {ACTIVITY.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{item.who}</span> {item.what}
                <span className="block text-xs text-slate-400">{item.when}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="fixed bottom-6 right-6 z-20 flex flex-col items-end gap-3">
        {helpOpen && (
          <div className="w-64 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <p className="font-semibold">Need a hand?</p>
            <p className="mt-1 text-slate-600 dark:text-slate-400">Browse the docs or write to support@lumen.example.</p>
          </div>
        )}
        <button
          type="button"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen(!helpOpen)}
          className="grid size-12 place-items-center rounded-full bg-red-600 text-lg font-bold text-white shadow-lg hover:bg-red-700"
          aria-label="Help"
        >
          ?
        </button>
      </div>
    </div>
  )
}
