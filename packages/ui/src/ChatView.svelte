<!-- Scrolling chat log. Renders each line via chat-render's sanitized {@html}
     output, then layers interactivity (spoiler reveal, image hide/lightbox) on
     top imperatively since the markup isn't ours to bind handlers onto. -->
<script lang="ts">
  import { renderLine, type LineModel } from '@mara/chat-render';
  import type { ChatLine, Token, UserInfo } from '@mara/client-core';
  import { openLightbox } from './lightbox.js';
  import { freezeAnimatedImages } from './freezeAnimated.js';

  let {
    lines = [],
    users,
    sessionStart = 0,
    hasMore = false,
    onLoadOlder,
    onRestore,
    conversationKey = null,
    emoji = {},
    messageStyle = 'mara',
    showAvatars = true,
  }: {
    lines: ChatLine[];
    users: Map<Token, UserInfo>;
    /** Timestamp (ms) of this session's connect; a rule is drawn where the lines
     *  cross from older backlog (< this) into the session (>= this). 0 disables it. */
    sessionStart?: number;
    /** True when older messages can be paged in (drives the scroll-up loader). */
    hasMore?: boolean;
    /** Called when the user scrolls near the top and `hasMore` — request older messages. */
    onLoadOlder?: () => void;
    /** Called when the user clicks the "cleared" marker — re-fetch the channel's backlog. */
    onRestore?: () => void;
    /** Identifies the conversation on show (e.g. `ch:1`/`pm:2`). When it changes, the view
     *  lands on the new conversation's latest instead of inheriting the old scroll/pin. */
    conversationKey?: string | null;
    /** Custom emoji map (shortcode → image URL); `:name:` in a message renders inline. */
    emoji?: Record<string, string>;
    /** Message layout: 'mara' (compact) or 'discord' (cozy header + grouped runs). */
    messageStyle?: 'mara' | 'discord';
    /** Show avatars in messages (image or monogram); off shows names only. */
    showAvatars?: boolean;
  } = $props();

  // Known users for `@Name` mention styling (bold in the target's colour + glow) —
  // from the same map that names the lines, so mentions of departed users in
  // backlog still render styled.
  const mentionUsers = $derived([...users.values()].map((u) => ({ name: u.name, color: u.color })));

  let viewport = $state<HTMLDivElement | null>(null);
  let content = $state<HTMLDivElement | null>(null);
  // Auto-scroll unless the user has scrolled up to read history ("freeze").
  let pinnedToBottom = $state(true);
  // Inline images the user has hidden (covered in place), keyed by URL. Kept here (not in the
  // DOM) so the choice survives the {@html} re-renders that fire when the roster
  // or timestamp setting changes. Reassigned on change for reactivity.
  let hiddenImages = $state(new Set<string>());

  // The img src is the stable identity used to key hidden state across re-renders.
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
      // From the live roster, so avatar changes reflect on already-rendered lines; a
      // departed author (not in the roster) falls back to the monogram.
      authorAvatar: user?.avatar,
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

  // discord layout groups consecutive messages from one author (like Discord): only the
  // first shows the name+timestamp header. A different author, a non-chat line in between
  // (join/leave/emote), too long a gap, or the session divider breaks the run.
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  function isContinuation(i: number): boolean {
    if (messageStyle !== 'discord' || i === 0) return false;
    const cur = lines[i];
    const prev = lines[i - 1];
    if (!cur || !prev || cur.kind !== 'chat' || prev.kind !== 'chat') return false;
    if (cur.from === null || cur.from !== prev.from) return false;
    if (cur.at - prev.at > GROUP_WINDOW_MS) return false;
    // A session boundary rule sits between them → start a fresh, labelled group.
    if (sessionStart > 0 && prev.at < sessionStart && cur.at >= sessionStart) return false;
    return true;
  }

  // Last seen scrollTop, to tell a user scroll-up from content growing under us.
  let lastScrollTop = 0;
  // Line count at the last effect run, to distinguish a prepend (older history paged in)
  // from an append (live message) when the array grows.
  let lastLen = 0;
  // Conversation shown at the last effect run (undefined until the first), so a switch
  // between channels/PMs is detected and handled as a fresh view rather than an append.
  let lastKey: string | null | undefined;
  // Set while an older-history page is loading: the pre-prepend scroll metrics, so we can
  // restore the viewport position once the taller content renders (no jump). Also acts as
  // the in-flight guard so we don't fire overlapping load requests.
  let pendingAnchor = $state<{ prevHeight: number; prevTop: number } | null>(null);

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
    // Near the top with more to load and no load in flight: page in older history.
    // Capture the current metrics so the effect below can restore the position after
    // the prepend grows the content upward.
    if (st < 80 && hasMore && !pendingAnchor && onLoadOlder) {
      pendingAnchor = { prevHeight: viewport.scrollHeight, prevTop: st };
      onLoadOlder();
    }
  }

  $effect(() => {
    const key = conversationKey; // track conversation switches
    const len = lines.length; // ...and new lines
    const el = viewport;
    if (!el) {
      lastLen = len;
      lastKey = key;
      return;
    }
    if (key !== lastKey) {
      // Switched conversations: land on this one's latest with fresh state, rather than
      // inheriting the previous conversation's pin and (now meaningless) scroll position.
      pendingAnchor = null;
      pinnedToBottom = true;
      el.scrollTop = el.scrollHeight;
      lastScrollTop = el.scrollTop;
    } else if (pendingAnchor && len > lastLen) {
      // Older messages were prepended: shift down by the added height so the line the
      // user was reading stays put, instead of jumping to the new top.
      el.scrollTop = el.scrollHeight - pendingAnchor.prevHeight + pendingAnchor.prevTop;
      pendingAnchor = null;
    } else if (pinnedToBottom) {
      el.scrollTop = el.scrollHeight;
    }
    lastLen = len;
    lastKey = key;
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

      // The "cleared" marker: clicking it re-fetches the channel's server backlog.
      if (target?.closest('.mara-cleared')) {
        onRestore?.();
        return;
      }

      // Inline image cover/reveal — spoiler-style: a corner eye/× toggle that covers the
      // image in place (no reflow). The choice is persisted in `hiddenImages` (keyed by src)
      // so it survives the {@html} re-renders a roster/timestamp change triggers — unlike a
      // text spoiler, whose reveal is DOM-only.
      const imgBox = target?.closest('.mara-img-box');
      if (imgBox) {
        const src = imgSrcOf(imgBox);
        if (imgBox.classList.contains('hidden')) {
          // Covered → a click anywhere reveals it (matches a covered spoiler).
          const next = new Set(hiddenImages);
          next.delete(src);
          hiddenImages = next;
          return;
        }
        // Shown → the corner handle hides it; a click on the image itself falls through to
        // the lightbox below.
        if (target.closest('.mara-img-toggle')) {
          const next = new Set(hiddenImages);
          next.add(src);
          hiddenImages = next;
          return;
        }
      }

      const spoiler = target?.closest('.mara-spoiler');
      if (spoiler) {
        if (!spoiler.classList.contains('revealed')) {
          spoiler.classList.add('revealed'); // first click uncovers it
          return;
        }
        // Revealed: only the little re-hide handle collapses it again, so a link or
        // image inside stays independently clickable — a content click falls through
        // to the image/link handlers instead of re-hiding the spoiler.
        if (target.closest('.mara-spoiler-hide')) {
          spoiler.classList.remove('revealed');
          return;
        }
      }
      const img = target?.closest('img.mara-img') as HTMLImageElement | null;
      if (img && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault(); // don't navigate the wrapping anchor
        openLightbox(img.currentSrc || img.src, img.alt);
        return;
      }
      // Custom emoji zoom to full resolution in the lightbox on a plain left-click.
      const emojiImg = target?.closest('img.mara-emoji') as HTMLImageElement | null;
      if (emojiImg && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        openLightbox(emojiImg.currentSrc || emojiImg.src, emojiImg.alt);
        return;
      }
      // Avatars expand in the lightbox on a plain left-click. Only an image avatar matches
      // `img.mara-avatar`; the monogram fallback is a <span>, so it's left alone.
      const avatar = target?.closest('img.mara-avatar') as HTMLImageElement | null;
      if (avatar && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        openLightbox(avatar.currentSrc || avatar.src, avatar.alt);
      }
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  });

  // Animated emoji / GIFs play for a few seconds then freeze (hover to replay), so a busy
  // channel doesn't loop forever. Operates on the rendered images and tracks new messages via a
  // MutationObserver; set up once on the content element.
  $effect(() => {
    const el = content;
    if (!el) return;
    return freezeAnimatedImages(el);
  });

  // Reconcile hidden state onto the DOM after each render (the {@html} blocks
  // are rebuilt on roster/timestamp changes, so DOM classes alone wouldn't stick).
  $effect(() => {
    lines.length; // re-run when lines change
    void users; // ...and when the roster re-renders the lines
    const set = hiddenImages;
    const el = viewport;
    if (!el) return;
    for (const box of el.querySelectorAll('.mara-img-box')) {
      box.classList.toggle('hidden', set.has(imgSrcOf(box)));
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
      {@html renderLine(toModel(line), {
        emoji,
        mentions: mentionUsers,
        layout: messageStyle,
        continuation: isContinuation(i),
        avatars: showAvatars,
      })}
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
  /* Avatars: round; either an <img> or a coloured-initial monogram fallback. Sized in rem
     so they don't scale with the message font (a fixed, tidy avatar column). No background,
     so a transparent avatar image shows through instead of sitting on a grey plate (the
     monogram fallback paints its own colour inline). */
  .mara-chatview :global(.mara-avatar) {
    flex: none;
    border-radius: 50%;
    object-fit: cover;
    vertical-align: middle;
  }
  /* An image avatar expands in the lightbox on click (see the click handler); the monogram
     fallback is a <span> and isn't clickable, so only the <img> gets the zoom affordance. */
  .mara-chatview :global(img.mara-avatar) {
    cursor: zoom-in;
  }
  .mara-chatview :global(.mara-avatar-mono) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 600;
    overflow: hidden;
  }
  .mara-chatview :global(.mara-avatar-inline) {
    width: 1.2rem;
    height: 1.2rem;
    margin-right: 0.35rem;
    font-size: 0.72rem;
    /* `vertical-align: middle` centers on the text's x-height, which leaves the (taller)
       avatar sitting ~0.15rem low; nudge it up so its center matches the line box, i.e. it
       reads as centered on the name + first line of text. Preserves inline flow, so it stays
       on the first line when a long message wraps. */
    position: relative;
    top: -0.15rem;
  }
  .mara-chatview :global(.mara-avatar-lg) {
    width: 2.4rem;
    height: 2.4rem;
    margin-top: 0.1rem;
    font-size: 1rem;
  }
  /* discord (cozy) layout: an avatar gutter, then a `Name  timestamp` header with the text
     below. A grouped run (mara-cont) drops the avatar+header and indents up under them. */
  .mara-chatview :global(.mara-line.mara-discord) {
    display: block;
    /* Breathing room between consecutive messages in a run — more than a plain wrapped
       line, less than the larger gap before a new author's group (below). */
    margin: 0.22rem 0 0;
  }
  .mara-chatview :global(.mara-line.mara-discord:not(.mara-cont)) {
    display: flex;
    /* Top-align so the avatar sits beside the name + first line of text (not floating to the
       middle of a long message); avatar-lg's small margin-top centers it on those two rows. */
    align-items: flex-start;
    gap: 0.6rem;
    margin-top: 0.6rem;
  }
  .mara-chatview :global(.mara-discord-main) {
    flex: 1;
    min-width: 0;
  }
  .mara-chatview :global(.mara-discord .mara-head) {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    line-height: 1.3;
  }
  .mara-chatview :global(.mara-discord .mara-author) {
    /* Discord shows the name a touch larger than the message text. */
    font-size: 1.05rem;
  }
  .mara-chatview :global(.mara-discord .mara-text) {
    display: block;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  /* Continuation lines align under the header (avatar width 2.4rem + 0.6rem gap); with
     avatars off there's no gutter, so they sit flush left. */
  .mara-chatview :global(.mara-discord.mara-cont .mara-text) {
    padding-left: 3rem;
  }
  .mara-chatview :global(.mara-discord.mara-cont.mara-no-av .mara-text) {
    padding-left: 0;
  }
  .mara-chatview :global(.mara-system) {
    opacity: 0.6;
  }
  /* The client-side "cleared" marker: a centered, pill-shaped button prompting a re-fetch. */
  .mara-chatview :global(.mara-cleared-line) {
    display: flex;
    justify-content: center;
    padding: 0.4rem 0;
  }
  .mara-chatview :global(.mara-cleared) {
    font: inherit;
    font-size: 0.85em;
    color: var(--mara-fg, #ddd);
    opacity: 0.6;
    background: transparent;
    border: 1px dashed var(--mara-border, #444);
    border-radius: 999px;
    padding: 0.2rem 0.75rem;
    cursor: pointer;
    transition:
      opacity 0.15s ease,
      background 0.15s ease;
  }
  .mara-chatview :global(.mara-cleared:hover) {
    opacity: 1;
    background: rgba(127, 127, 127, 0.14);
  }
  .mara-chatview :global(.mara-emote) {
    opacity: 0.92;
  }
  .mara-chatview :global(a) {
    color: var(--mara-link, #5aa9ff);
  }
  /* Custom emoji: inline, sized to the text line (not a media block like .mara-img). */
  .mara-chatview :global(.mara-emoji) {
    display: inline-block;
    height: 1.4em;
    width: auto;
    max-width: 100%;
    vertical-align: -0.3em;
    margin: 0 0.02em;
    object-fit: contain;
    /* Click to zoom to full resolution in the lightbox (see ChatView's click handler). */
    cursor: zoom-in;
  }
  /* Emoji-only messages render their emoji large (Discord "jumbo"). Emoji are sized in `em`
     — native ones are text glyphs, custom ones are 1.4em <img> — so bumping the container's
     font-size scales both together; the `-lg` tier is for a message of just a few. */
  .mara-chatview :global(.mara-text.mara-jumbo) {
    font-size: 2em;
    line-height: 1.2;
  }
  .mara-chatview :global(.mara-text.mara-jumbo-lg) {
    font-size: 2.9em;
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
  /* Hidden → cover the image where it sits (no reflow): blank the image but keep its box
     size, tint the box, and make the link/img click-through so a click reveals it rather
     than navigating — the same "cover in place" a text spoiler does. */
  .mara-chatview :global(.mara-img-box.hidden) {
    background: rgba(127, 127, 127, 0.3);
    border-radius: 4px;
    cursor: pointer;
  }
  .mara-chatview :global(.mara-img-box.hidden .mara-img) {
    visibility: hidden;
  }
  .mara-chatview :global(.mara-img-box.hidden .mara-img-link) {
    pointer-events: none;
  }
  /* The image's corner show/hide toggle (.mara-img-toggle) shares the spoiler handle's base
     styling and its own dark backdrop + eye/× states — defined alongside .mara-spoiler-hide
     below so the shared base rule comes first. */

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
    position: relative; /* containing block for the corner toggle */
    /* inline-block so the cover/background fills the FULL box — including the height
       of a tall image propping it up (a plain inline background only paints the
       text-line strip, leaving the image area uncovered). max-width keeps a long
       spoiler from overflowing its row. */
    display: inline-block;
    max-width: 100%;
    vertical-align: top;
    /* A subtle neutral tint while covered — a touch stronger than the revealed
       background below so the two states are still distinguishable, without the
       harsh near-text-colour bar it used to be. */
    background: rgba(127, 127, 127, 0.3);
    color: transparent;
    border-radius: 4px;
    cursor: pointer;
    /* Extra right padding reserves the top-right corner for the show/hide toggle so
       content never runs under it. */
    padding: 0 1.55em 0 0.25em;
  }
  /* `color: transparent` on the span only hides its own text. A link keeps its own
     colour and an image ignores `color` entirely, so both leak through the spoiler —
     blank every descendant until revealed (text/links transparent, images hidden).
     `pointer-events: none` also makes a hidden link/image click-through to the span,
     so clicking a covered spoiler reveals it instead of opening the link (the app's
     document-level link handler never sees an <a> target). The show/hide handle is
     excluded — it must stay visible and clickable in BOTH states. */
  .mara-chatview :global(.mara-spoiler:not(.revealed) *:not(.mara-spoiler-hide)) {
    color: transparent !important;
    text-shadow: none !important;
    pointer-events: none;
  }
  .mara-chatview :global(.mara-spoiler:not(.revealed) img) {
    visibility: hidden;
  }
  .mara-chatview :global(.mara-spoiler.revealed) {
    background: var(--mara-bg-alt, rgba(127, 127, 127, 0.18));
    color: inherit;
  }
  /* Persistent show/hide toggle icon, present in both states (kept out of the cover
     blanking above): an eye to reveal while covered, an × to collapse once revealed.
     Bare icon — no pill — coloured to contrast with each state's own background (the
     covered bar is `--mara-fg`, the revealed bg is subtle), so it reads cleanly in
     both light and dark themes. */
  .mara-chatview :global(.mara-spoiler-hide),
  .mara-chatview :global(.mara-img-toggle) {
    /* Feather-style eye, masked so it takes `currentColor`. */
    --mara-eye: url("data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2024%2024'%20fill='none'%20stroke='%23fff'%20stroke-width='2.2'%20stroke-linecap='round'%20stroke-linejoin='round'%3E%3Cpath%20d='M1%2012s4-7%2011-7%2011%207%2011%207-4%207-11%207S1%2012%201%2012z'/%3E%3Ccircle%20cx='12'%20cy='12'%20r='3'/%3E%3C/svg%3E");
    /* Pinned to the box's top-right corner. */
    position: absolute;
    top: 0.15em;
    right: 0.2em;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.15em;
    height: 1.15em;
    border-radius: 3px;
    font-size: 0.85em;
    line-height: 1;
    opacity: 0.7;
    cursor: pointer;
    user-select: none;
    /* Both states now sit on a subtle background, so the icon is just the text
       colour (contrasts in either theme). */
    color: var(--mara-fg, #ddd);
  }
  .mara-chatview :global(.mara-spoiler-hide:hover) {
    opacity: 1;
    background: rgba(127, 127, 127, 0.25);
  }
  /* Covered → an eye ("reveal"), drawn as a masked inline SVG so it takes the
     handle's colour and stays crisp/identical on every platform. */
  .mara-chatview :global(.mara-spoiler:not(.revealed) .mara-spoiler-hide)::before {
    content: '';
    width: 1em;
    height: 1em;
    background-color: currentColor;
    -webkit-mask: var(--mara-eye) center / contain no-repeat;
    mask: var(--mara-eye) center / contain no-repeat;
  }
  /* Revealed → × ("collapse"). */
  .mara-chatview :global(.mara-spoiler.revealed .mara-spoiler-hide)::before {
    content: '\00d7';
    font-size: 1.25em; /* the × glyph reads small; bump it to match the box */
  }
  /* Image toggle: same handle, but a dark backdrop so the icon reads over any image pixels
     (a spoiler sits on its own tint and needs none). These come after the shared base rule so
     the white icon colour wins. Shown → × ("hide"); hidden → an eye ("reveal"). */
  .mara-chatview :global(.mara-img-toggle) {
    background: rgba(0, 0, 0, 0.5);
    color: #fff;
  }
  .mara-chatview :global(.mara-img-toggle:hover) {
    opacity: 1;
    background: rgba(0, 0, 0, 0.72);
  }
  .mara-chatview :global(.mara-img-box:not(.hidden) .mara-img-toggle)::before {
    content: '\00d7';
    font-size: 1.25em;
  }
  .mara-chatview :global(.mara-img-box.hidden .mara-img-toggle)::before {
    content: '';
    width: 1em;
    height: 1em;
    background-color: currentColor;
    -webkit-mask: var(--mara-eye) center / contain no-repeat;
    mask: var(--mara-eye) center / contain no-repeat;
  }
</style>
