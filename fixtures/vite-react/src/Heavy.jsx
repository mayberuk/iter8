import Ticker from "./Ticker.jsx"

export default function Heavy() {
  return (
    <section aria-labelledby="heavy-heading">
      <h2 id="heavy-heading">Heavy page in vite-react</h2>
      <table>
        <caption>6,000 rows with five cells each; 300 cells update every 250 ms.</caption>
        <tbody>
          {Array.from({ length: 5940 }, (_, row) => (
            <tr key={row}>
              {Array.from({ length: 5 }, (_, cell) => (
                <td key={cell}>Row {row + 1}, cell {cell + 1}</td>
              ))}
            </tr>
          ))}
          <Ticker />
        </tbody>
      </table>
    </section>
  )
}
