<script lang="ts">
  let {
    onsend,
    maxLength = 1000,
    placeholder = 'Type a message…',
    disabled = false,
  }: {
    onsend: (text: string) => void;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
  } = $props();

  let text = $state('');
  let history = $state<string[]>([]);
  let historyIndex = $state(-1); // -1 = editing a fresh line
  let textarea = $state<HTMLTextAreaElement | null>(null);

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
