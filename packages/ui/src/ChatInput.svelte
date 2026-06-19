<!-- Message composer: autosizing textarea with sent-line history recall, F-key
     macros, and image attachments (drag-drop / paste) that upload in the
     background and are appended to the message as URLs on send. -->
<script lang="ts">
  import { tick } from 'svelte';
  import { openLightbox, closeLightboxFor } from './lightbox.js';

  let {
    onsend,
    maxLength = 1000,
    placeholder = 'Type a message…',
    disabled = false,
    macros = [],
    upload,
  }: {
    onsend: (text: string) => void;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
    /** Quick-text macros indexed 0–11 for F1–F12. */
    macros?: string[];
    /** Upload an image and resolve its hosted URL; enables drag-drop & paste. */
    upload?: (file: File) => Promise<string>;
  } = $props();

  /** A pending image attachment shown as a tile above the input. */
  interface Attachment {
    id: number;
    name: string;
    /** Object URL for an instant local preview while the upload is in flight. */
    preview: string;
    /** Hosted URL once the upload resolves; undefined while uploading. */
    url?: string;
  }

  let text = $state('');
  let history = $state<string[]>([]);
  let historyIndex = $state(-1); // -1 = editing a fresh line
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let attachments = $state<Attachment[]>([]);
  let dragOver = $state(false);
  let uploadError = $state('');
  let nextAttachId = 0;

  // An attachment with no resolved `url` yet is still uploading; block send until
  // all resolve so we never emit a message referencing a not-yet-hosted image.
  const uploading = $derived(attachments.some((a) => a.url === undefined));
  // Allow send when there's something to send (text or attachments) and nothing
  // blocks it; gates both the button and the Enter handler.
  const canSend = $derived(
    !disabled && !uploading && (text.trim() !== '' || attachments.length > 0),
  );

  /** Upload dropped/pasted image files, each shown as a tile until it resolves. */
  async function uploadFiles(files: File[]) {
    if (!upload) return;
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    uploadError = '';
    for (const file of images) {
      const id = nextAttachId++;
      const preview = URL.createObjectURL(file);
      attachments = [...attachments, { id, name: file.name, preview }];
      try {
        const url = await upload(file);
        attachments = attachments.map((a) => (a.id === id ? { ...a, url } : a));
      } catch (err) {
        uploadError = err instanceof Error ? err.message : 'Upload failed';
        removeAttachment(id);
      }
    }
  }

  // Revoke the preview object URL on removal to avoid leaking it, and drop the
  // lightbox if it happens to be showing this image.
  function removeAttachment(id: number) {
    const gone = attachments.find((a) => a.id === id);
    if (gone) {
      closeLightboxFor([gone.preview, gone.url].filter((s): s is string => !!s));
      URL.revokeObjectURL(gone.preview);
    }
    attachments = attachments.filter((a) => a.id !== id);
  }

  function onDrop(event: DragEvent) {
    if (!upload) return;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      event.preventDefault();
      dragOver = false;
      void uploadFiles(files);
    }
  }

  function onDragOver(event: DragEvent) {
    if (!upload || !event.dataTransfer) return;
    if ([...event.dataTransfer.items].some((i) => i.kind === 'file')) {
      event.preventDefault();
      dragOver = true;
    }
  }

  function onPaste(event: ClipboardEvent) {
    if (!upload) return;
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      event.preventDefault();
      void uploadFiles(files);
    }
  }

  async function insertAtCursor(snippet: string) {
    const ta = textarea;
    if (!ta) {
      text += snippet;
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    text = text.slice(0, start) + snippet + text.slice(end);
    await tick();
    const pos = start + snippet.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    autosize();
  }

  // Grow the textarea to fit its content, capped at 160px (matches the CSS
  // max-height, beyond which it scrolls). Reset to 'auto' first so it can shrink.
  function autosize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  function submit() {
    if (!canSend) return;
    const typed = text.trim();
    const urls = attachments.map((a) => a.url).filter((u): u is string => !!u);
    // Image URLs go on their own lines so the renderer turns each into an inline
    // image; the typed text (if any) leads.
    const value = [typed, ...urls].filter((p) => p !== '').join('\n');
    if (value === '') return;
    onsend(value);
    if (typed) history = [...history, typed].slice(-100); // recall text only, not URLs
    historyIndex = -1;
    text = '';
    for (const a of attachments) URL.revokeObjectURL(a.preview);
    attachments = [];
    queueMicrotask(autosize);
  }

  // Walk sent-text history. -1 means "fresh line"; the first ArrowUp jumps to the
  // newest entry, then up/down step through and clamp at the ends.
  function recall(direction: -1 | 1) {
    if (history.length === 0) return;
    if (historyIndex === -1 && direction === -1) historyIndex = history.length - 1;
    else historyIndex = Math.min(Math.max(historyIndex + direction, 0), history.length - 1);
    text = history[historyIndex] ?? '';
    queueMicrotask(autosize);
  }

  function onKeydown(event: KeyboardEvent) {
    // F1–F12 insert the matching macro (only when one is set, so e.g. F5 still
    // refreshes the page when its slot is empty).
    const fkey = /^F([1-9]|1[0-2])$/.exec(event.key);
    if (fkey) {
      const snippet = macros[Number(fkey[1]) - 1];
      if (snippet) {
        event.preventDefault();
        void insertAtCursor(snippet);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      // Only start/continue history recall when the line is empty or already
      // recalling, so ArrowUp still moves the caret while editing real text.
    } else if (event.key === 'ArrowUp' && (text === '' || historyIndex !== -1)) {
      event.preventDefault();
      recall(-1);
    } else if (event.key === 'ArrowDown' && historyIndex !== -1) {
      event.preventDefault();
      recall(1);
    }
  }
</script>

<div
  class="mara-input"
  class:dragover={dragOver}
  ondrop={onDrop}
  ondragover={onDragOver}
  ondragleave={() => (dragOver = false)}
  role="group"
>
  {#if uploadError}
    <div class="mara-upload-error" role="alert">{uploadError}</div>
  {/if}
  <!-- Attachment tiles: local `preview` stays the thumbnail throughout (no
       re-fetch of the hosted URL); a spinner overlays until the upload resolves. -->
  {#if attachments.length > 0}
    <div class="mara-attachments">
      {#each attachments as att (att.id)}
        <div class="mara-tile" class:uploading={att.url === undefined} title={att.name}>
          <button
            type="button"
            class="open"
            onclick={() => openLightbox(att.url ?? att.preview, att.name)}
            aria-label="Preview {att.name || 'image'}"
          >
            <img src={att.preview} alt={att.name} />
          </button>
          {#if att.url === undefined}
            <span class="spinner" aria-label="Uploading"></span>
          {/if}
          <button
            type="button"
            class="remove"
            onclick={() => removeAttachment(att.id)}
            aria-label="Remove image">×</button
          >
        </div>
      {/each}
    </div>
  {/if}
  <textarea
    bind:this={textarea}
    bind:value={text}
    {placeholder}
    {disabled}
    maxlength={maxLength}
    rows="1"
    onkeydown={onKeydown}
    oninput={autosize}
    onpaste={onPaste}
  ></textarea>
  <button type="button" class="send" onclick={submit} disabled={!canSend}>Send</button>
</div>

<style>
  .mara-input {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
    border-top: 1px solid var(--mara-border, #333);
    align-items: flex-end;
  }
  .mara-input.dragover {
    outline: 2px dashed var(--mara-accent, #3b82f6);
    outline-offset: -4px;
    border-radius: 6px;
  }
  .mara-upload-error {
    flex-basis: 100%;
    font-size: 0.8rem;
    color: var(--mara-error, #f87171);
  }
  .mara-attachments {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .mara-tile {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--mara-border, #333);
    background: rgba(127, 127, 127, 0.12);
  }
  .mara-tile .open {
    all: unset;
    display: block;
    width: 100%;
    height: 100%;
    cursor: zoom-in;
  }
  .mara-tile img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .mara-tile.uploading img {
    opacity: 0.4;
  }
  .mara-tile .remove {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 1;
    font-size: 13px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mara-tile .spinner {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: mara-spin 0.7s linear infinite;
  }
  @keyframes mara-spin {
    to {
      transform: rotate(360deg);
    }
  }
  textarea {
    flex: 1;
    resize: none;
    font: inherit;
    padding: 0.45rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
    max-height: 160px;
    overflow-y: auto;
  }
  .send {
    padding: 0.45rem 0.9rem;
    border-radius: 6px;
    border: none;
    background: var(--mara-accent, #3b82f6);
    color: #fff;
    cursor: pointer;
  }
  .send:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
