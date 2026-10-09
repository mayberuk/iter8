import { useState } from "react"

export default function Card() {
  const [count, setCount] = useState(0)
  return (
    <article>
      <p data-source-target="card">Card in vite-react</p>
      <button type="button" onClick={() => setCount(count + 1)}>Increment card: {count}</button>
    </article>
  )
}
