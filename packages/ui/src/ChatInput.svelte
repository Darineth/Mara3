<script lang="ts">
  import { tick } from 'svelte';

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

  let text = $state('');
  let history = $state<string[]>([]);
  let historyIndex = $state(-1); // -1 = editing a fresh line
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let uploading = $state(0); // count of in-flight uploads
  let dragOver = $state(false);
  let uploadError = $state('');

  /** Upload dropped/pasted image files and drop their URLs into the message. */
  async function uploadFiles(files: File[]) {
    if (!upload) return;
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    uploadError = '';
    for (const file of images) {
      uploading += 1;
      try {
        const url = await upload(file);
        const sep = text === '' || /\s$/.test(text) ? '' : ' ';
        await insertAtCursor(sep + url + ' ');
      } catch (err) {
        uploadError = err instanceof Error ? err.message : 'Upload failed';
      } finally {
        uploading -= 1;
      }
    }
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

  function autosize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }

  function submit() {
    const value = text.trim();
    if (!value || disabled) return;
    onsend(value);
    history = [...history, value].slice(-100);
    historyIndex = -1;
    text = '';
    queueMicrotask(autosize);
  }

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
  <textarea
    bind:this={textarea}
    bind:value={text}
    placeholder={uploading > 0 ? 'Uploading image…' : placeholder}
    {disabled}
    maxlength={maxLength}
    rows="1"
    onkeydown={onKeydown}
    oninput={autosize}
    onpaste={onPaste}
  ></textarea>
  <button
    type="button"
    onclick={submit}
    disabled={disabled || text.trim() === '' || uploading > 0}>Send</button
  >
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
  button {
    padding: 0.45rem 0.9rem;
    border-radius: 6px;
    border: none;
    background: var(--mara-accent, #3b82f6);
    color: #fff;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
