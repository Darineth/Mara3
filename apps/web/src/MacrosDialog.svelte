<script lang="ts">
  import { MACRO_COUNT } from './lib/settings.js';

  let { macros, onClose }: { macros: string[]; onClose: () => void } = $props();

  let backdrop = $state<HTMLDivElement | null>(null);

  // Close on backdrop click (imperative, so the backdrop needs no declarative
  // interactive handler) and on Escape.
  $effect(() => {
    const el = backdrop;
    if (!el) return;
    const onBackdrop = (e: Event) => {
      if (e.target === el) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    el.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKey);
    };
  });

  const slots = Array.from({ length: MACRO_COUNT }, (_, i) => i);
</script>

<div class="backdrop" bind:this={backdrop}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Macros">
    <header>
      <h2>Macros</h2>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <p class="hint">Press F1–F12 in the message box to insert these snippets.</p>
    <div class="rows">
      {#each slots as i (i)}
        <label>
          <span class="key">F{i + 1}</span>
          <input bind:value={macros[i]} placeholder="(empty)" maxlength="500" spellcheck="false" />
        </label>
      {/each}
    </div>
    <footer>
      <button class="done" onclick={onClose}>Done</button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .dialog {
    width: min(440px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    background: var(--mara-bg-alt, #252526);
    color: var(--mara-fg, #e6e6e6);
    border: 1px solid var(--mara-border, #333);
    border-radius: 10px;
    padding: 1rem 1.1rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  .close {
    background: none;
    border: none;
    color: inherit;
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
  }
  .hint {
    margin: 0.25rem 0 0.75rem;
    font-size: 0.8rem;
    opacity: 0.6;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .key {
    width: 2.4rem;
    flex: none;
    font-family: var(--mara-mono, monospace);
    font-size: 0.8rem;
    opacity: 0.7;
    text-align: right;
  }
  input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }
  .done {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    background: var(--mara-accent, #3b82f6);
    color: #fff;
    cursor: pointer;
  }
</style>
