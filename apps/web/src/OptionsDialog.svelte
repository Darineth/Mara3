<!--
  In-session options: change display name, colour, and theme without disconnecting.
  Name/colour changes are broadcast to everyone (the parent calls client.setProfile);
  the parent persists settings on apply. Mirrors MacrosDialog's modal pattern.
-->
<script lang="ts">
  import type { MaraSettings, MessageStyle, Theme } from './lib/settings.js';
  import { isUploadableImage } from './lib/upload.js';
  import { monogramInitial, toRenderUrl } from '@mara/ui';
  import IdentityControls from './IdentityControls.svelte';

  let {
    settings,
    onApply,
    onClose,
    uploadAvatar,
  }: {
    settings: MaraSettings;
    onApply: (next: {
      name: string;
      color: string;
      theme: Theme;
      keepPmHistory: boolean;
      pmsInWindows: boolean;
      autoRefresh: boolean;
      messageStyle: MessageStyle;
      avatar: string;
      showAvatars: boolean;
    }) => void;
    onClose: () => void;
    /** Downscale + upload an avatar image, returning its hosted path. */
    uploadAvatar: (file: File) => Promise<string>;
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
  // svelte-ignore state_referenced_locally
  let autoRefresh = $state(settings.autoRefresh);
  // svelte-ignore state_referenced_locally
  let messageStyle = $state<MessageStyle>(settings.messageStyle);
  // svelte-ignore state_referenced_locally
  let showAvatars = $state(settings.showAvatars);
  // svelte-ignore state_referenced_locally
  let avatar = $state(settings.avatar);
  let avatarBusy = $state(false);
  let avatarError = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let backdrop = $state<HTMLDivElement | null>(null);

  // The initial shown in the monogram fallback when there's no avatar.
  const initial = $derived(monogramInitial(name));

  async function pickAvatar(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same file be re-picked after a failure
    if (!file) return;
    if (!isUploadableImage(file)) {
      avatarError = 'Please choose a PNG, JPEG, GIF, WebP, AVIF, or BMP image.';
      return;
    }
    avatarError = '';
    avatarBusy = true;
    try {
      avatar = await uploadAvatar(file);
    } catch (err) {
      avatarError = err instanceof Error ? err.message : 'Avatar upload failed.';
    } finally {
      avatarBusy = false;
    }
  }

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
    onApply({
      name: name.trim() || settings.name,
      color,
      theme,
      keepPmHistory,
      pmsInWindows,
      autoRefresh,
      messageStyle,
      avatar,
      showAvatars,
    });
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
      <div class="avatar-field">
        <span class="lbl">Avatar</span>
        <div class="avatar-row">
          {#if avatar}
            <img class="avatar-preview" src={toRenderUrl(avatar)} alt="Your avatar" />
          {:else}
            <span class="avatar-preview mono" style="background:{color}" aria-hidden="true"
              >{initial}</span
            >
          {/if}
          <div class="avatar-actions">
            <button type="button" onclick={() => fileInput?.click()} disabled={avatarBusy}>
              {avatarBusy ? 'Uploading…' : avatar ? 'Change' : 'Upload'}
            </button>
            {#if avatar}
              <button type="button" class="link" onclick={() => (avatar = '')} disabled={avatarBusy}
                >Remove</button
              >
            {/if}
          </div>
          <input
            class="hidden-file"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp"
            bind:this={fileInput}
            onchange={pickAvatar}
          />
        </div>
        {#if avatarError}<small class="err">{avatarError}</small>{/if}
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={showAvatars} />
        <span>
          Show avatars
          <small>Show user avatars in the user list and messages. Off shows names only.</small>
        </span>
      </label>
      <label>
        Theme
        <select bind:value={theme}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label>
        Message style
        <select bind:value={messageStyle}>
          <option value="mara">Mara</option>
          <option value="discord">Discord</option>
        </select>
        <small class="hint">
          Discord groups a run of messages from the same person under one name and time.
        </small>
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
      <label class="check">
        <input type="checkbox" bind:checked={autoRefresh} />
        <span>
          Auto-refresh when out of date
          <small>Reload automatically to pick up a newer version when the server has one.</small>
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
    /* Short windows: stay on screen and scroll (same as MacrosDialog/FormattingHelp). */
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
  .avatar-field {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
    opacity: 0.9;
  }
  .avatar-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .avatar-preview {
    flex: none;
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    object-fit: cover;
    border: 1px solid var(--mara-border, #333);
    /* No background, so a transparent avatar shows through (the monogram sets its colour inline). */
  }
  .avatar-preview.mono {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    font-size: 1.2rem;
  }
  .avatar-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .avatar-actions button {
    padding: 0.4rem 0.8rem;
    border: 1px solid var(--mara-border, #333);
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .avatar-actions .link {
    border: none;
    padding: 0.4rem 0.2rem;
    opacity: 0.7;
    text-decoration: underline;
  }
  .avatar-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .hidden-file {
    display: none;
  }
  .err {
    color: #f77;
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
  .hint {
    opacity: 0.6;
    font-size: 0.72rem;
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
