<script lang="ts">
  import { Hello } from '@mara/ui';
  import { PROTOCOL_VERSION } from '@mara/protocol';
</script>

<main>
  <Hello name="Mara 3" />
  <p class="proto">protocol v{PROTOCOL_VERSION}</p>
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    place-content: center;
    background: var(--mara-bg, #1e1e1e);
    color: var(--mara-fg, #e6e6e6);
  }
  .proto {
    text-align: center;
    opacity: 0.5;
    font-family: ui-monospace, monospace;
  }
</style>
