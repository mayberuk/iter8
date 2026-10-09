<script>
  import Card from "../lib/Card.svelte"
</script>

<svelte:head><title>sveltekit</title></svelte:head>
  <header><h1>sveltekit</h1></header>
  <nav aria-label="Main navigation"><a href="/">Home</a><a href="/second">Second page</a></nav>
  <main>
    <section aria-labelledby="overview-heading">
      <h2 id="overview-heading">Overview</h2>
      <Card />
      <button type="button">Save</button>
    </section>
    <section aria-labelledby="details-heading">
      <h2 id="details-heading">Details</h2>
      <p>Details for the sveltekit page.</p>
      <button type="button">Save</button>
    </section>
    <section aria-labelledby="notes-heading">
      <h2 id="notes-heading">Notes</h2>
      <form>
        <label for="title">Title</label>
        <input id="title" name="title" type="text" />
        <label for="notes">Notes</label>
        <textarea id="notes" name="notes"></textarea>
        <button type="button">Save</button>
      </form>
    </section>

  </main>
  <aside aria-label="Related information"><p>Related information for sveltekit.</p></aside>
  <footer><p>Footer for sveltekit.</p></footer>
