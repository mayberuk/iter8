import { useEffect, useState } from "react"

function Ticker() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 250)
    return () => clearInterval(timer)
  }, [])

  return Array.from({ length: 60 }, (_, row) => (
    <tr key={row}>
      {Array.from({ length: 5 }, (_, cell) => (
        <td key={cell} className="border-t border-slate-100 px-3 py-1 dark:border-slate-800">
          Row {5941 + row}, cell {cell + 1}, tick {tick}
        </td>
      ))}
    </tr>
  ))
}

export default function Heavy() {
  return (
    <section aria-labelledby="heavy-heading" className="mx-auto max-w-6xl px-6 py-12">
      <h1 id="heavy-heading" className="text-3xl font-bold tracking-tight">
        Heavy mode
      </h1>
      <table className="mt-6 w-full text-left text-sm">
        <caption className="mb-3 text-left text-slate-500 dark:text-slate-400">
          6,000 rows with five cells each; 300 cells update every 250 ms.
        </caption>
        <tbody>
          {Array.from({ length: 5940 }, (_, row) => (
            <tr key={row}>
              {Array.from({ length: 5 }, (_, cell) => (
                <td key={cell} className="border-t border-slate-100 px-3 py-1 dark:border-slate-800">
                  Row {row + 1}, cell {cell + 1}
                </td>
              ))}
            </tr>
          ))}
          <Ticker />
        </tbody>
      </table>
    </section>
  )
}
