<script lang="ts">
  // Phase 0 smoke component — proves the Svelte 5 toolchain wires up end to end.
  let { name = 'Mara 3' }: { name?: string } = $props();
</script>

<section class="mara-hello">
  <h1>{name}</h1>
  <p>Monorepo scaffold is alive.</p>
</section>

<style>
  .mara-hello {
    font-family: system-ui, sans-serif;
    text-align: center;
    padding: 2rem;
  }
</style>
