<!-- Scrolling chat log. Renders each line via chat-render's sanitized {@html}
     output, then layers interactivity (spoiler reveal, image hide/lightbox) on
     top imperatively since the markup isn't ours to bind handlers onto. -->
<script lang="ts">
  import { untrack } from 'svelte';
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
    onReply,
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
    /** Called when the user picks Reply on a message. Omit (as PMs do — they have no server
     *  message ids) and no reply affordance is offered. */
    onReply?: (line: ChatLine) => void;
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

  // A very tall message is clamped to a fraction of the viewport height and gets a "Show more"
  // toggle, so one giant message can't swallow the whole view. `clippedMessages` holds the ids
  // (line.id) whose content overflows the clamp; `expandedMessages` those the user opened.
  // `measureTick` forces a re-measure when the content reflows or the window resizes.
  const MAX_MESSAGE_VH = 0.6; // clamp to 60% of the viewport height (keep in sync with the CSS)
  let clippedMessages = $state(new Set<number>());
  let expandedMessages = $state(new Set<number>());
  let measureTick = $state(0);

  function toggleExpand(id: number) {
    const next = new Set(expandedMessages);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedMessages = next;
  }

  // The message a jump (from a reply's quote bar) just landed on, highlighted so the eye finds
  // it — keyed by line.id, cleared by a timer. The highlight HOLDS at full strength for the
  // first part of its run and only then fades (see the mara-flash keyframes): the smooth scroll
  // takes a few hundred ms to arrive, and a plain fade-from-full would already be half gone by
  // the time the message is actually on screen.
  const FLASH_MS = 3400;
  let flashedMessage = $state<number | null>(null);
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Where we jumped FROM, so you can get back. A stack, not a single value: following a reply
   * chain upwards (a reply to a reply to a reply) pushes each hop, and the Back button walks
   * them down in reverse. Holds `line.id`s (client-side, stable while the line is loaded).
   */
  let jumpStack = $state<number[]>([]);
  /** True while a jump's smooth scroll is in flight: suppresses the auto-scroll behaviours that
   *  would otherwise drag the viewport away from the message we just jumped to. */
  let jumping = $state(false);
  let jumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the user last drove a scroll themselves (wheel/touch/scrollbar/keys) — as opposed to
   *  the scrolling we do. Lets `pruneJumpStack` react only to their movement. */
  let userScrolledAt = 0;

  /**
   * Hunting for a quoted message that isn't in the lines we hold: page older history in, a
   * chunk at a time, until it turns up. Bounded three independent ways, so a quote whose parent
   * is unreachable can never spin:
   *
   *  - `hasMore` goes false — the server has nothing older; the message is gone for good.
   *  - `HUNT_MAX_PAGES` — a hard ceiling on requests, however deep the history is.
   *  - `HUNT_TIMEOUT_MS` — a watchdog, in case a request is simply never answered.
   *
   * Progress is measured by the oldest server id we hold going DOWN. That matters: a live
   * message arriving mid-hunt also changes `lines`, and without this it would look like a page
   * came back and drive another request off a cursor that hadn't moved.
   */
  const HUNT_MAX_PAGES = 10;
  const HUNT_TIMEOUT_MS = 6000;
  /** `origin` is the line we're jumping FROM — pushed onto `jumpStack` only if the hunt lands,
   *  so a search that gives up doesn't leave a Back button pointing at a hop that never happened. */
  let hunt = $state<{
    serverId: number;
    pages: number;
    oldest: number;
    origin: number | null;
  } | null>(null);
  let huntTimer: ReturnType<typeof setTimeout> | null = null;
  /** Transient "couldn't find it" notice, shown when a hunt gives up. */
  let huntFailed = $state(false);
  let failTimer: ReturnType<typeof setTimeout> | null = null;

  /** Oldest server id we currently hold (the paging cursor), or null if we hold none. */
  function oldestServerId(): number | null {
    for (const l of lines) if (l.serverId != null) return l.serverId;
    return null;
  }

  function endHunt(failed: boolean) {
    hunt = null;
    if (huntTimer) clearTimeout(huntTimer);
    huntTimer = null;
    if (!failed) return;
    huntFailed = true;
    if (failTimer) clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      huntFailed = false;
      failTimer = null;
    }, 3500);
  }

  /** Ask for the next older page and (re)arm the watchdog. */
  function requestHuntPage() {
    // Reuse the scroll-loader's anchor: it both preserves the reading position across the
    // prepend and blocks the scroll handler from firing its own overlapping load.
    if (viewport && !pendingAnchor) {
      pendingAnchor = { prevHeight: viewport.scrollHeight, prevTop: viewport.scrollTop };
    }
    if (huntTimer) clearTimeout(huntTimer);
    huntTimer = setTimeout(() => endHunt(true), HUNT_TIMEOUT_MS);
    onLoadOlder?.();
  }

  /**
   * Scroll to a message we hold, and flash it.
   *
   * The view has two mechanisms that will happily undo this, and both run right after us (the
   * scroll-position effect below, and the ResizeObserver re-pin) — so a naive scrollIntoView
   * here lands and is then immediately yanked back, and the jump looks like it did nothing:
   *
   *  - `pendingAnchor` (set per hunt page, to hold the reading position across a prepend) makes
   *    the position effect restore the pre-page scrollTop.
   *  - `pinnedToBottom` — if you were at the bottom when you clicked, every content growth
   *    re-pins you to the bottom.
   *
   * So: drop the anchor, leave "follow the bottom" mode, and hold `jumping` for the duration of
   * the smooth scroll, which suppresses both (and the scroll handler's own auto-load, which
   * would otherwise prepend more history under us mid-flight and move the target).
   */
  const JUMP_SETTLE_MS = 1600;
  /** The message a jump is travelling to, while the lock is held. */
  let jumpTargetLine: number | null = null;
  /**
   * Set for the single update in which a jump begins, so the position effect skips its one
   * re-aim there.
   *
   * This matters for a jump that follows a hunt: the very page that *delivers* the target also
   * grows `lines`, so without this the effect would treat it as "content moved under an in-flight
   * jump" and instant-scroll — landing us before scrollToLine's animation frame even runs, and
   * silently turning every hunted jump into a teleport. Prepends that arrive *later* (while the
   * scroll is genuinely in flight) still re-aim, which is what that path is for.
   */
  let jumpJustStarted = false;

  /**
   * Re-aim at the jump target, immediately. Called ONLY when older history is prepended under an
   * in-flight jump: a prepend both shifts the target's offset (so the smooth scroll is now headed
   * for the wrong place) and is what the scroll-anchor restore would use to drag us back where we
   * started. Instant, not smooth — a correction, not a journey.
   *
   * Deliberately NOT called on every reflow. Doing that cancelled the smooth scroll on any
   * incidental resize (the jump "zipped" straight there instead of animating).
   */
  function reaimJumpTarget() {
    if (!jumping || jumpTargetLine === null) return;
    pendingAnchor = null; // whatever it was restoring, the jump outranks it
    content
      ?.querySelector<HTMLElement>(`.mara-msg[data-id="${jumpTargetLine}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  /**
   * The user grabbed the scroll — abandon the jump at once, so nothing fights them. Their input
   * always outranks an animation we started.
   *
   * Dropping our own bookkeeping isn't enough: the browser's smooth `scrollIntoView` is still
   * animating, and it will keep overriding each wheel tick until it reaches its destination —
   * which is precisely the "it fights you until it would have finished" symptom. Issuing a new,
   * instant scroll to where we already are aborts that animation (any new scroll supersedes an
   * in-progress smooth one), leaving the wheel free to do its thing.
   */
  function cancelJump() {
    if (!jumping) return;
    jumping = false;
    jumpTargetLine = null;
    jumpJustStarted = false;
    if (jumpTimer) clearTimeout(jumpTimer);
    jumpTimer = null;
    viewport?.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });
  }

  function scrollToLine(id: number) {
    if (!content?.querySelector(`.mara-msg[data-id="${id}"]`)) return;
    // Abort any smooth scroll still running from a previous jump before starting this one. Two
    // overlapping scroll animations do NOT cleanly supersede each other — they fight, and you
    // land somewhere that is neither target. This bites whenever a jump is started while another
    // is in flight: following a chain quickly, or clicking Back twice in a row.
    viewport?.scrollTo({ top: viewport.scrollTop, behavior: 'instant' });

    pinnedToBottom = false;
    pendingAnchor = null;
    jumping = true;
    jumpTargetLine = id;
    jumpJustStarted = true; // let the animation own this first update (see the field's note)
    if (jumpTimer) clearTimeout(jumpTimer);
    jumpTimer = setTimeout(() => {
      jumping = false;
      jumpTargetLine = null;
      jumpJustStarted = false;
      jumpTimer = null;
    }, JUMP_SETTLE_MS);

    if (flashTimer) clearTimeout(flashTimer);
    // Drop the class before re-adding it, so clicking the same quote again restarts the
    // animation instead of doing nothing (re-setting an unchanged class is a no-op to CSS).
    flashedMessage = null;
    requestAnimationFrame(() => {
      // Re-query: the list may have re-rendered between the click and this frame.
      content
        ?.querySelector<HTMLElement>(`.mara-msg[data-id="${id}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      flashedMessage = id;
      flashTimer = setTimeout(() => {
        flashedMessage = null;
        flashTimer = null;
      }, FLASH_MS);
    });
  }

  /** Record the hop we just made, so Back can undo it. Guards against pushing the same line
   *  twice in a row (a double-click on a quote bar shouldn't stack two identical hops). */
  function pushHop(origin: number | null) {
    if (origin === null || jumpStack[jumpStack.length - 1] === origin) return;
    jumpStack = [...jumpStack, origin];
  }

  // Jump to the message with server id `serverId`, remembering `origin` (the line we jumped from)
  // so the Back button can return there. If we don't hold the target, start paging older history
  // in to look for it (see `hunt` above) rather than doing nothing.
  function jumpTo(serverId: number, origin: number | null) {
    const target = lines.find((l) => l.serverId === serverId);
    if (target) {
      endHunt(false);
      pushHop(origin);
      scrollToLine(target.id);
      return;
    }
    const oldest = oldestServerId();
    // Nothing older to fetch (or no cursor to fetch from): the quoted message is beyond what
    // the server still retains, so say so instead of hunting for something that can't arrive.
    if (!hasMore || !onLoadOlder || oldest === null) {
      endHunt(true);
      return;
    }
    hunt = { serverId, pages: 1, oldest, origin };
    huntFailed = false;
    requestHuntPage();
  }

  // Drive the hunt as pages arrive. Runs on every `lines` change; only a change that actually
  // moved the cursor older counts as a page (see the note on `hunt`).
  $effect(() => {
    void lines;
    const active = untrack(() => hunt);
    if (!active) return;

    const found = untrack(() => lines).find((l) => l.serverId === active.serverId);
    if (found) {
      endHunt(false);
      pushHop(active.origin); // the hop is real now — the target actually turned up
      scrollToLine(found.id);
      return;
    }
    const oldest = untrack(() => oldestServerId());
    if (oldest === null || oldest >= active.oldest) return; // not a page — keep waiting

    // A page landed and the message wasn't in it. Go older, unless we've hit a limit.
    if (active.pages >= HUNT_MAX_PAGES || !hasMore) {
      endHunt(true);
      return;
    }
    hunt = { ...active, pages: active.pages + 1, oldest };
    requestHuntPage();
  });

  // Abandon a hunt (and any notice, and the way back) when the conversation changes out from
  // under it — the hops on the stack belong to the conversation we just left.
  $effect(() => {
    void conversationKey;
    untrack(() => {
      if (hunt) endHunt(false);
      huntFailed = false;
      jumpStack = [];
    });
  });

  /** Walk one hop back down the chain, to the message whose quote bar we last followed. */
  function jumpBack() {
    const next = [...jumpStack];
    const id = next.pop();
    jumpStack = next;
    if (id !== undefined) scrollToLine(id);
  }

  /**
   * Retire hops the user has already made for themselves. If you scroll back down under your own
   * steam and the message you jumped from is on screen again, that hop is done — offering to take
   * you somewhere you're already looking is noise, so the Back button drops it (and disappears
   * once every hop is retired). Walks the stack, so scrolling all the way down after following a
   * chain clears the lot.
   *
   * A hop whose message is no longer loaded is dropped too: Back couldn't reach it anyway.
   *
   * Only ever runs off a scroll the USER drove (see `userScrolledAt`). A `scroll` event alone
   * isn't good enough: our own scrolling emits those too, and pruning on them retired hops the
   * user never scrolled past — including, memorably, removing the Back button between the
   * mousedown and the click of the very press that was trying to use it.
   */
  const USER_SCROLL_WINDOW_MS = 400;
  function pruneJumpStack() {
    if (jumping || jumpStack.length === 0 || !viewport || !content) return;
    if (Date.now() - userScrolledAt > USER_SCROLL_WINDOW_MS) return;
    const view = viewport.getBoundingClientRect();
    let next = jumpStack;
    while (next.length > 0) {
      const el = content.querySelector(`.mara-msg[data-id="${next[next.length - 1]}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        const onScreen = r.top < view.bottom && r.bottom > view.top;
        if (!onScreen) break;
      }
      next = next.slice(0, -1);
    }
    if (next.length !== jumpStack.length) jumpStack = next;
  }

  $effect(() => () => {
    if (huntTimer) clearTimeout(huntTimer);
    if (failTimer) clearTimeout(failTimer);
    if (flashTimer) clearTimeout(flashTimer);
    if (jumpTimer) clearTimeout(jumpTimer);
  });

  // Cheeky stand-ins for a plain "Show more" / "Show less" on a clamped (over-long) message.
  const EXPAND_LABELS = [
    'Well, that was long',
    "Got a bit wordy, didn't it?",
    'Somebody had thoughts',
    "The director's cut",
    'Brevity? Never heard of her',
    'There’s more, of course',
    'Keep going, brave soul',
    'The rest of the saga',
    'It goes on. And on.',
    'Show the whole manifesto',
    "You sure? It's a lot",
    'The full thesis awaits',
    'Someone skipped the edit',
    'Peek behind the fold',
    'Finish the novel',
    "War and Peace, cont'd",
    'Room for more paragraphs',
    'Unroll the scroll',
    'More words this way',
    'Yeah, there’s extra',
  ];
  const COLLAPSE_LABELS = [
    'TL;DR',
    'Okay, enough',
    'That’s plenty',
    'Fold it back up',
    "I've seen enough",
    'Wrap it up',
    'Collapse the essay',
    'Back in the box',
    'Roll it back up',
    'That’ll do',
    'Nevermind...',
    'Less is more',
    'Point taken',
    'Retract the manifesto',
    'Reel it in',
    'Enough said',
    'Spare me the rest',
    'Shrink it down',
    'Nope, close it',
    'Mercy — collapse',
  ];
  // Pick one deterministically from the message id, so the quip is stable across the {@html}
  // re-renders (roster/timestamp changes) instead of flickering to a new one each time. A
  // multiplicative hash scatters sequential ids so neighbouring messages rarely share a line.
  function pickLabel(labels: string[], id: number): string {
    return labels[(Math.imul(id, 2654435761) >>> 0) % labels.length] ?? labels[0] ?? '';
  }

  // The expand/collapse pill is tinted with the message author's own colour (their name
  // colour), so it reads as "their" control. Falls back to a neutral grey for authorless
  // (system) lines or an invalid colour.
  function authorColorOf(line: ChatLine): string {
    const c = line.from !== null ? users.get(line.from)?.color : undefined;
    return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#888888';
  }
  // Black or white — whichever the YIQ brightness of `hex` (a #rrggbb) says reads better — so
  // the pill's label + chevron stay legible on any author colour.
  function contrastText(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    const yiq = (((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
  }

  // The img src is the stable identity used to key hidden state across re-renders.
  function imgSrcOf(box: Element): string {
    return box.querySelector('img.mara-img')?.getAttribute('src') ?? '';
  }

  // Resolve a transport ChatLine against the live roster into chat-render's view
  // model. Falls back to `#<token>` when the author isn't in the roster (e.g.
  // they left) so history stays attributable.
  function toModel(line: ChatLine): LineModel {
    const user = line.from !== null ? users.get(line.from) : undefined;
    // The quoted author resolves against the LIVE roster first, so a quote reflects their
    // current name/colour like every other line does; the server's snapshot (taken when the
    // reply was sent) is the fallback for an author who has since left.
    const reply = line.replyTo;
    const quoted = reply ? users.get(reply.from) : undefined;
    return {
      kind: line.kind,
      authorName: user?.name ?? (line.from !== null ? `#${line.from}` : ''),
      authorColor: user?.color ?? '#888888',
      replyTo: reply && {
        id: reply.id,
        authorName: quoted?.name ?? reply.name,
        authorColor: quoted?.color ?? reply.color,
        excerpt: reply.excerpt,
        kind: reply.kind,
      },
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
    // A reply carries a quote bar, which needs its own header to sit under — never fold it
    // into the previous author's run.
    if (cur.replyTo) return false;
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
    // Scrolled back to where you jumped from? Then you don't need the Back button for it.
    pruneJumpStack();
    // Near the top with more to load and no load in flight: page in older history.
    // Capture the current metrics so the effect below can restore the position after
    // the prepend grows the content upward. Not while jumping — the smooth scroll passes
    // through the top of the list on its way, and prepending there would shift the very
    // message we're travelling to.
    if (!jumping && st < 80 && hasMore && !pendingAnchor && onLoadOlder) {
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
    } else if (jumping) {
      // A jump owns the viewport. Never restore the old anchor (that is the "scrolls up, then
      // snaps back down to the reply" bug). Re-aim only if the content actually GREW under us —
      // a prepend moves the target, so the in-flight scroll is now headed somewhere stale. A
      // plain re-render (roster change, flash class) leaves the smooth scroll alone... and so
      // does the update that STARTED the jump, whose own growth is the page that delivered the
      // target: re-aiming there would pre-empt the animation entirely.
      pendingAnchor = null;
      if (jumpJustStarted) jumpJustStarted = false;
      else if (len > lastLen) reaimJumpTarget();
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
      // ...but not while a jump is in flight: re-pinning to the bottom on every content growth
      // would drag the viewport off the message we're scrolling to. We don't re-aim from here
      // either — a resize is not necessarily a prepend, and correcting on every reflow killed
      // the smooth scroll (see reaimJumpTarget). The lines effect handles real prepends.
      if (!jumping && pinnedToBottom) el.scrollTop = el.scrollHeight;
      measureTick++; // content reflowed (image loaded, message added) → re-check the clamps
    });
    ro.observe(c);
    const onResize = () => measureTick++; // window height changed → the 70vh threshold moved
    window.addEventListener('resize', onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
    };
  });

  // The user's own scrolling always beats an in-flight jump: a wheel tick, a touch drag, a
  // scrollbar grab, or a scroll key abandons it on the spot. Without this, a jump we started
  // would keep re-aiming (and suppressing the auto-loader) for the whole lock window, which
  // reads exactly like the view fighting you.
  //
  // These are user-INTENT signals specifically — a plain `scroll` event is not, because our own
  // scrollIntoView fires those too. `pruneJumpStack` needs the same distinction, so this is also
  // where `userScrolledAt` is stamped: it's the only place we can tell "you scrolled" from "we
  // scrolled".
  $effect(() => {
    const el = viewport;
    if (!el) return;
    const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
    const userScroll = () => {
      userScrolledAt = Date.now();
      cancelJump();
    };
    const onKey = (e: KeyboardEvent) => {
      if (SCROLL_KEYS.has(e.key)) userScroll();
    };
    // Only a press on the SCROLLBAR is a scroll gesture. A press on the message list — or on the
    // Back button floating over it — is not: treating those as scrolling let a click on Back
    // prune the very hop it was about to use, deleting the button between mousedown and click.
    const onMouseDown = (e: MouseEvent) => {
      if (e.offsetX > el.clientWidth) userScroll();
    };
    el.addEventListener('wheel', userScroll, { passive: true });
    el.addEventListener('touchstart', userScroll, { passive: true });
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('wheel', userScroll);
      el.removeEventListener('touchstart', userScroll);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('keydown', onKey);
    };
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

      // A reply's quote bar jumps to the message it quotes — remembering the reply itself as
      // the way back.
      const quote = target?.closest('.mara-reply');
      if (quote) {
        const from = quote.closest<HTMLElement>('.mara-msg')?.dataset.id;
        jumpTo(Number(quote.getAttribute('data-reply-id')), from ? Number(from) : null);
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

  // Measure which messages overflow the height clamp, so only those show a "Show more" toggle.
  // Re-runs after each render and whenever the content reflows / the window resizes. We measure
  // the rendered line box — which the wrapper's clip doesn't shrink — so toggling the clamp
  // can't change the measurement and loop. Reads clippedMessages untracked to avoid self-triggering.
  $effect(() => {
    lines.length; // re-measure when messages change,
    void users; // ...when the roster re-renders them,
    void expandedMessages; // ...after an expand/collapse,
    void measureTick; // ...and on reflow / resize.
    const c = content;
    if (!c) return;
    const threshold = window.innerHeight * MAX_MESSAGE_VH;
    const next = new Set<number>();
    for (const msg of c.querySelectorAll<HTMLElement>('.mara-msg')) {
      const line = msg.querySelector<HTMLElement>('.mara-line');
      const height = line ? line.getBoundingClientRect().height : msg.scrollHeight;
      if (height > threshold) next.add(Number(msg.dataset.id));
    }
    const cur = untrack(() => clippedMessages);
    if (next.size !== cur.size || [...next].some((id) => !cur.has(id))) clippedMessages = next;
  });
</script>

<div class="mara-chatview" role="log" bind:this={viewport} onscroll={onScroll}>
  <!-- Hunt status: pinned to the top of the log (sticky, zero-height, so it displaces nothing).
       A jump into un-loaded history says it's looking, and says so when it gives up — the one
       thing it must never do is sit there silently while nothing happens. -->
  {#if hunt || huntFailed}
    <div class="mara-hunt-dock">
      <div class="mara-hunt" class:failed={huntFailed} role="status">
        {#if hunt}
          Looking for that message…
        {:else}
          Couldn't find that message — it's older than the history the server keeps.
        {/if}
      </div>
    </div>
  {/if}
  <div class="mara-content" bind:this={content}>
    {#each lines as line, i (line.id)}
      {#if sessionStart > 0 && i > 0 && (lines[i - 1]?.at ?? sessionStart) < sessionStart && line.at >= sessionStart}
        <hr class="mara-sep" />
      {/if}
      <div
        class="mara-msg"
        class:clipped={clippedMessages.has(line.id) && !expandedMessages.has(line.id)}
        class:expanded={expandedMessages.has(line.id)}
        class:flashed={flashedMessage === line.id}
        data-id={line.id}
      >
        <!-- eslint-disable-next-line svelte/no-at-html-tags -- output is sanitized by chat-render -->
        {@html renderLine(toModel(line), {
          emoji,
          mentions: mentionUsers,
          layout: messageStyle,
          continuation: isContinuation(i),
          avatars: showAvatars,
        })}
        <!-- Reply affordance, revealed on hover/focus. Only a real server-side message can be
             replied to: system/away/cleared lines and PMs (no ids) carry no button. -->
        {#if onReply && line.serverId != null && (line.kind === 'chat' || line.kind === 'emote')}
          <button
            type="button"
            class="mara-reply-btn"
            title="Reply to this message"
            aria-label="Reply to this message"
            onclick={() => onReply?.(line)}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </button>
        {/if}
        {#if clippedMessages.has(line.id)}
          {@const tint = authorColorOf(line)}
          <button
            type="button"
            class="mara-expand"
            style="background:{tint};border-color:{tint};color:{contrastText(tint)}"
            onclick={() => toggleExpand(line.id)}
            aria-expanded={expandedMessages.has(line.id)}
            title={expandedMessages.has(line.id)
              ? 'Collapse this message'
              : 'Show the full message'}
          >
            <svg
              class="mara-expand-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline
                points={expandedMessages.has(line.id) ? '18 15 12 9 6 15' : '6 9 12 15 18 9'}
              />
            </svg>
            <span
              >{expandedMessages.has(line.id)
                ? pickLabel(COLLAPSE_LABELS, line.id)
                : pickLabel(EXPAND_LABELS, line.id)}</span
            >
          </button>
        {/if}
      </div>
    {/each}
    {#if lines.length === 0}
      <div class="mara-empty">No messages yet.</div>
    {/if}
  </div>
  <!-- Back button: appears once you've followed a quote bar up, and walks the chain back down
       one hop per click (sticky to the bottom of the log, displacing nothing). -->
  {#if jumpStack.length > 0}
    <div class="mara-back-dock">
      <button
        type="button"
        class="mara-back"
        onclick={jumpBack}
        title="Back to the reply you came from"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="19 12 12 19 5 12" />
        </svg>
        <span>Back to reply{jumpStack.length > 1 ? ` (${jumpStack.length})` : ''}</span>
      </button>
    </div>
  {/if}
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
  /* Zero-height sticky dock, so the pill floats over the top of the log without pushing the
     messages down (which would fight the scroll position we're in the middle of restoring). */
  .mara-hunt-dock {
    position: sticky;
    top: 0;
    z-index: 3;
    height: 0;
    display: flex;
    justify-content: center;
    /* The dock is zero-height so it displaces no messages — which means the default
       `align-items: stretch` would squash the pill to zero height too. Let it keep its own
       height and overflow the dock. */
    align-items: flex-start;
    overflow: visible;
  }
  .mara-hunt {
    font-size: 0.8rem;
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    color: var(--mara-fg, #e6e6e6);
    background: var(--mara-bg-alt, #111);
    border: 1px solid rgba(127, 127, 127, 0.4);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mara-hunt.failed {
    border-color: rgba(229, 83, 75, 0.6);
  }
  /* Back button: same zero-height sticky trick as the hunt pill, but anchored to the BOTTOM of
     the log, out of the way of the messages you jumped to. */
  .mara-back-dock {
    position: sticky;
    bottom: 0;
    z-index: 3;
    height: 0;
    display: flex;
    align-items: flex-end;
    justify-content: flex-end;
    overflow: visible;
  }
  .mara-back {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    /* Sit clear of the bottom edge; the dock has no height of its own to push off. */
    transform: translateY(-0.6rem);
    font: inherit;
    font-size: 0.8rem;
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    color: var(--mara-fg, #e6e6e6);
    background: var(--mara-bg-alt, #111);
    border: 1px solid rgba(127, 127, 127, 0.45);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    white-space: nowrap;
  }
  .mara-back:hover {
    background: var(--mara-hover, #2f2f2f);
  }
  .mara-back svg {
    width: 0.85rem;
    height: 0.85rem;
    flex: none;
  }
  /* Per-message wrapper. A very tall message is clamped to 60% of the viewport and fades out at
     the bottom, with a "Show more" toggle over the fade; expanding drops the clamp. Short
     messages are unaffected (the clamp only bites past 60vh).

     The negative margin (cancelled by equal padding) lets the hover highlight bleed out to the
     log's padding edges, so it reads as a full-width row rather than a floating bar with gaps
     either side. Layout is unchanged — the two cancel out. */
  .mara-msg {
    position: relative;
    margin: 0 -0.75rem;
    padding: 0 0.75rem;
    border-radius: 3px;
    transition: background 0.08s ease;
  }
  /* Very subtle: enough to track which row you're on (and to anchor the reply affordance that
     fades in with it), not enough to compete with the message. Neutral grey so it reads on
     both themes without needing a per-theme value. */
  .mara-msg:hover {
    background: rgba(127, 127, 127, 0.07);
  }
  .mara-msg.clipped {
    max-height: 60vh;
    overflow: hidden;
  }
  /* Highlight the message a reply's quote bar jumped to, so the eye lands on it. The accent at a
     low alpha reads on either theme without washing the text out; the inset ring picks it out
     even where the row already sits on the hover tint.

     It HOLDS at full strength for the first ~70% of its run (≈2.4s of the 3.4s) and only then
     fades out over the last second. The smooth scroll to the message eats a few hundred ms
     before you're even looking at it, so a plain fade-from-full is already half spent on
     arrival — which is why the first cut read as no flash at all. Keep the duration in sync
     with FLASH_MS in the script. */
  .mara-msg.flashed {
    border-radius: 4px;
    animation: mara-flash 3.4s ease-out;
  }
  @keyframes mara-flash {
    0%,
    70% {
      background: rgba(91, 140, 255, 0.34);
      box-shadow: inset 0 0 0 1px rgba(91, 140, 255, 0.75);
    }
    100% {
      background: transparent;
      box-shadow: inset 0 0 0 1px transparent;
    }
  }
  /* Reply affordance: a bare icon pinned to the message's top-right, revealed on hover or
     when focused (so it's reachable by keyboard without a mouse ever entering the log). */
  .mara-reply-btn {
    position: absolute;
    top: 0;
    /* 0.25rem in from the message's visual edge, plus the 0.75rem the wrapper bleeds out by. */
    right: 1rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    color: var(--mara-fg, #ddd);
    background: var(--mara-bg, #0b0b0b);
    border: 1px solid var(--mara-border, #333);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .mara-msg:hover .mara-reply-btn,
  .mara-reply-btn:focus-visible {
    opacity: 0.75;
  }
  .mara-reply-btn:hover {
    opacity: 1;
    background: var(--mara-bg-alt, rgba(127, 127, 127, 0.18));
  }
  .mara-reply-btn svg {
    width: 0.85rem;
    height: 0.85rem;
  }
  /* The quote bar a reply renders above itself (chat-render emits it as a sibling of the
     message row): a single clipped line — author, then the excerpt — that jumps to the
     quoted message on click.

     Two things keep it legible on BOTH themes. (1) Translucent neutral grey for the plate and
     the rule — like .mara-spoiler and .mara-cleared below — rather than `--mara-border`, which
     is #333 and all but invisible on the dark theme's black background. (2) Opacity is applied
     at ONE level only, on the excerpt. Dimming the bar AND the excerpt compounds (0.72 × 0.85)
     and fades the text toward the background until the quote is barely there — which is exactly
     how this first read in dark mode. */
  .mara-chatview :global(.mara-reply) {
    display: flex;
    align-items: baseline;
    gap: 0.4em;
    width: 100%;
    font: inherit;
    font-size: 0.85em;
    text-align: left;
    padding: 0.1rem 0.3rem 0.1rem 0.5rem;
    margin: 0.15rem 0 0;
    /* A faint plate, so the quote reads as a block rather than as stray dim text. */
    background: rgba(127, 127, 127, 0.12);
    border: none;
    /* The upstand that reads as "this quotes something above". */
    border-left: 2px solid rgba(127, 127, 127, 0.65);
    border-radius: 2px;
    color: var(--mara-fg, #e6e6e6);
    cursor: pointer;
  }
  .mara-chatview :global(.mara-reply:hover) {
    background: rgba(127, 127, 127, 0.24);
  }
  .mara-chatview :global(.mara-reply:hover .mara-reply-excerpt) {
    opacity: 1;
  }
  /* discord layout: indent under the avatar gutter so the quote lines up with the message's
     text column (avatar 2.4rem + 0.6rem gap), and keep the group's leading space above it. */
  .mara-chatview :global(.mara-reply-discord) {
    padding-left: 3rem;
    margin-top: 0.6rem;
    border-left: none;
  }
  .mara-chatview :global(.mara-reply-author) {
    flex: none;
    font-weight: 600;
  }
  /* One line, always: a quoted message never wraps the view open — it ellipsises. Muted a
     little against the author's name beside it — this is the bar's ONLY opacity (see above). */
  .mara-chatview :global(.mara-reply-excerpt) {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.8;
  }
  .mara-chatview :global(.mara-reply-emote) {
    font-style: italic;
  }
  .mara-msg.clipped::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4rem;
    background: linear-gradient(to bottom, transparent, var(--mara-bg, #0b0b0b));
    pointer-events: none;
  }
  /* A filled pill with a chevron, so it clearly reads as a "there's more / collapse" control.
     Its background/border/text colours are set inline per message — tinted with the author's
     own colour, with black/white text picked for contrast (see the template). The values here
     are just the fallback if that inline style is ever absent. */
  .mara-expand {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
    font: inherit;
    font-size: 0.8em;
    font-weight: 600;
    color: var(--mara-bg, #0b0b0b);
    background: var(--mara-accent, #5aa9ff);
    border: 1px solid var(--mara-accent, #5aa9ff);
    border-radius: 999px;
    padding: 0.12rem 0.7rem;
    cursor: pointer;
    opacity: 0.92;
    transition:
      opacity 0.12s ease,
      filter 0.12s ease;
  }
  .mara-expand:hover {
    opacity: 1;
    filter: brightness(1.08);
  }
  .mara-expand-icon {
    width: 1em;
    height: 1em;
    flex: none;
  }
  /* Clipped: the toggle floats centered over the fade. Expanded: it sits under the message. */
  .mara-msg.clipped .mara-expand {
    position: absolute;
    left: 50%;
    bottom: 0.5rem;
    transform: translateX(-50%);
    z-index: 1;
  }
  .mara-msg.expanded .mara-expand {
    margin: 0.2rem 0 0.35rem;
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
