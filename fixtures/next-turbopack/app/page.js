import ClientCard from "../components/ClientCard.js"
import ServerCard from "../components/ServerCard.js"

export default function Home() {
  return (
    <>
      <header><h1>Next.js</h1></header>
      <nav aria-label="Main navigation"><a href="/">Home</a><a href="/second">Second page</a></nav>
      <main>
        <section aria-labelledby="overview-heading">
          <h2 id="overview-heading">Overview</h2>
          <ClientCard />
          <ServerCard />
          <button type="button">Save</button>
        </section>
        <section aria-labelledby="details-heading">
          <h2 id="details-heading">Details</h2>
          <p>Details for the Next.js page.</p>
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

      </main>
      <aside aria-label="Related information"><p>Related information for Next.js.</p></aside>
      <footer><p>Footer for Next.js.</p></footer>
    </>
  )
}
