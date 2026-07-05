<!--
  Custom-emoji library manager. Lists every emoji (operator-provided + user-contributed) and
  lets anyone add their own: pick a `:shortcode:` and an image, which uploads and then binds
  over the WebSocket. You can remove (or replace) only the ones you added; operator emoji are
  read-only. The list is driven by the live `emoji` catalog, so adds/removes from anyone show
  up here immediately.
-->
<script lang="ts">
  import type { EmojiEntry } from '@mara/protocol';
  import { emojiSrc } from '@mara/ui';
  import { isUploadableImage } from './lib/upload.js';

  let {
    emoji,
    selfToken,
    uploadEmoji,
    onAdd,
    onRemove,
    serverError = '',
    onClose,
  }: {
    /** The live merged catalog (operator + user contributions). */
    emoji: EmojiEntry[];
    /** This client's user token, to decide which entries it may remove. */
    selfToken: number | null;
    /** Upload an image and resolve to its hosted `/emoji/<id>` URL. */
    uploadEmoji: (file: File) => Promise<string>;
    /** Bind `:name:` to an uploaded image URL (server validates + broadcasts). */
    onAdd: (name: string, url: string) => void;
    /** Remove a user-contributed emoji by name. */
    onRemove: (name: string) => void;
    /** Latest server rejection text (e.g. a name clash lost to a race), shown inline. */
    serverError?: string;
    onClose: () => void;
  } = $props();

  let backdrop = $state<HTMLDivElement | null>(null);
  let name = $state('');
  let file = $state<File | null>(null);
  let preview = $state('');
  let busy = $state(false);
  let localError = $state('');
  let fileInput = $state<HTMLInputElement | null>(null);
  let nameInput = $state<HTMLInputElement | null>(null);
  let dragOver = $state(false);

  // A pasted image only reaches our paste handler with data attached when an editable field is
  // focused (a document-level paste onto nothing gets empty clipboardData). Focus the shortcode
  // field on open so Ctrl/Cmd+V works immediately — but not on touch, where it would pop the
  // soft keyboard (mirrors the composer's behaviour; touch users pick images via the file button).
  const softKeyboard =
    typeof window !== 'undefined' &&
    (navigator.maxTouchPoints ?? 0) > 0 &&
    !!window.matchMedia?.('(hover: none)').matches;
  $effect(() => {
    if (!softKeyboard) nameInput?.focus();
  });

  const NAME_RE = /^[a-zA-Z0-9_+-]{2,64}$/;
  const nameValid = $derived(NAME_RE.test(name));
  // The entry (if any) already bound to this shortcode, and whether it's ours to replace.
  const existing = $derived(emoji.find((e) => e.name === name));
  const mine = $derived(existing !== undefined && existing.owner === selfToken);
  // Taken by someone else or by a built-in (operator) emoji → can't use this name.
  const nameTaken = $derived(existing !== undefined && !mine);
  const canSubmit = $derived(nameValid && file !== null && !nameTaken && !busy);

  // Sorted for a stable, scannable list: user emoji you can manage first, then the rest.
  const sorted = $derived([...emoji].sort((a, b) => a.name.localeCompare(b.name)));

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

  // Revoke the object URL when the preview changes or the dialog unmounts.
  $effect(() => {
    const url = preview;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  });

  // Pasting an image anywhere while the dialog is open picks it up (Ctrl/Cmd+V). Only
  // intercepts when the clipboard actually holds an image, so pasting text into the shortcode
  // field still works. Mirrors the composer's paste handling (incl. the WebKitGTK fallback).
  $effect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const cd = e.clipboardData;
      let images = [...cd.files].filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) {
        images = [...cd.items]
          .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
          .map((i) => i.getAsFile())
          .filter((f): f is File => f != null);
      }
      if (images.length > 0) {
        e.preventDefault();
        acceptFile(images[0]);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  /** Validate + stage an image (from the file picker, a drop, or a paste) as the pending
   *  upload, prefilling the shortcode from the filename when it's still blank. */
  function acceptFile(chosen: File | null | undefined): void {
    localError = '';
    if (!chosen) return;
    if (!isUploadableImage(chosen)) {
      localError = 'That file is not a supported image (PNG, JPEG, GIF, WebP, AVIF, BMP).';
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    file = chosen;
    preview = URL.createObjectURL(chosen);
    if (!name) {
      const stem = chosen.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_+-]/g, '');
      if (stem) name = stem.slice(0, 64);
    }
  }

  function pickFile(e: Event): void {
    acceptFile((e.target as HTMLInputElement).files?.[0]);
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragOver = false;
    const img = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (img) acceptFile(img);
  }

  function onDragOver(e: DragEvent): void {
    if (e.dataTransfer && [...e.dataTransfer.items].some((i) => i.kind === 'file')) {
      e.preventDefault();
      dragOver = true;
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit || !file) return;
    busy = true;
    localError = '';
    try {
      const url = await uploadEmoji(file);
      onAdd(name.trim(), url);
      // Optimistic reset: success shows up as the entry appearing in the list (or, on a
      // server rejection, as `serverError`).
      if (preview) URL.revokeObjectURL(preview);
      name = '';
      file = null;
      preview = '';
      if (fileInput) fileInput.value = '';
    } catch (err) {
      localError = err instanceof Error ? err.message : 'Upload failed.';
    } finally {
      busy = false;
    }
  }

  const error = $derived(localError || serverError);
</script>

<div class="backdrop" bind:this={backdrop}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Custom emoji">
    <header>
      <h2>Custom emoji</h2>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <p class="hint">
      Type <code>:shortcode:</code> in a message to use one. Anyone can add emoji; you can remove the
      ones you added.
    </p>

    <div
      class="add"
      class:drag={dragOver}
      role="group"
      aria-label="Add an emoji"
      ondragover={onDragOver}
      ondragleave={() => (dragOver = false)}
      ondrop={onDrop}
    >
      <div class="add-row">
        <span class="colon">:</span>
        <input
          class="name"
          bind:this={nameInput}
          bind:value={name}
          placeholder="shortcode"
          maxlength="64"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        />
        <span class="colon">:</span>
        <button class="pick" type="button" onclick={() => fileInput?.click()}>
          {file ? 'Change image' : 'Choose image'}
        </button>
        {#if preview}
          <img class="preview" src={preview} alt="" />
        {/if}
        <button class="add-btn" type="button" disabled={!canSubmit} onclick={submit}>
          {busy ? 'Adding…' : mine ? 'Replace' : 'Add'}
        </button>
      </div>
      <input
        class="hidden-file"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp"
        bind:this={fileInput}
        onchange={pickFile}
      />
      <p class="drop-hint">
        {dragOver
          ? 'Drop the image to use it'
          : 'Choose an image above, or drag & drop or paste one.'}
      </p>
      {#if name && !nameValid}
        <p class="note warn">Shortcodes use letters, numbers, <code>_ + -</code> (2–64 chars).</p>
      {:else if nameTaken}
        <p class="note warn">
          <code>:{name}:</code> is already taken{existing?.by ? ` by ${existing.by}` : ''}.
        </p>
      {:else if mine}
        <p class="note">Replacing your existing <code>:{name}:</code>.</p>
      {/if}
      {#if error}
        <p class="note err">{error}</p>
      {/if}
    </div>

    <div class="count">{sorted.length} emoji</div>
    <ul class="list">
      {#each sorted as e (e.name)}
        <li>
          <img class="thumb" src={emojiSrc(e.url)} alt="" loading="lazy" />
          <span class="code">:{e.name}:</span>
          {#if e.owner === undefined}
            <span class="tag">built-in</span>
          {:else if e.by}
            <span class="by">{e.by}</span>
          {/if}
          {#if e.owner !== undefined && e.owner === selfToken}
            <button class="remove" type="button" onclick={() => onRemove(e.name)}>Remove</button>
          {/if}
        </li>
      {:else}
        <li class="empty">No emoji yet — add the first one above.</li>
      {/each}
    </ul>

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
    width: min(520px, 94vw);
    max-height: 86vh;
    display: flex;
    flex-direction: column;
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
  code {
    font-family: var(--mara-mono, monospace);
    font-size: 0.85em;
    background: var(--mara-input-bg, #2a2a2a);
    padding: 0 0.25em;
    border-radius: 4px;
  }
  .add {
    border: 1px solid var(--mara-border, #333);
    border-radius: 8px;
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.8rem;
    transition:
      border-color 0.12s,
      background 0.12s;
  }
  /* Highlight the whole add box as a drop target while an image is dragged over it. */
  .add.drag {
    border-color: var(--mara-accent, #3b82f6);
    border-style: dashed;
    background: color-mix(in srgb, var(--mara-accent, #3b82f6) 8%, transparent);
  }
  .drop-hint {
    margin: 0.5rem 0 0;
    font-size: 0.75rem;
    opacity: 0.5;
  }
  .add.drag .drop-hint {
    color: var(--mara-accent, #3b82f6);
    opacity: 1;
  }
  .add-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .colon {
    opacity: 0.5;
  }
  .name {
    flex: 1;
    min-width: 6rem;
    font: inherit;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
  }
  .pick {
    padding: 0.35rem 0.6rem;
    border: 1px solid var(--mara-border, #333);
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
  }
  .preview {
    width: 1.6rem;
    height: 1.6rem;
    object-fit: contain;
  }
  .add-btn {
    padding: 0.35rem 0.8rem;
    border: none;
    border-radius: 6px;
    background: var(--mara-accent, #3b82f6);
    color: #fff;
    cursor: pointer;
    font: inherit;
  }
  .add-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hidden-file {
    display: none;
  }
  .note {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    opacity: 0.75;
  }
  .note.warn {
    color: var(--mara-warn, #e0a030);
    opacity: 1;
  }
  .note.err {
    color: var(--mara-danger, #e05555);
    opacity: 1;
  }
  .count {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    margin-bottom: 0.3rem;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    min-height: 4rem;
  }
  .list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.25rem;
    border-bottom: 1px solid var(--mara-border, #2c2c2c);
  }
  .list li.empty {
    opacity: 0.5;
    font-style: italic;
    justify-content: center;
    border: none;
  }
  .thumb {
    width: 1.5rem;
    height: 1.5rem;
    object-fit: contain;
    flex: none;
  }
  .code {
    font-family: var(--mara-mono, monospace);
    font-size: 0.85rem;
  }
  .by {
    font-size: 0.75rem;
    opacity: 0.5;
  }
  .tag {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.45;
  }
  .by,
  .tag {
    margin-left: auto;
  }
  .remove {
    margin-left: auto;
    padding: 0.2rem 0.55rem;
    border: 1px solid var(--mara-border, #444);
    border-radius: 6px;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 0.78rem;
    opacity: 0.8;
  }
  .remove:hover {
    color: var(--mara-danger, #e05555);
    border-color: var(--mara-danger, #e05555);
  }
  /* When a row has both a meta label and a remove button, the label shouldn't also push
     right — only the remove button anchors to the end. */
  .by + .remove,
  .tag + .remove {
    margin-left: 0.5rem;
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
