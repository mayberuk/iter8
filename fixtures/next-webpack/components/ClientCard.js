"use client"

import { useState } from "react"

export default function ClientCard() {
  const [count, setCount] = useState(0)
  return (
    <article>
      <p data-source-target="client">Client in next-turbopack and next-webpack</p>
      <button type="button" onClick={() => setCount(count + 1)}>Increment client: {count}</button>
    </article>
  )
}
