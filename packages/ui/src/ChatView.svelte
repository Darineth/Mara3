<!-- Scrolling chat log. Renders each line via chat-render's sanitized {@html}
     output, then layers interactivity (spoiler reveal, image hide/lightbox) on
     top imperatively since the markup isn't ours to bind handlers onto. -->
<script lang="ts">
  import { renderLine, type LineModel } from '@mara/chat-render';
  import type { ChatLine, Token, UserInfo } from '@mara/client-core';
  import { openLightbox } from './lightbox.js';

  let {
    lines = [],
    users,
    sessionStart = 0,
  }: {
    lines: ChatLine[];
    users: Map<Token, UserInfo>;
    /** Timestamp (ms) of this session's connect; a rule is drawn where the lines
     *  cross from older backlog (< this) into the session (>= this). 0 disables it. */
    sessionStart?: number;
  } = $props();

  let viewport = $state<HTMLDivElement | null>(null);
  let content = $state<HTMLDivElement | null>(null);
  // Auto-scroll unless the user has scrolled up to read history ("freeze").
  let pinnedToBottom = $state(true);
  // Inline images the user has collapsed, keyed by URL. Kept here (not in the
  // DOM) so the choice survives the {@html} re-renders that fire when the roster
  // or timestamp setting changes. Reassigned on change for reactivity.
  let hiddenImages = $state(new Set<string>());

  // The img src is the stable identity used to key collapsed state across re-renders.
  function imgSrcOf(box: Element): string {
    return box.querySelector('img.mara-img')?.getAttribute('src') ?? '';
  }

  // Resolve a transport ChatLine against the live roster into chat-render's view
  // model. Falls back to `#<token>` when the author isn't in the roster (e.g.
  // they left) so history stays attributable.
  function toModel(line: ChatLine): LineModel {
    const user = line.from !== null ? users.get(line.from) : undefined;
    return {
      kind: line.kind,
      authorName: user?.name ?? (line.from !== null ? `#${line.from}` : ''),
      authorColor: user?.color ?? '#888888',
      text: line.text,
      // 2-digit fields keep every timestamp the same character count (the hour is
      // otherwise 1 or 2 digits, which shifts the message after it). The locale's
      // 12-/24-hour preference is preserved. Paired with tabular-nums in the CSS so
      // the digits are fixed-width and the message column never moves.
      timestamp: new Date(line.at).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    };
  }

  // Last seen scrollTop, to tell a user scroll-up from content growing under us.
  let lastScrollTop = 0;
  // Re-pin when at the bottom; only UNPIN when the user actively scrolls up. This
  // matters because our own scroll-to-bottom fires a `scroll` event asynchronously,
  // by which point an image may have grown the content — measuring a large distance
  // then must NOT unpin, or auto-scroll would die mid-load on join.
  function onScroll() {
    if (!viewport) return;
    const st = viewport.scrollTop;
    const distance = viewport.scrollHeight - st - viewport.clientHeight;
    if (distance < 40)
      pinnedToBottom = true; // at (or snapped back to) the bottom
    else if (st < lastScrollTop - 2) pinnedToBottom = false; // user scrolled up to read
    lastScrollTop = st;
  }

  $effect(() => {
    lines.length; // track new lines
    if (pinnedToBottom && viewport) viewport.scrollTop = viewport.scrollHeight;
  });

  // Keep pinned to the bottom as the content's height changes after the initial
  // scroll — new lines, and especially inline images that finish loading later (on
  // join, a backlog full of images grows the height well after the first scroll). A
  // ResizeObserver on the content wrapper catches every height change, which is more
  // robust than per-image 'load' events (lazy/off-screen images don't all fire).
  $effect(() => {
    const el = viewport;
    const c = content;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      if (pinnedToBottom) el.scrollTop = el.scrollHeight;
    });
    ro.observe(c);
    return () => ro.disconnect();
  });

  // Handle clicks inside the log imperatively so the container doesn't need a
  // declarative interactive handler: spoilers toggle, and inline images open in
  // the lightbox (plain left-click only — modifier/middle clicks still follow
  // the wrapping link so "open in new tab" keeps working).
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;

      // Hide / restore an inline image.
      const toggle = target?.closest('.mara-img-hide, .mara-img-show');
      if (toggle) {
        const box = toggle.closest('.mara-img-box');
        if (box) {
          const src = imgSrcOf(box);
          const next = new Set(hiddenImages);
          if (toggle.classList.contains('mara-img-show')) next.delete(src);
          else next.add(src);
          hiddenImages = next;
        }
        return;
      }

      const spoiler = target?.closest('.mara-spoiler');
      if (spoiler) {
        spoiler.classList.toggle('revealed');
        return;
      }
      const img = target?.closest('img.mara-img') as HTMLImageElement | null;
      if (img && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault(); // don't navigate the wrapping anchor
        openLightbox(img.currentSrc || img.src, img.alt);
      }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  });

  // Reconcile collapsed state onto the DOM after each render (the {@html} blocks
  // are rebuilt on roster/timestamp changes, so DOM classes alone wouldn't stick).
  $effect(() => {
    lines.length; // re-run when lines change
    void users; // ...and when the roster re-renders the lines
    const set = hiddenImages;
    const el = viewport;
    if (!el) return;
    for (const box of el.querySelectorAll('.mara-img-box')) {
      box.classList.toggle('collapsed', set.has(imgSrcOf(box)));
    }
  });
</script>

<div class="mara-chatview" role="log" bind:this={viewport} onscroll={onScroll}>
  <div class="mara-content" bind:this={content}>
    {#each lines as line, i (line.id)}
      {#if sessionStart > 0 && i > 0 && (lines[i - 1]?.at ?? sessionStart) < sessionStart && line.at >= sessionStart}
        <hr class="mara-sep" />
      {/if}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by chat-render -->
      {@html renderLine(toModel(line))}
    {/each}
    {#if lines.length === 0}
      <div class="mara-empty">No messages yet.</div>
    {/if}
  </div>
</div>

<style>
  .mara-chatview {
    flex: 1;
    overflow-y: auto;
    /* Don't let scroll anchoring fight our auto-scroll-to-bottom as images load. */
    overflow-anchor: none;
    padding: 0.5rem 0.75rem;
    font-size: 0.9rem;
    line-height: 1.4;
  }
  /* Session boundary rule: between older backlog and the current session. */
  .mara-sep {
    border: none;
    border-top: 1px solid var(--mara-border, #333);
    margin: 0.6rem 0;
  }
  .mara-empty {
    opacity: 0.4;
    font-style: italic;
    padding: 1rem 0;
  }
  .mara-chatview :global(.mara-line) {
    /* Timestamp gutter + body column: wrapped lines align to the body's start
       (the author/message), not under the timestamp. */
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    margin: 0.1rem 0;
  }
  .mara-chatview :global(.mara-ts) {
    /* The fixed-width gutter; tabular digits keep every timestamp the same width
       so all bodies line up at the same x. */
    flex: none;
    opacity: 0.45;
    font-size: 0.78em;
    font-variant-numeric: tabular-nums;
  }
  .mara-chatview :global(.mara-body) {
    /* The wrapping column. min-width:0 lets it shrink/wrap inside the flex row;
       pre-wrap keeps author-entered (and MOTD) line breaks. */
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    overflow-wrap: break-word;
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
  .mara-chatview :global(.mara-img) {
    display: block;
    max-width: min(320px, 100%);
    max-height: 240px;
    width: auto;
    height: auto;
    /* A translucent border so images read as media, not chat text. The colour is
       theme-aware (light edge on dark bg, dark edge on light bg). */
    border: 1px solid var(--mara-img-border, rgba(255, 255, 255, 0.45));
    border-radius: 6px;
    margin: 0.3rem 0;
    object-fit: contain;
    cursor: zoom-in;
  }
  .mara-chatview :global(.mara-img-box) {
    position: relative;
    display: inline-block;
    /* Align the image's top with the surrounding inline text, not the inline-block
       baseline (which would drop the text to the image's bottom edge). */
    vertical-align: top;
    max-width: 100%;
  }
  .mara-chatview :global(.mara-img-hide) {
    position: absolute;
    top: 8px;
    right: 8px;
    font: inherit;
    font-size: 0.72rem;
    line-height: 1;
    padding: 0.25em 0.5em;
    border: none;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s;
  }
  .mara-chatview :global(.mara-img-box:hover .mara-img-hide),
  .mara-chatview :global(.mara-img-hide:focus-visible) {
    opacity: 1;
  }
  .mara-chatview :global(.mara-img-show) {
    display: none;
    font: inherit;
    font-size: 0.8rem;
    align-items: center;
    gap: 0.3em;
    margin: 0.25rem 0;
    padding: 0.3em 0.7em;
    border: 1px solid var(--mara-border, #333);
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.12);
    color: inherit;
    cursor: pointer;
  }
  .mara-chatview :global(.mara-img-box.collapsed .mara-img-link),
  .mara-chatview :global(.mara-img-box.collapsed .mara-img-hide) {
    display: none;
  }
  .mara-chatview :global(.mara-img-box.collapsed .mara-img-show) {
    display: inline-flex;
  }

  /* Discord-style markdown */
  .mara-chatview :global(.mara-code),
  .mara-chatview :global(.mara-codeblock) {
    font-family: var(--mara-mono, ui-monospace, monospace);
    font-size: 0.85em;
    background: var(--mara-bg-alt, rgba(127, 127, 127, 0.18));
    border-radius: 4px;
    padding: 0.05em 0.35em;
  }
  .mara-chatview :global(.mara-codeblock) {
    display: block;
    padding: 0.5em 0.7em;
    margin: 0.4em 0;
    white-space: pre-wrap;
  }
  /* Block-level markdown (Discord parity): headers, subtext, quotes, lists. Headers carry
     extra space above to set them off from the block before them; the first block in a
     message drops its leading margin (below) so a message never starts with a gap. */
  .mara-chatview :global(.mara-h1),
  .mara-chatview :global(.mara-h2),
  .mara-chatview :global(.mara-h3) {
    font-weight: 700;
    line-height: 1.25;
    margin: 0.6em 0 0.2em;
  }
  .mara-chatview :global(.mara-h1) {
    font-size: 1.45em;
  }
  .mara-chatview :global(.mara-h2) {
    font-size: 1.2em;
  }
  .mara-chatview :global(.mara-h3) {
    font-size: 1.05em;
  }
  .mara-chatview :global(.mara-subtext) {
    font-size: 0.8em;
    opacity: 0.6;
    margin: 0.2em 0;
  }
  .mara-chatview :global(.mara-quote) {
    margin: 0.4em 0;
    padding-left: 0.6em;
    border-left: 3px solid var(--mara-border, #555);
    opacity: 0.92;
    white-space: pre-wrap;
  }
  .mara-chatview :global(.mara-list) {
    margin: 0.4em 0;
    padding-left: 1.5em;
  }
  /* A message never opens with a leading gap from its first block's top margin. */
  .mara-chatview :global(.mara-text > :first-child) {
    margin-top: 0;
  }
  .mara-chatview :global(.mara-spoiler) {
    background: var(--mara-fg, #e6e6e6);
    color: transparent;
    border-radius: 4px;
    cursor: pointer;
    padding: 0 0.2em;
  }
  .mara-chatview :global(.mara-spoiler.revealed) {
    background: var(--mara-bg-alt, rgba(127, 127, 127, 0.18));
    color: inherit;
  }
</style>
