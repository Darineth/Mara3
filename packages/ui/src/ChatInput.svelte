<script lang="ts">
  import { tick } from 'svelte';

  let {
    onsend,
    maxLength = 1000,
    placeholder = 'Type a message…',
    disabled = false,
    macros = [],
  }: {
    onsend: (text: string) => void;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
    /** Quick-text macros indexed 0–11 for F1–F12. */
    macros?: string[];
  } = $props();

  let text = $state('');
  let history = $state<string[]>([]);
  let historyIndex = $state(-1); // -1 = editing a fresh line
  let textarea = $state<HTMLTextAreaElement | null>(null);

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

<div class="mara-input">
  <textarea
    bind:this={textarea}
    bind:value={text}
    {placeholder}
    {disabled}
    maxlength={maxLength}
    rows="1"
    onkeydown={onKeydown}
    oninput={autosize}
  ></textarea>
  <button type="button" onclick={submit} disabled={disabled || text.trim() === ''}>Send</button>
</div>

<style>
  .mara-input {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem;
    border-top: 1px solid var(--mara-border, #333);
    align-items: flex-end;
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
