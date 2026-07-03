<!--
  In-session options: change display name, colour, and theme without disconnecting.
  Name/colour changes are broadcast to everyone (the parent calls client.setProfile);
  the parent persists settings on apply. Mirrors MacrosDialog's modal pattern.
-->
<script lang="ts">
  import type { MaraSettings, Theme } from './lib/settings.js';
  import IdentityControls from './IdentityControls.svelte';

  let {
    settings,
    onApply,
    onClose,
  }: {
    settings: MaraSettings;
    onApply: (next: {
      name: string;
      color: string;
      theme: Theme;
      keepPmHistory: boolean;
      pmsInWindows: boolean;
    }) => void;
    onClose: () => void;
  } = $props();

  // Local working copies, seeded from the current settings (edited then applied on Save).
  // svelte-ignore state_referenced_locally
  let name = $state(settings.name);
  // svelte-ignore state_referenced_locally
  let color = $state(settings.color);
  // svelte-ignore state_referenced_locally
  let theme = $state<Theme>(settings.theme);
  // svelte-ignore state_referenced_locally
  let keepPmHistory = $state(settings.keepPmHistory);
  // svelte-ignore state_referenced_locally
  let pmsInWindows = $state(settings.pmsInWindows);
  let backdrop = $state<HTMLDivElement | null>(null);

  // Close on backdrop click and Escape (mirrors MacrosDialog).
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

  function save() {
    onApply({ name: name.trim() || settings.name, color, theme, keepPmHistory, pmsInWindows });
    onClose();
  }
</script>

<div class="backdrop" bind:this={backdrop}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Options">
    <header>
      <h2>Options</h2>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <form onsubmit={(e) => (e.preventDefault(), save())}>
      <label>
        Display name
        <input bind:value={name} maxlength="64" placeholder="your name" required />
      </label>
      <label class="color">
        Color
        <input type="color" bind:value={color} aria-label="Display colour" />
      </label>
      <label>
        Theme
        <select bind:value={theme}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={keepPmHistory} />
        <span>
          Keep private-message history on this device
          <small>Restores your PM conversations after a refresh. Never stored on the server.</small>
        </span>
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={pmsInWindows} />
        <span>
          Open private messages in their own windows
          <small
            >New PM conversations pop out instead of opening a tab. Works best with history kept on
            this device.</small
          >
        </span>
      </label>
      <IdentityControls identityKey={settings.identityKey} />
      <footer>
        <button type="button" class="cancel" onclick={onClose}>Cancel</button>
        <button type="submit" class="done">Save</button>
      </footer>
    </form>
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
    width: min(380px, 92vw);
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
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    opacity: 0.9;
  }
  input,
  select {
    font: inherit;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
  }
  .color input[type='color'] {
    padding: 0;
    height: 2.4rem;
    width: 3rem;
  }
  .check {
    flex-direction: row;
    align-items: flex-start;
    gap: 0.5rem;
  }
  .check input[type='checkbox'] {
    margin-top: 0.15rem;
  }
  .check small {
    display: block;
    opacity: 0.65;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  .cancel {
    padding: 0.5rem 1rem;
    border: 1px solid var(--mara-border, #333);
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
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
