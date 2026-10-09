<script>
  let count = $state(0)
</script>

<article>
  <p data-source-target="card">Card in sveltekit</p>
  <button type="button" onclick={() => count += 1}>Increment card: {count}</button>
</article>
