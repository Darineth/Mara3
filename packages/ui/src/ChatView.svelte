<script lang="ts">
  import { renderLine, type LineModel } from '@mara/chat-render';
  import type { ChatLine, Token, UserInfo } from '@mara/client-core';

  let {
    lines = [],
    users,
    showTimestamps = true,
  }: {
    lines: ChatLine[];
    users: Map<Token, UserInfo>;
    showTimestamps?: boolean;
  } = $props();

  let viewport = $state<HTMLDivElement | null>(null);
  // Auto-scroll unless the user has scrolled up to read history ("freeze").
  let pinnedToBottom = $state(true);

  function toModel(line: ChatLine): LineModel {
    const user = line.from !== null ? users.get(line.from) : undefined;
    return {
      kind: line.kind,
      authorName: user?.name ?? (line.from !== null ? `#${line.from}` : ''),
      authorColor: user?.style.color ?? '#888888',
      text: line.text,
      timestamp: new Date(line.at).toLocaleTimeString(),
    };
  }

  function onScroll() {
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    pinnedToBottom = distance < 40;
  }

  $effect(() => {
    lines.length; // track new lines
    if (pinnedToBottom && viewport) viewport.scrollTop = viewport.scrollHeight;
  });

  // Click/tap a spoiler to toggle it (reveal, then re-hide). Attached imperatively
  // so the log container doesn't need a declarative interactive handler.
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const toggle = (event: Event) => {
      (event.target as HTMLElement)?.closest('.mara-spoiler')?.classList.toggle('revealed');
    };
    el.addEventListener('click', toggle);
    return () => el.removeEventListener('click', toggle);
  });
</script>

<div class="mara-chatview" role="log" bind:this={viewport} onscroll={onScroll}>
  {#each lines as line (line.id)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by chat-render -->
    {@html renderLine(toModel(line), { showTimestamps })}
  {/each}
  {#if lines.length === 0}
    <div class="mara-empty">No messages yet.</div>
  {/if}
</div>

<style>
  .mara-chatview {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0.75rem;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  .mara-empty {
    opacity: 0.4;
    font-style: italic;
    padding: 1rem 0;
  }
  .mara-chatview :global(.mara-line) {
    margin: 0.1rem 0;
    word-wrap: break-word;
  }
  .mara-chatview :global(.mara-ts) {
    opacity: 0.45;
    font-size: 0.78em;
    font-variant-numeric: tabular-nums;
  }
  .mara-chatview :global(.mara-author) {
    font-weight: 600;
  }
  .mara-chatview :global(.mara-system) {
    opacity: 0.6;
  }
  .mara-chatview :global(.mara-emote) {
    opacity: 0.92;
  }
  .mara-chatview :global(a) {
    color: var(--mara-link, #5aa9ff);
  }

  /* Discord-style markdown */
  .mara-chatview :global(.mara-code),
  .mara-chatview :global(.mara-codeblock) {
    font-family: var(--mara-mono, ui-monospace, monospace);
    font-size: 0.85em;
    background: rgba(127, 127, 127, 0.18);
    border-radius: 4px;
    padding: 0.05em 0.35em;
  }
  .mara-chatview :global(.mara-codeblock) {
    display: block;
    padding: 0.5em 0.7em;
    margin: 0.2em 0;
    white-space: pre-wrap;
  }
  .mara-chatview :global(.mara-spoiler) {
    background: var(--mara-fg, #e6e6e6);
    color: transparent;
    border-radius: 4px;
    cursor: pointer;
    padding: 0 0.2em;
  }
  .mara-chatview :global(.mara-spoiler.revealed) {
    background: rgba(127, 127, 127, 0.18);
    color: inherit;
  }
</style>
