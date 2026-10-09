import Card from "./Card.jsx"
import Hookless from "./Hookless.jsx"
import Heavy from "./Heavy.jsx"

export default function App() {
  const path = window.location.pathname
  if (path === "/second" || path === "/second/") {
    return (
      <>
        <header><h1>Second page in vite-react</h1></header>
        <nav aria-label="Main navigation"><a href="/">Home</a></nav>
        <main><p>This is the second page in vite-react.</p></main>
        <aside aria-label="Related information"><p>Second page information.</p></aside>
        <footer><p>Footer for vite-react.</p></footer>
      </>
    )
  }
  return (
    <>
      <header><h1>vite-react</h1></header>
      <nav aria-label="Main navigation"><a href="/">Home</a><a href="/second">Second page</a></nav>
      <main>
        <section aria-labelledby="overview-heading">
          <h2 id="overview-heading">Overview</h2>
          <Card />
          <Hookless />
          <button type="button">Save</button>
        </section>
        <section aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <p>Details for the vite-react page.</p>
          <button type="button">Save</button>
        </section>
        <section aria-labelledby="notes-heading">
          <h2 id="notes-heading">Notes</h2>
          <form>
            <label htmlFor="title">Title</label>
            <input id="title" name="title" type="text" />
            <label htmlFor="notes">Notes</label>
            <textarea id="notes" name="notes" />
            <button type="button">Save</button>
          </form>
        </section>
        {(path === "/heavy" || path === "/heavy/") && <Heavy />}
      </main>
      <aside aria-label="Related information"><p>Related information for vite-react.</p></aside>
      <footer><p>Footer for vite-react.</p></footer>
    </>
  )
}
