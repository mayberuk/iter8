import { useEffect, useState } from "react"

export default function Ticker() {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 250)
    return () => clearInterval(timer)
  }, [])

  return Array.from({ length: 60 }, (_, row) => (
    <tr key={row}>
      {Array.from({ length: 5 }, (_, cell) => (
        <td key={cell}>Row {5941 + row}, cell {cell + 1}, tick {tick}</td>
      ))}
    </tr>
  ))
}
