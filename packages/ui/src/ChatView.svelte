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
  }: {
    lines: ChatLine[];
    users: Map<Token, UserInfo>;
  } = $props();

  let viewport = $state<HTMLDivElement | null>(null);
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
      timestamp: new Date(line.at).toLocaleTimeString(),
    };
  }

  // Re-pin once the user scrolls back within 40px of the bottom; beyond that we
  // assume they're reading history and stop auto-scrolling.
  function onScroll() {
    if (!viewport) return;
    const distance = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    pinnedToBottom = distance < 40; // px slack to absorb sub-pixel/layout jitter
  }

  $effect(() => {
    lines.length; // track new lines
    if (pinnedToBottom && viewport) viewport.scrollTop = viewport.scrollHeight;
  });

  // Inline images load asynchronously and grow the content height AFTER the
  // new-line scroll above has already run, leaving the view a little short of the
  // bottom. While still pinned, re-stick to the bottom as each image finishes.
  // ('load' doesn't bubble, so listen in the capture phase.)
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const onLoad = (event: Event) => {
      if (pinnedToBottom && event.target instanceof HTMLImageElement) {
        el.scrollTop = el.scrollHeight;
      }
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
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
  {#each lines as line (line.id)}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by chat-render -->
    {@html renderLine(toModel(line))}
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
  .mara-chatview :global(.mara-imgs) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.15rem;
  }
  .mara-chatview :global(.mara-img-box) {
    position: relative;
    display: inline-block;
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
