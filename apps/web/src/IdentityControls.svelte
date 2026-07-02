<!--
  Export/import for the client's identity key — the secret that makes the server
  hand back the same user (token + others-visible name/colour) across clients.
  Export is always shown (reveal + copy); the import UI appears only when an
  `onImport` handler is supplied (the login screen, where it can apply pre-connect;
  the in-session Options dialog offers export only, to avoid a live reconnect).

  The key is a bearer secret: anyone who has it can log in AS you. It already travels
  plaintext over the wire at login (no TLS by default), so this is deliberately plain
  reveal/copy — dressing it in crypto would imply a protection that isn't there.
-->
<script lang="ts">
  import { isValidIdentityKey } from './lib/settings.js';

  let {
    identityKey,
    onImport,
  }: {
    identityKey: string;
    /** When provided, the import UI is shown; called with the trimmed key on confirm. */
    onImport?: (key: string) => void;
  } = $props();

  let revealed = $state(false);
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  let importText = $state('');
  let confirming = $state(false);
  let importError = $state('');
  let imported = $state(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(identityKey);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. a non-secure origin): reveal it so the user
      // can select and copy by hand instead.
      revealed = true;
    }
  }

  function startImport() {
    importError = '';
    imported = false;
    if (!isValidIdentityKey(importText)) {
      importError = 'Enter a valid identity key (1–128 characters).';
      return;
    }
    confirming = true;
  }

  function confirmImport() {
    onImport?.(importText.trim());
    confirming = false;
    importText = '';
    imported = true;
  }
</script>

<section class="identity">
  <h3>Identity</h3>
  <p class="warn">
    This key is like a password — anyone who has it can appear as you. Don't share it or paste it
    anywhere public.
  </p>

  <label>
    Your identity key
    <div class="row">
      <input
        type={revealed ? 'text' : 'password'}
        value={identityKey}
        readonly
        aria-label="Your identity key"
      />
      <button type="button" onclick={() => (revealed = !revealed)}>
        {revealed ? 'Hide' : 'Reveal'}
      </button>
      <button type="button" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  </label>

  {#if onImport}
    <label>
      Import an identity key
      <div class="row">
        <input
          bind:value={importText}
          maxlength="128"
          placeholder="paste a key from another client"
          spellcheck="false"
          autocomplete="off"
        />
        <button type="button" onclick={startImport}>Import</button>
      </div>
    </label>
    {#if importError}
      <p class="error">{importError}</p>
    {/if}
    {#if confirming}
      <div class="confirm">
        <p>Replace this device's current identity? Its old identity will be left behind.</p>
        <div class="row">
          <button type="button" class="danger" onclick={confirmImport}>Replace identity</button>
          <button type="button" onclick={() => (confirming = false)}>Cancel</button>
        </div>
      </div>
    {:else if imported}
      <p class="ok">Identity imported. It takes effect on your next connect.</p>
    {/if}
  {/if}
</section>

<style>
  .identity {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--mara-border, #333);
  }
  h3 {
    margin: 0;
    font-size: 0.9rem;
  }
  .warn {
    margin: 0;
    font-size: 0.75rem;
    opacity: 0.75;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    opacity: 0.9;
  }
  .row {
    display: flex;
    gap: 0.4rem;
  }
  .row input {
    flex: 1;
    min-width: 0;
    font: inherit;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
  }
  .row button {
    padding: 0.5rem 0.7rem;
    border: 1px solid var(--mara-border, #333);
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
    white-space: nowrap;
  }
  .row button.danger {
    border-color: var(--mara-danger, #e5484d);
    color: var(--mara-danger, #e5484d);
  }
  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem;
    border: 1px solid var(--mara-danger, #e5484d);
    border-radius: 6px;
  }
  .confirm p {
    margin: 0;
    font-size: 0.8rem;
  }
  .error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--mara-danger, #e5484d);
  }
  .ok {
    margin: 0;
    font-size: 0.8rem;
    opacity: 0.8;
  }
</style>
