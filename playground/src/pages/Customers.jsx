import { useMemo, useState } from "react"

const FIRST = ["Ada", "Bo", "Cleo", "Dara", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun"]
const LAST = ["Abara", "Bell", "Cruz", "Dahl", "Evans", "Frost", "Gómez", "Hart", "Ito", "Joshi"]
const PLANS = ["Starter", "Team", "Scale"]
const STATUSES = ["Active", "Trial", "Churned"]

const ROWS = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1,
  name: `${FIRST[index % 10]} ${LAST[Math.floor(index / 10) % 10]}`,
  plan: PLANS[(index * 7) % 3],
  status: STATUSES[(index * 5) % 7 === 0 ? 2 : (index * 3) % 4 === 0 ? 1 : 0],
  mrr: [0, 29, 99][(index * 7) % 3] * (1 + (index % 4)),
  joined: new Date(Date.UTC(2023, 0, 1 + ((index * 37) % 900))).toISOString().slice(0, 10),
}))

const COLUMNS = [
  { key: "name", label: "Customer" },
  { key: "plan", label: "Plan" },
  { key: "status", label: "Status" },
  { key: "mrr", label: "MRR", numeric: true },
  { key: "joined", label: "Joined" },
]

const BADGE = {
  Active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  Trial: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Churned: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

export default function Customers() {
  const [sort, setSort] = useState({ key: "name", direction: 1 })

  const rows = useMemo(
    () =>
      [...ROWS].sort((a, b) => {
        const left = a[sort.key]
        const right = b[sort.key]
        const order = typeof left === "number" ? left - right : String(left).localeCompare(String(right))
        return order * sort.direction || a.id - b.id
      }),
    [sort],
  )

  const toggle = (key) =>
    setSort((current) => ({ key, direction: current.key === key ? -current.direction : 1 }))

  return (
    <section aria-labelledby="customers-heading" className="mx-auto max-w-5xl">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h2 id="customers-heading" className="text-xl font-semibold">
            All customers
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">{ROWS.length} accounts</p>
        </div>
      </div>
      <div className="max-h-[calc(100vh-14rem)] overflow-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Customers, sortable by column</caption>
          <thead>
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sort.key === column.key ? (sort.direction === 1 ? "ascending" : "descending") : "none"}
                  className={`sticky top-0 z-10 border-b border-slate-200 bg-slate-100 p-0 dark:border-slate-800 dark:bg-slate-800 ${
                    column.numeric ? "text-right" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => toggle(column.key)}
                    className="w-full px-4 py-3 font-semibold hover:text-red-700 dark:hover:text-red-300"
                    style={{ textAlign: column.numeric ? "right" : "left" }}
                  >
                    {column.label}
                    {sort.key === column.key && <span aria-hidden="true">{sort.direction === 1 ? " ↑" : " ↓"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="px-4 py-3 font-medium">{row.name}</td>
                <td className="px-4 py-3">{row.plan}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BADGE[row.status]}`}>{row.status}</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">${row.mrr}</td>
                <td className="px-4 py-3 text-slate-500 dark:text-slate-400">{row.joined}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
