<!--
  Main chat surface once connected: channel/PM tabs, message view, user list,
  input, and the overflow menu. Reads reactive client stores and translates UI
  actions back into MaraClient calls. Mounted only while a session exists, and
  remounted (fresh state) whenever the client instance changes.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { get } from 'svelte/store';
  import { ChatView, ChatInput, UserList, Lightbox } from '@mara/ui';
  import type { ChannelState, ChatLine, MaraClient, Token, UserInfo } from '@mara/client-core';
  import { connectionNotice, type NoticeState } from './lib/connectionNotice.js';
  import {
    closeNativePopout,
    focusNativePopout,
    isDesktop,
    nativeLog,
    openExternal,
    requestAttention,
    switchServer,
  } from './lib/native.js';
  import { mentionsUser } from './lib/mentions.js';
  import { runSlashCommand, type CommandContext } from './lib/commands.js';
  import {
    clearPmHistory,
    removePmConversation,
    savePmHistory,
    upsertPmConversation,
  } from './lib/pmHistory.js';
  import { openPopout, popoutBus, type PopoutBusMessage, type SoloView } from './lib/popout.js';
  import type { MaraSettings, MessageStyle, Theme } from './lib/settings.js';
  import { clientBuild, shortBuild } from './lib/version.js';
  import { getUpdateStatus, updateStatusText, type UpdateStatus } from './lib/update.js';
  import { uploadImage } from './lib/upload.js';
  import MacrosDialog from './MacrosDialog.svelte';
  import FormattingHelp from './FormattingHelp.svelte';
  import OptionsDialog from './OptionsDialog.svelte';

  let {
    client,
    settings,
    solo = null,
    onDisconnect,
    persist,
  }: {
    client: MaraClient;
    settings: MaraSettings;
    /** Pop-out mode: pin this window to one conversation (no tabs, no join UI).
     *  The main window keeps the conversation too — pop-outs are mirrors. */
    solo?: SoloView | null;
    onDisconnect: () => void;
    persist: () => void;
  } = $props();

  let showMacros = $state(false);
  let showFormatting = $state(false);
  let showOptions = $state(false);
  let menuOpen = $state(false);
  let showUsers = $state(true);
  let menuEl = $state<HTMLElement | null>(null);
  let joinOpen = $state(false);
  let joinEl = $state<HTMLElement | null>(null);
  let joinInput = $state<HTMLInputElement | null>(null);
  let tabsEl = $state<HTMLElement | null>(null);
  // The user list slides out as an overlay when it isn't shown inline (see sidebarInline).
  let usersDrawerOpen = $state(false);
  // Below this width the inline sidebar is dropped for space; the top-bar button becomes the
  // way in. Tracked reactively (a CSS media query alone can't drive the button/menu logic).
  let isNarrow = $state(false);

  // The parent remounts ChatApp when `client` changes (keyed by {#if client}),
  // so capturing the (stable) stores once is correct.
  // svelte-ignore state_referenced_locally
  const {
    connection,
    self,
    users,
    directory,
    channels,
    channelMessages,
    hasMoreHistory,
    privateMessages,
    serverInfo,
    motd,
    emoji,
  } = client;

  // The page is stale when the server reports serving a different web build than
  // the one this bundle was compiled as — i.e. the browser is running cached old
  // code and should be reloaded. Silent when the server doesn't report a build
  // (an older server). Gated to production builds: the Vite dev server (:5173)
  // serves a freshly-compiled bundle whose id never matches the server's committed
  // dist/version.json, so in dev this would ALWAYS read stale — a false alarm (HMR
  // already keeps dev current). `import.meta.env.PROD` is false under the dev server
  // and true in a `vite build` bundle (what the server and desktop clients serve).
  const stale = $derived(
    import.meta.env.PROD && !!$serverInfo?.webBuild && $serverInfo.webBuild !== clientBuild.buildId,
  );

  // Auto-refresh a stale page to pick up the newer build the server is serving.
  // Opt-out via the "Auto-refresh when out of date" option (on by default). Guarded
  // against a reload loop the same way onProtocolMismatch is: if a caching layer
  // keeps handing back the old bundle, reloading would just come back stale, so only
  // auto-reload once per window and otherwise leave the manual "Outdated — reload"
  // button. Never fires in dev (stale is PROD-gated above).
  const STALE_RELOAD_KEY = 'mara:stale-reload';
  $effect(() => {
    if (!stale || !settings.autoRefresh || typeof window === 'undefined') return;
    try {
      const last = Number(sessionStorage.getItem(STALE_RELOAD_KEY) || '0');
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
        location.reload();
      }
    } catch {
      /* sessionStorage blocked — the manual button still covers it */
    }
  });

  // Once connected, show the server's name in the browser tab; restore the original
  // title (e.g. "Mara 3") when the session ends. A leading "* " flags unread messages
  // in any channel or PM, so a backgrounded tab shows activity at a glance. A pop-out
  // is titled by its conversation, and only ever shows that conversation, so the
  // whole-session unread star would mislead there — skip it.
  const baseTitle = typeof document !== 'undefined' ? document.title : '';
  $effect(() => {
    if (typeof document === 'undefined') return;
    const server = $serverInfo?.name ?? baseTitle;
    const t = solo ? `${title} · ${server}` : server;
    document.title = !solo && unreadChannels.size + unreadPms.size > 0 ? `* ${t}` : t;
  });
  onDestroy(() => {
    if (typeof document !== 'undefined') document.title = baseTitle;
  });

  // Desktop-only: the result of the launch update check (shared/memoized with the
  // UpdateBanner), shown in the menu so the user can see a check ran and its outcome.
  let updateStatus = $state<UpdateStatus | null>(null);
  onMount(async () => {
    if (isDesktop()) updateStatus = await getUpdateStatus();
  });

  // Persist the set of channel names the user is in, so a fresh session rejoins them
  // (the client seeds these via initialChannels). Keyed on the sorted name set so
  // member-only changes — which also bump the channels store — don't thrash storage.
  // svelte-ignore state_referenced_locally
  let persistedChannelKey = settings.channels.slice().sort().join('\n');
  const unsubChannels = channels.subscribe((map) => {
    const names = [...map.values()].map((c) => c.name).sort();
    const key = names.join('\n');
    if (key === persistedChannelKey) return;
    persistedChannelKey = key;
    settings.channels = names;
    persist();
  });
  onDestroy(unsubChannels);

  // Mirror the open PM conversations to device-local storage so a refresh restores
  // them (the server never stores PMs — see lib/pmHistory.ts). The main window
  // persists the whole set — its tabs plus conversations away in pop-outs, in tab
  // order — while a PM pop-out merges in just its own conversation (so lines it
  // received while no main window was around still survive a refresh). A channel
  // pop-out writes nothing. Debounced so a burst of lines lands as one write.
  // Rebuilds when the option toggles; closePm handles its own removal.
  $effect(() => {
    if (!settings.keepPmHistory || solo?.kind === 'channel') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = privateMessages.subscribe((map) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        const dir = get(directory);
        const snapshot = (peer: Token, lines: ChatLine[]) => {
          const info = dir.get(peer);
          return {
            peer,
            lines,
            name: info?.name ?? `#${peer}`,
            color: info?.color ?? '#888888',
          };
        };
        if (solo?.kind === 'pm') {
          const lines = map.get(solo.peer) ?? [];
          if (lines.length > 0)
            upsertPmConversation(settings.identityKey, snapshot(solo.peer, lines));
          return;
        }
        const open = [...pmTabs, ...[...poppedOutPms].filter((p) => !pmTabs.includes(p))];
        const conversations = open
          .map((peer) => snapshot(peer, map.get(peer) ?? []))
          .filter((c) => c.lines.length > 0);
        savePmHistory(settings.identityKey, conversations);
      }, 300);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsub();
    };
  });

  // Active view: a channel token, a private-message peer token, or neither
  // (placeholder). Mutually exclusive — at most one is non-null at a time;
  // every selector below nulls the other to preserve that invariant, which the
  // title/baseLines deriveds rely on to pick which conversation to show.
  let activeChannel = $state<Token | null>(null);
  // A solo PM window is born pinned to its peer (also keeps rejoining channels
  // from stealing the view before any PM line arrives).
  // svelte-ignore state_referenced_locally
  let activePm = $state<Token | null>(solo?.kind === 'pm' ? solo.peer : null);
  // Name of a channel the user just asked to join (via the + popover) and wants
  // focused once it lands — distinguishes a deliberate join from the channels we
  // silently rejoin on a fresh session.
  let pendingFocusJoin = $state<string | null>(null);
  // Open PM conversations, in tab order. This is the source of truth for which
  // PM tabs exist — so opening a conversation shows a real tab immediately,
  // before any message is sent. Seeded from any history present at mount.
  // svelte-ignore state_referenced_locally
  let pmTabs = $state<Token[]>([...get(privateMessages).keys()] as Token[]);
  let joinName = $state('');
  // Conversations with unread messages (reassigned, not mutated, for reactivity).
  let unreadChannels = $state(new Set<Token>());
  let unreadPms = $state(new Set<Token>());
  // PM conversations currently owned by a pop-out window (move semantics): their
  // tabs are hidden here and incoming messages stay quiet until the pop-out
  // closes. Maintained over the popout bus (see lib/popout.ts) — and re-learned
  // on mount via a query, so reloading this window re-hides popped-out tabs.
  let poppedOutPms = $state(new Set<Token>());
  // Pending are-you-alive checks per peer: if a pop-out doesn't answer before the
  // timeout, this window adopts the conversation back (see the privateMessage handler).
  const popoutChecks = new Map<Token, ReturnType<typeof setTimeout>>();
  let popoutPost: ((m: PopoutBusMessage) => void) | null = null;

  // Main-window side of the popout bus.
  $effect(() => {
    if (solo) return;
    const bus = popoutBus((m) => {
      if (m.type === 'pm-open') {
        const check = popoutChecks.get(m.peer);
        if (check !== undefined) {
          clearTimeout(check);
          popoutChecks.delete(m.peer);
        }
        if (!poppedOutPms.has(m.peer)) poppedOutPms = new Set(poppedOutPms).add(m.peer);
        hidePmTab(m.peer);
      } else if (m.type === 'pm-closed' && poppedOutPms.has(m.peer)) {
        const next = new Set(poppedOutPms);
        next.delete(m.peer);
        poppedOutPms = next;
        // The conversation moves back as a tab — unless PMs live in windows, in
        // which case closing the window closes the conversation (a later message
        // simply opens a fresh window).
        if (!settings.pmsInWindows) addPmTab(m.peer);
      }
    });
    popoutPost = bus?.post ?? null;
    // Learn about pop-outs that already exist (this window just loaded/reloaded).
    bus?.post({ type: 'pm-query' });
    return () => {
      popoutPost = null;
      for (const t of popoutChecks.values()) clearTimeout(t);
      popoutChecks.clear();
      bus?.close();
    };
  });

  // Pop-out side: announce ownership on start and in answer to queries, and hand
  // the conversation back on the way out (pagehide covers the window closing;
  // the effect teardown covers in-app unmounts).
  $effect(() => {
    if (solo?.kind !== 'pm') return;
    const peer = solo.peer;
    let respond: ((m: PopoutBusMessage) => void) | null = null;
    const bus = popoutBus((m) => {
      if (m.type === 'pm-query' && (m.peer === undefined || m.peer === peer))
        respond?.({ type: 'pm-open', peer });
      if (m.type === 'pm-focus' && m.peer === peer) {
        window.focus();
        void focusNativePopout(); // desktop shells: raise the native window
      }
    });
    respond = bus?.post ?? null;
    bus?.post({ type: 'pm-open', peer });
    let said = false;
    const goodbye = () => {
      if (!said) bus?.post({ type: 'pm-closed', peer });
      said = true;
    };
    window.addEventListener('pagehide', goodbye);
    return () => {
      goodbye();
      window.removeEventListener('pagehide', goodbye);
      bus?.close();
    };
  });

  function markChannelUnread(token: Token, from: Token) {
    // Our own message — the server's echo of what we just sent, or the mirror from
    // another window/device on this identity — is not "unread" (same rule as PMs).
    if (from === get(self)?.token) return;
    // "Looking at it" requires the channel active, no PM in front of it, AND the
    // window actually focused — a backgrounded window sees nothing, so activity in
    // the conversation you're parked on still stars the title until you come back.
    if (activeChannel === token && activePm === null && document.hasFocus()) return;
    if (!unreadChannels.has(token)) unreadChannels = new Set(unreadChannels).add(token);
  }
  function markPmUnread(token: Token) {
    if (activePm === token && document.hasFocus()) return;
    if (!unreadPms.has(token)) unreadPms = new Set(unreadPms).add(token);
  }

  // Coming back to the window means the active conversation is now actually seen:
  // clear any unread mark it collected while we were backgrounded, so the title
  // star (and the tab badge, if the user switched conversations first) lets go.
  $effect(() => {
    const onFocus = () => {
      if (activePm !== null) unreadPms = clearUnread(unreadPms, activePm);
      else if (activeChannel !== null) unreadChannels = clearUnread(unreadChannels, activeChannel);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });
  // A channel message: badge the tab, and treat an @mention of our name like a
  // PM — flash the taskbar/dock when this window is in the background, so being
  // called out in a channel is noticed like a direct message. Your own echoed
  // messages never page you, and a pop-out only reacts to mentions in its own
  // pinned conversation (the main window listens everywhere).
  function onChannelMessage(m: { from: Token; channelToken: Token; text: string }) {
    markChannelUnread(m.channelToken, m.from);
    const me = get(self);
    if (!me || m.from === me.token) return;
    if (solo && !(solo.kind === 'channel' && activeChannel === m.channelToken)) return;
    if (mentionsUser(m.text, me.name) && !document.hasFocus()) void requestAttention();
  }

  // Copy-on-write: return a new Set so $state sees a fresh reference and
  // re-renders; return the original unchanged when there's nothing to clear.
  function clearUnread(set: Set<Token>, token: Token): Set<Token> {
    if (!set.has(token)) return set;
    const next = new Set(set);
    next.delete(token);
    return next;
  }

  // Connection drop/recover notices, shown inline in every conversation.
  let connectionLines = $state<ChatLine[]>([]);
  let sysSeq = 0;
  // This session's connect time; ChatView rules off the backlog/session boundary.
  let sessionStart = $state(0);
  const noticeState: NoticeState = { dropAnnounced: false };

  function pushSystem(text: string, kind: 'system' | 'notice' = 'system') {
    // Negative, decreasing ids keep system lines distinct from server message ids
    // (which are non-negative) and stably ordered among themselves. Cap at the
    // last 50 so a long flaky session doesn't grow this unbounded.
    // Stamp on the server-clock estimate so these notices interleave with chat (server
    // time) consistently, even when the local machine clock is skewed.
    const line: ChatLine = { id: --sysSeq, kind, from: null, text, at: client.serverNow() };
    connectionLines = [...connectionLines, line].slice(-50);
  }

  // Announce the connection once it's established, naming the server (carried in the
  // welcome payload). Fires a single time per session; reconnects are covered by the
  // drop/reconnect notices in the statusChanged handler below.
  let connectAnnounced = false;
  // Pop-outs open quiet: no connect announcement and no MOTD — the main window
  // already shows both, and a pinned conversation shouldn't start with noise.
  // (Drop/reconnect notices still show; a dead pop-out must say so.)
  // svelte-ignore state_referenced_locally
  let motdShown = solo !== null;
  $effect(() => {
    if ($serverInfo && !connectAnnounced) {
      connectAnnounced = true;
      // Mark where the backlog ends and this session begins (ChatView draws a rule
      // at the boundary). Captured before the first notice so all session lines
      // (Connected/joined/MOTD/live) sort at or after it. Not in pop-outs: they
      // open mid-session, so the boundary would draw a meaningless rule right
      // under whatever restored lines the window opened with (0 disables it).
      if (!solo) {
        sessionStart = client.serverNow();
        pushSystem(`Connected to ${$serverInfo.name}.`);
      }
      // The MOTD is pushed later, on the first channel join, so it reads
      // Connected → joined → MOTD.
    }
  });

  // The identity's others-visible profile (name + colour) is owned by the server, so
  // adopt whatever it hands back — a name dedupe, another client's edit to this shared
  // identity, or the profile a fresh device inherits on login — into local settings, so
  // this device stays in step (and the options/login fields show the real values).
  function syncProfile(name?: string, color?: string) {
    let changed = false;
    if (name && name !== settings.name) {
      settings.name = name;
      changed = true;
    }
    if (color && color !== settings.color) {
      settings.color = color;
      changed = true;
    }
    if (changed) persist();
  }

  // Subscribe to client events for the life of the component. Each `.on` returns
  // an unsubscribe fn; the cleanup runs them all so handlers don't leak or fire
  // against a stale closure if the effect re-runs.
  $effect(() => {
    const offs = [
      // Reconcile local settings with the server-owned identity profile: on login the
      // canonical name arrives via `connected` (colour rides in the roster), and any
      // later change to this identity — here or on another client — via `userProfile`.
      client.events.on('connected', ({ token, name }) =>
        syncProfile(name, get(users).get(token)?.color),
      ),
      client.events.on('userProfile', (u) => {
        if (u.token === get(self)?.token) syncProfile(u.name, u.color);
      }),
      client.events.on('channelJoined', (ch) => {
        // Focus the channel when the user deliberately joined it (via +) or when it's
        // the first view of the session — the server's default channel, which joins
        // first on connect. The other channels we silently rejoin on a fresh session
        // stay background tabs, so a returning user lands on the main channel.
        // A solo window focuses exactly its own channel (also re-pinning after a
        // reconnect's token churn) and lets everything else pass by.
        if (solo) {
          if (solo.kind === 'channel' && ch.name === solo.name) {
            activeChannel = ch.token;
            activePm = null;
          }
        } else if (ch.name === pendingFocusJoin || (activeChannel === null && activePm === null)) {
          activeChannel = ch.token;
          activePm = null;
        }
        if (ch.name === pendingFocusJoin) pendingFocusJoin = null;
        // Show the MOTD once, after the first "You joined" line (which the server
        // adds to the channel log), so the connect sequence reads Connected →
        // joined → MOTD. Markdown notice at default text colour.
        if (!motdShown) {
          const text = $motd.trim();
          if (text) {
            motdShown = true;
            pushSystem(text, 'notice');
          }
        }
      }),
      client.events.on('channelLeft', (ev) => {
        if (solo) {
          // The conversation this window exists for is gone — close the pop-out.
          // ('replaced' is reconnect token churn; the rejoin re-pins the view.)
          if (solo.kind === 'channel' && ev.name === solo.name && ev.reason === 'left') {
            window.close();
            void closeNativePopout(); // desktop shells: window.close() is a webview no-op
            // If the browser refused (e.g. a hand-opened tab), say why the view died.
            pushSystem(`You left #${ev.name} — this window can be closed.`);
          }
          return;
        }
        if (activeChannel === ev.channelToken) {
          // Fall back to another channel we're still in, rather than an empty view.
          activeChannel = [...$channels.keys()].find((t) => t !== ev.channelToken) ?? null;
        }
      }),
      client.events.on('privateMessage', (pm) => {
        // The normal arrival: a tab, an unread badge, and (desktop) an attention
        // flash. Auto-focus only when nothing is open yet, so an incoming PM never
        // yanks the user out of their current view. (Never focus in a pop-out —
        // its view is pinned.)
        const arriveAsTab = () => {
          addPmTab(pm.from);
          if (!solo && activePm === null && activeChannel === null) activePm = pm.from;
          markPmUnread(pm.from);
          if (!document.hasFocus()) void requestAttention();
        };
        // A pop-out owns this conversation — stay quiet here (no tab, no badge,
        // no attention flash; the pop-out does all that). But confirm it's still
        // alive: if it doesn't answer the query in time (crashed without a
        // goodbye), adopt the conversation back so the message isn't stranded.
        if (!solo && poppedOutPms.has(pm.from)) {
          popoutPost?.({ type: 'pm-query', peer: pm.from });
          if (!popoutChecks.has(pm.from)) {
            popoutChecks.set(
              pm.from,
              setTimeout(() => {
                popoutChecks.delete(pm.from);
                const next = new Set(poppedOutPms);
                next.delete(pm.from);
                poppedOutPms = next;
                // Adopt the conversation back the way the user prefers it: a
                // fresh window when PMs live in windows (refused → tab), else a tab.
                if (settings.pmsInWindows && settings.keepPmHistory) {
                  void popOutPm(pm.from).then((opened) => {
                    if (!opened) {
                      addPmTab(pm.from);
                      markPmUnread(pm.from);
                    }
                  });
                  return;
                }
                addPmTab(pm.from);
                markPmUnread(pm.from);
              }, 2500),
            );
          }
          return;
        }
        // "PMs in windows": a new conversation opens as a pop-out. Only with
        // device-local history on — the pop-out hydrates the triggering message
        // from storage (there's no server backlog), so without it the first
        // message would render nowhere. Open refused → tab.
        if (!solo && settings.pmsInWindows && settings.keepPmHistory) {
          void popOutPm(pm.from).then((opened) => {
            if (!opened) arriveAsTab();
          });
          return;
        }
        arriveAsTab();
      }),
      client.events.on('privateMessageSent', (pm) => {
        // Fires for our own sent PM — including the copy the server mirrors to our other
        // windows/devices. Surface the thread here too so linked clients converge on the
        // same conversation list (no unread badge: it's our own message). Unless a
        // pop-out owns the conversation — the mirror of a message sent *from* that
        // pop-out must not resurrect the tab here.
        if (!solo && poppedOutPms.has(pm.to)) return;
        addPmTab(pm.to);
      }),
      // Only real messages badge a tab — joins/leaves/away and other system lines
      // arrive as their own event types and deliberately don't mark anything unread.
      client.events.on('chat', onChannelMessage),
      client.events.on('emote', onChannelMessage),
      client.events.on('statusChanged', (status) => {
        const notice = connectionNotice(status, noticeState);
        if (notice) pushSystem(notice);
      }),
    ];
    return () => offs.forEach((off) => off());
  });

  // Desktop shell only: mirror connection + chat activity to the local log file.
  // Channel names we've already logged our own join for this session — the server can
  // send channelJoined twice for one channel (our explicit rejoin + its default
  // auto-join), so dedupe by name like client-core's own "You joined" guard does.
  const loggedJoins = new Set<string>();
  $effect(() => {
    // Solo windows skip logging — the main window already logs everything, and
    // two writers would double every line.
    if (!isDesktop() || solo) return;
    // Log files are split per channel by its (human-readable) name, falling back to the
    // numeric token if the channel isn't in the store yet.
    const channelFolder = (token: Token): string =>
      $channels.get(token)?.name ?? `channel-${token}`;
    // System notices (connect/status) aren't tied to one channel, so mirror them into
    // every channel log that's currently open rather than a separate file.
    const logToAllChannels = (line: string) => {
      for (const c of $channels.values()) void nativeLog(c.name, line);
    };
    const offs = [
      client.events.on('connected', (i) => logToAllChannels(`connected as ${i.name}`)),
      client.events.on('statusChanged', (s) => logToAllChannels(`status: ${s}`)),
      // Membership changes, by name (matching what the chat view shows). Our own join
      // arrives as channelJoined (deduped); others arrive as userJoinedChannel /
      // userLeftChannel, and a disconnect as userDisconnect (per channel they were in).
      client.events.on('channelJoined', (ch) => {
        if (loggedJoins.has(ch.name)) return;
        loggedJoins.add(ch.name);
        void nativeLog(ch.name, `${$self?.name ?? 'You'} joined`);
      }),
      client.events.on('channelLeft', (e) => {
        // Only a real departure — skip the 'replaced' token-churn on reconnect.
        if (e.reason !== 'left') return;
        loggedJoins.delete(e.name); // a later rejoin should log again
        void nativeLog(e.name, `${$self?.name ?? 'You'} left`);
      }),
      client.events.on(
        'userJoinedChannel',
        (e) => void nativeLog(channelFolder(e.channelToken), `${nameOf(e.token)} joined`),
      ),
      client.events.on(
        'userLeftChannel',
        (e) => void nativeLog(channelFolder(e.channelToken), `${nameOf(e.token)} left`),
      ),
      client.events.on('userDisconnect', (e) => {
        for (const token of e.channelTokens) {
          void nativeLog(channelFolder(token), `${nameOf(e.token)} disconnected`);
        }
      }),
      client.events.on('away', (e) => {
        // Mirror the channel announcement to each channel the user shares.
        const line = e.text
          ? `${nameOf(e.token)} is away (${e.text})`
          : `${nameOf(e.token)} is back.`;
        for (const c of $channels.values()) {
          if (c.members.has(e.token)) void nativeLog(c.name, line);
        }
      }),
      client.events.on(
        'chat',
        (m) => void nativeLog(channelFolder(m.channelToken), `<${nameOf(m.from)}> ${m.text}`),
      ),
      client.events.on(
        'emote',
        (m) => void nativeLog(channelFolder(m.channelToken), `* ${nameOf(m.from)} ${m.text}`),
      ),
      client.events.on(
        'privateMessage',
        (m) => void nativeLog(`pm-${nameOf(m.from)}`, `<${nameOf(m.from)}> ${m.text}`),
      ),
      // Log our own outgoing PMs (the sending window's local echo, and the copy the
      // server mirrors to our other windows) under the recipient, so both sides of a PM
      // thread share one log — matching the incoming line above.
      client.events.on(
        'privateMessageSent',
        (m) => void nativeLog(`pm-${nameOf(m.to)}`, `<${$self?.name ?? 'You'}> ${m.text}`),
      ),
    ];
    return () => offs.forEach((off) => off());
  });

  // Open external links ourselves so they work everywhere. Chat links carry no
  // target="_blank" (see chat-render), so a plain click would otherwise navigate the app
  // window away; here we route it to the native opener in the desktop shells (the Tauri 2
  // client blocks _blank new windows, so links did nothing there) or a new browser tab.
  // Images are skipped — a click there opens the in-app lightbox (see ChatView). Modifier
  // and middle clicks fall through so "open in new tab" still works in a browser.
  $effect(() => {
    const onLinkClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest('a[href]') as HTMLAnchorElement | null;
      if (!a || a.closest('.mara-img-box')) return;
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return;
      e.preventDefault();
      void openExternal(a.href);
    };
    document.addEventListener('click', onLinkClick);
    return () => document.removeEventListener('click', onLinkClick);
  });

  // Close the menu on any click outside it.
  $effect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuEl && !menuEl.contains(e.target as Node)) menuOpen = false;
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  });

  // Join-channel popover: focus its input, close on outside click.
  $effect(() => {
    if (!joinOpen) return;
    joinInput?.focus();
    const onDoc = (e: MouseEvent) => {
      if (joinEl && !joinEl.contains(e.target as Node)) joinOpen = false;
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  });

  const channelList = $derived([...$channels.values()] as ChannelState[]);
  const pmPeers = $derived(pmTabs);
  // Channels are a light-touch feature: only show the switcher when there's more
  // than one conversation (e.g. you've joined another channel or opened a DM).
  const showTabs = $derived(!solo && channelList.length + pmPeers.length > 1);
  const title = $derived(
    activePm !== null
      ? `@${nameOf(activePm)}`
      : activeChannel !== null
        ? `#${$channels.get(activeChannel)?.name ?? ''}`
        : 'Mara 3',
  );
  // Identity of the active conversation (type-tagged so a channel and a PM with the same
  // numeric token stay distinct). Drives the chat input's refocus on join/switch.
  const activeKey = $derived(
    activePm !== null ? `pm:${activePm}` : activeChannel !== null ? `ch:${activeChannel}` : null,
  );

  // The inline sidebar shows only for a channel, when kept on, and when there's room. When it
  // isn't inline (narrow screen, or hidden by choice) offer the top-bar button that slides the
  // list out as a drawer instead. A PM has no member list, so neither applies there.
  const sidebarInline = $derived(activeChannel !== null && showUsers && !isNarrow);
  const usersButtonVisible = $derived(activeChannel !== null && !sidebarInline);

  // Track the narrow breakpoint (keep the 640px in sync with the CSS below).
  $effect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const apply = () => (isNarrow = mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  });

  // The drawer only makes sense over a channel; drop it when the view leaves one (opening a
  // PM from it, or leaving the channel) so it can't linger or reopen on the next channel.
  $effect(() => {
    if (activeChannel === null) usersDrawerOpen = false;
  });

  // Close the drawer on Escape while it's open.
  $effect(() => {
    if (!usersDrawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') usersDrawerOpen = false;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Keep the active tab scrolled into view within the horizontally-scrolling strip, so
  // switching to (or joining) a channel whose tab sits off-screen brings it into view.
  $effect(() => {
    activeKey; // re-run on conversation switch
    tabsEl?.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  function membersOf(token: Token): UserInfo[] {
    const channel = $channels.get(token);
    if (!channel) return [];
    return [...channel.members]
      .map((t) => $users.get(t))
      .filter((u): u is UserInfo => u !== undefined);
  }

  function nameOf(token: Token): string {
    // Directory keeps names of people who have since left, so labels don't
    // degrade to a raw token when someone disconnects.
    return $directory.get(token)?.name ?? `#${token}`;
  }

  function openChannel(token: Token) {
    activeChannel = token;
    activePm = null;
    unreadChannels = clearUnread(unreadChannels, token);
  }

  function addPmTab(token: Token) {
    if (!pmTabs.includes(token)) pmTabs = [...pmTabs, token];
  }

  /** Open a PM as a tab in this window and focus it (the non-pop-out path). */
  function openPmTab(token: Token) {
    addPmTab(token);
    activePm = token;
    activeChannel = null;
    unreadPms = clearUnread(unreadPms, token);
  }

  function selectPm(token: Token) {
    // The conversation lives in a pop-out — nudge that window to the front
    // instead (deliberately opening it from the user list or /msg must not
    // resurrect a tab here, and must not reload the pop-out via window.open).
    if (!solo && poppedOutPms.has(token)) {
      popoutPost?.({ type: 'pm-focus', peer: token });
      return;
    }
    // "PMs in windows": deliberate opens go straight to a pop-out (this click is
    // the user gesture popup blockers want). Refused → fall back to a tab.
    if (!solo && settings.pmsInWindows) {
      void popOutPm(token).then((opened) => {
        if (!opened) openPmTab(token);
      });
      return;
    }
    openPmTab(token);
  }

  function openPm(user: UserInfo) {
    selectPm(user.token);
  }

  /** Take a PM tab out of the bar (view falls back if it was active) without
   *  forgetting the conversation — used when it moves to a pop-out window. */
  function hidePmTab(token: Token) {
    const wasActive = activePm === token;
    pmTabs = pmTabs.filter((t) => t !== token);
    unreadPms = clearUnread(unreadPms, token);
    if (!wasActive) return;
    // Fall back to another open PM, else a channel, else the empty placeholder.
    activePm = null;
    const nextPm = pmTabs[pmTabs.length - 1];
    if (nextPm !== undefined) selectPm(nextPm);
    else {
      const ch = [...$channels.keys()][0];
      if (ch !== undefined) openChannel(ch);
    }
  }

  function closePm(token: Token) {
    // Closing the tab also forgets the conversation on this device (in-memory
    // history survives for this session — a reopened tab still shows it).
    removePmConversation(settings.identityKey, token);
    hidePmTab(token);
  }

  // Pop out a PM: the conversation MOVES — this window hands it to the pop-out
  // (tab hidden, no badges) until that window closes. Resolves false when the
  // open was refused (popup blocker, or a desktop shell too old for pop-outs),
  // so callers can fall back to a tab instead of handing the conversation to a
  // window that doesn't exist.
  async function popOutPm(peer: Token): Promise<boolean> {
    // Flush this conversation to device storage NOW, not on the debounce: the new
    // window hydrates from storage as it loads, and it can win a race against a
    // 300ms timer — losing the very message that opened it.
    if (settings.keepPmHistory) {
      const lines = get(privateMessages).get(peer) ?? [];
      if (lines.length > 0) {
        const info = get(directory).get(peer);
        upsertPmConversation(settings.identityKey, {
          peer,
          lines,
          name: info?.name ?? `#${peer}`,
          color: info?.color ?? '#888888',
        });
      }
    }
    if (!(await openPopout({ kind: 'pm', peer }))) return false;
    if (!poppedOutPms.has(peer)) poppedOutPms = new Set(poppedOutPms).add(peer);
    hidePmTab(peer);
    return true;
  }

  // Apply in-session options: broadcast a name/colour change (server dedupes + tells
  // everyone via userProfile, which updates our own roster/self), apply the theme via
  // the shared settings (App's $effect re-applies it), and persist.
  function applyOptions(next: {
    name: string;
    color: string;
    theme: Theme;
    keepPmHistory: boolean;
    pmsInWindows: boolean;
    autoRefresh: boolean;
    messageStyle: MessageStyle;
  }) {
    const newName = next.name.trim();
    const update: { name?: string; color?: string } = {};
    if (newName && newName !== settings.name) update.name = newName;
    if (next.color !== settings.color) update.color = next.color;
    if (update.name || update.color) client.setProfile(update);
    if (newName) settings.name = newName;
    settings.color = next.color;
    settings.theme = next.theme;
    // Turning PM history off forgets what this device already stored, not just
    // future writes — that's what a user unchecking a privacy option expects.
    if (!next.keepPmHistory && settings.keepPmHistory) clearPmHistory();
    settings.keepPmHistory = next.keepPmHistory;
    settings.pmsInWindows = next.pmsInWindows;
    settings.autoRefresh = next.autoRefresh;
    settings.messageStyle = next.messageStyle;
    persist();
  }

  function join() {
    const name = joinName.trim();
    if (!name) return;
    pendingFocusJoin = name; // a deliberate join: focus it once the server confirms
    client.joinChannel(name);
    joinName = '';
    joinOpen = false;
  }

  function leaveActive() {
    if (activeChannel !== null) client.leaveChannel(activeChannel);
    menuOpen = false;
  }

  // Desktop only: return to the native server picker. If the current server's
  // origin isn't IPC-allowed the invoke throws — note it inline rather than
  // failing silently.
  async function onSwitchServer() {
    menuOpen = false;
    try {
      await switchServer();
    } catch {
      pushSystem(
        'Switch server is unavailable for this server (its origin is not allowed by the desktop client).',
      );
    }
  }

  // Capabilities the slash commands act through (see lib/commands.ts). Built per-send so
  // it captures the current active conversation.
  function commandCtx(): CommandContext {
    return {
      activeChannel,
      resolveUser: (name) => {
        const lower = name.toLowerCase();
        for (const u of $users.values()) if (u.name.toLowerCase() === lower) return u;
        return null;
      },
      emote: (t) => {
        if (activeChannel !== null) client.sendEmote(activeChannel, t);
      },
      privateMessage: (token, t) => {
        // Send before focusing: selectPm may pop the conversation out into a new
        // window, which snapshots the store on the way — the sent line (pushed
        // locally by sendPrivateMessage) must already be in it.
        client.sendPrivateMessage(token, t);
        selectPm(token);
      },
      joinChannel: (name) => {
        // Already a member (case-insensitively)? Focus the existing tab rather than
        // asking the server for a channel that differs only in case.
        for (const c of $channels.values())
          if (c.name.toLowerCase() === name.toLowerCase()) return openChannel(c.token);
        pendingFocusJoin = name; // a deliberate join: focus it once the server confirms
        client.joinChannel(name);
      },
      leaveChannel: (name) => {
        if (name === null) {
          if (activeChannel !== null) client.leaveChannel(activeChannel);
          return;
        }
        for (const c of $channels.values())
          if (c.name.toLowerCase() === name.toLowerCase()) return client.leaveChannel(c.token);
        pushSystem(`/leave: you're not in #${name}.`);
      },
      setAway: (t) => client.sendAway(t),
      setName: (name) => {
        client.setProfile({ name });
        settings.name = name; // optimistic; the server's userProfile broadcast confirms it
        persist();
      },
      notice: (t) => pushSystem(t),
      random: Math.random,
    };
  }

  function handleSend(text: string) {
    // Slash commands run in any conversation; any leading `/` is handled (an unrecognised
    // one shows an error and isn't sent, so typos don't leak as messages).
    if (runSlashCommand(text, commandCtx())) return;
    if (activePm !== null) client.sendPrivateMessage(activePm, text);
    else if (activeChannel !== null) client.sendChat(activeChannel, text);
  }

  const baseLines = $derived(
    activePm !== null
      ? ($privateMessages.get(activePm) ?? [])
      : activeChannel !== null
        ? ($channelMessages.get(activeChannel) ?? [])
        : [],
  );

  // Interleave the global connection notices into the conversation WITHOUT disturbing
  // its order. baseLines is already chronological (backlog sorted by server time, then
  // live messages in arrival order), so we must not re-sort it by `at`: client-generated
  // lines like "You joined" carry local machine time while chat carries server time, and
  // sorting across those two clocks can float a just-typed message above the join line.
  // Instead, keep baseLines as-is and splice each notice in by timestamp (connectionLines
  // are already in push/time order). At an equal timestamp the conversation line wins, so
  // "You joined" still precedes a MOTD notice stamped the same instant.
  const activeLines = $derived.by(() => {
    // Session notices (Connected/drop/reconnect) belong in every conversation, but the MOTD
    // (a server 'notice') is a channel greeting — don't surface it in a PM thread.
    const notices =
      activePm !== null ? connectionLines.filter((l) => l.kind !== 'notice') : connectionLines;
    if (notices.length === 0) return baseLines;
    const out: ChatLine[] = [];
    let i = 0;
    for (const line of baseLines) {
      let notice = notices[i];
      while (notice && notice.at < line.at) {
        out.push(notice);
        notice = notices[++i];
      }
      out.push(line);
    }
    if (i < notices.length) out.push(...notices.slice(i));
    return out;
  });
</script>

<div class="app">
  <header class="topbar">
    <div class="convos">
      {#if showTabs}
        <nav class="tabs" bind:this={tabsEl}>
          {#each channelList as channel (channel.token)}
            <button
              class:active={activePm === null && activeChannel === channel.token}
              class:unread={unreadChannels.has(channel.token)}
              onclick={(e) =>
                e.shiftKey
                  ? openPopout({ kind: 'channel', name: channel.name })
                  : openChannel(channel.token)}
              onmousedown={(e) => {
                // Middle-click leaves the channel (and suppress the autoscroll cursor).
                if (e.button === 1) {
                  e.preventDefault();
                  client.leaveChannel(channel.token);
                }
              }}
              title="#{channel.name} — middle-click to leave, shift-click to pop out"
            >
              #{channel.name}
            </button>
          {/each}
          {#if channelList.length > 0 && pmPeers.length > 0}
            <span class="tabsep" aria-hidden="true"></span>
          {/if}
          {#each pmPeers as peer (peer)}
            <span
              class="pmtab"
              class:active={activeChannel === null && activePm === peer}
              class:unread={unreadPms.has(peer)}
            >
              <button
                class="tab-main"
                onclick={(e) => (e.shiftKey ? popOutPm(peer) : selectPm(peer))}
                onmousedown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closePm(peer);
                  }
                }}
                title="@{nameOf(peer)} — middle-click to close, shift-click to pop out"
                >@{nameOf(peer)}</button
              >
              <button
                class="tab-x"
                onclick={() => closePm(peer)}
                aria-label="Close conversation with {nameOf(peer)}"
                title="Close conversation">×</button
              >
            </span>
          {/each}
        </nav>
      {:else}
        <div class="title">{title}</div>
      {/if}

      {#if !solo}
        <div class="join-wrap" bind:this={joinEl}>
          <button
            class="addbtn"
            aria-label="Join a channel"
            aria-expanded={joinOpen}
            onclick={() => (joinOpen = !joinOpen)}>+</button
          >
          {#if joinOpen}
            <form class="join-pop" onsubmit={(e) => (e.preventDefault(), join())}>
              <input
                bind:this={joinInput}
                bind:value={joinName}
                placeholder="channel name"
                aria-label="Channel name"
                onkeydown={(e) => {
                  if (e.key === 'Escape') joinOpen = false;
                }}
              />
              <button type="submit">Join</button>
            </form>
          {/if}
        </div>
      {/if}
    </div>

    <div class="actions">
      {#if stale}
        <button
          class="stale"
          title={`This page is running an old build (${shortBuild(clientBuild.buildId)}). The server has a newer one — click to reload.`}
          onclick={() => location.reload()}
        >
          ⚠ Outdated — reload
        </button>
      {/if}
      <span
        class="dot"
        data-state={$connection}
        title={`${$connection}${$self ? ` · ${$self.name}` : ''}`}
      ></span>
      {#if usersButtonVisible}
        <button
          class="iconbtn users-toggle"
          aria-label={usersDrawerOpen ? 'Hide user list' : 'Show user list'}
          aria-expanded={usersDrawerOpen}
          title="Who's here"
          onclick={() => (usersDrawerOpen = !usersDrawerOpen)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
            />
          </svg>
        </button>
      {/if}
      <div class="menu-wrap" bind:this={menuEl}>
        <button
          class="iconbtn"
          aria-label="Menu"
          aria-expanded={menuOpen}
          onclick={() => (menuOpen = !menuOpen)}>⋯</button
        >
        {#if menuOpen}
          <div class="menu" role="menu">
            {#if $serverInfo}
              <div class="menu-title" title="Server name">{$serverInfo.name}</div>
              <div class="sep"></div>
            {/if}
            {#if activeChannel !== null}
              <button class="item" onclick={leaveActive}>Leave channel</button>
              {#if !isNarrow}
                <!-- Toggles the inline sidebar. When it's off (or the screen is narrow) the
                     top-bar button slides the list out instead, so this would be a no-op there. -->
                <button class="item" onclick={() => ((showUsers = !showUsers), (menuOpen = false))}>
                  {showUsers ? 'Hide' : 'Show'} user list
                </button>
              {/if}
            {/if}
            <button class="item" onclick={() => ((showMacros = true), (menuOpen = false))}
              >Macros…</button
            >
            <button class="item" onclick={() => ((showFormatting = true), (menuOpen = false))}
              >Formatting help…</button
            >
            <button class="item" onclick={() => ((showOptions = true), (menuOpen = false))}
              >Options…</button
            >
            {#if isDesktop()}
              <button class="item" onclick={onSwitchServer}>Switch server…</button>
            {/if}
            <div class="sep"></div>
            <button class="item danger" onclick={onDisconnect}>Disconnect</button>
            <div class="who" data-state={$connection}>
              {$connection}{#if $self}
                · {$self.name}{/if}
            </div>
            <div class="versions">
              <span class:warn={stale}
                >client {clientBuild.version} · {shortBuild(clientBuild.buildId)}</span
              >
              {#if $serverInfo}
                <span>server {$serverInfo.version} · proto {$serverInfo.protocol}</span>
              {/if}
              {#if updateStatus}
                <span class:warn={updateStatus.state === 'available'}
                  >{updateStatusText(updateStatus)}</span
                >
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </header>

  <main class="body">
    {#if activeChannel === null && activePm === null}
      <div class="placeholder">
        {#if $connection !== 'active'}
          <img class="splash-logo" src="logo.png" alt="Mara 3" />
          <p>Connecting…</p>
          <p class="splash-ver">v{clientBuild.version}</p>
        {:else}
          <p>Join a channel with the + button to start chatting.</p>
        {/if}
      </div>
    {:else}
      <div class="convo" class:with-users={sidebarInline}>
        <ChatView
          lines={activeLines}
          users={$directory}
          {sessionStart}
          conversationKey={activeKey}
          emoji={$emoji}
          messageStyle={settings.messageStyle}
          hasMore={activeChannel !== null && ($hasMoreHistory.get(activeChannel) ?? false)}
          onLoadOlder={() => {
            if (activeChannel !== null) client.requestOlderHistory(activeChannel);
          }}
        />
        {#if sidebarInline}
          <UserList
            users={membersOf(activeChannel)}
            selfToken={$self?.token ?? null}
            onselect={openPm}
          />
        {/if}
      </div>
      <ChatInput
        onsend={handleSend}
        disabled={$connection !== 'active'}
        placeholder={`Message ${title}`}
        macros={settings.macros}
        upload={(file) => uploadImage(file, client.sessionToken)}
        focusKey={activeKey}
        color={settings.color}
        emoji={$emoji}
        mentionNames={[...$users.values()].map((u) => u.name)}
      />
    {/if}
  </main>

  {#if usersDrawerOpen && activeChannel !== null}
    <!-- Slide-out user list for when it isn't shown inline. Scrim dismisses; picking a user
         opens the PM and closes the drawer. -->
    <button
      class="users-scrim"
      aria-label="Close user list"
      transition:fade={{ duration: 150 }}
      onclick={() => (usersDrawerOpen = false)}
    ></button>
    <aside class="users-drawer" transition:fly={{ x: 300, duration: 200 }}>
      <UserList
        users={membersOf(activeChannel)}
        selfToken={$self?.token ?? null}
        onselect={(u) => ((usersDrawerOpen = false), openPm(u))}
      />
    </aside>
  {/if}
</div>

{#if showMacros}
  <MacrosDialog
    macros={settings.macros}
    onClose={() => {
      showMacros = false;
      persist();
    }}
  />
{/if}

{#if showFormatting}
  <FormattingHelp onClose={() => (showFormatting = false)} />
{/if}

{#if showOptions}
  <OptionsDialog {settings} onApply={applyOptions} onClose={() => (showOptions = false)} />
{/if}

<!-- Single shared lightbox for chat images and attachment tiles. -->
<Lightbox />

<style>
  .app {
    display: flex;
    flex-direction: column;
    /* Dynamic viewport height so the app fits when the keyboard opens (paired with
       interactive-widget=resizes-content in the viewport meta). */
    height: 100dvh;
    /* Keep content out from under the system bars / display cutout. The insets are 0 on
       desktop, so this is a no-op there. Bottom is handled by the composer. */
    padding-top: env(safe-area-inset-top);
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);
    background: var(--mara-bg);
    color: var(--mara-fg);
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    border-bottom: 1px solid var(--mara-border);
    min-height: 2.6rem;
  }
  .convos {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex: 1;
    min-width: 0;
  }
  .title {
    font-weight: 600;
    font-size: 1rem;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    /* Size to the tabs' content so the + button sits right after them, but allow
       shrinking (min-width: 0) + horizontal scroll when there are too many to fit —
       NOT flex-grow, which would stretch the strip and push + to the far right. */
    flex: 0 1 auto;
    min-width: 0;
  }
  .join-wrap {
    position: relative;
    flex: none;
  }
  .addbtn {
    background: none;
    border: 1px solid var(--mara-border);
    color: inherit;
    border-radius: 6px;
    width: 1.8rem;
    height: 1.8rem;
    line-height: 1;
    font-size: 1.1rem;
    cursor: pointer;
  }
  .addbtn:hover {
    background: var(--mara-hover);
  }
  .join-pop {
    position: absolute;
    left: 0;
    top: 2.2rem;
    z-index: 20;
    display: flex;
    gap: 0.25rem;
    background: var(--mara-bg-alt);
    border: 1px solid var(--mara-border);
    border-radius: 8px;
    padding: 0.4rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .join-pop input {
    background: var(--mara-input-bg);
    border: 1px solid var(--mara-border);
    border-radius: 5px;
    color: inherit;
    padding: 0.35rem 0.45rem;
    font: inherit;
    width: 9rem;
  }
  .join-pop button {
    border: none;
    border-radius: 5px;
    background: var(--mara-accent);
    color: #fff;
    padding: 0 0.7rem;
    cursor: pointer;
  }
  .tabs button {
    background: none;
    border: none;
    color: inherit;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
    white-space: nowrap;
  }
  .tabs button:hover {
    background: var(--mara-hover);
  }
  .tabs button.active {
    background: var(--mara-accent);
    color: #fff;
  }
  /* Unread conversations — channel tabs and PM tabs alike — get the same strong
     treatment: bold, accent colour, and a leading dot. (The PM variant lives on the
     inner .tab-main since the pill wraps a label + close button.) */
  .tabs > button.unread:not(.active),
  .tabs .pmtab.unread:not(.active) .tab-main {
    font-weight: 700;
    color: var(--mara-link, #5aa9ff);
  }
  .tabs > button.unread:not(.active)::before,
  .tabs .pmtab.unread:not(.active) .tab-main::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--mara-accent);
    margin-right: 0.4rem;
    vertical-align: middle;
  }
  /* PM tabs are a pill wrapping a label button and a close (×) button. */
  .tabs .pmtab {
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    font-style: italic;
    white-space: nowrap;
  }
  .tabs .pmtab:hover {
    background: var(--mara-hover);
  }
  .tabs .pmtab.active {
    background: var(--mara-accent);
    color: #fff;
  }
  .tabs .pmtab > button:hover {
    background: none; /* hover highlight is on the pill, not the inner buttons */
  }
  .tabs .pmtab .tab-main {
    padding: 0.3rem 0.15rem 0.3rem 0.6rem;
  }
  .tabs .pmtab .tab-x {
    padding: 0 0.5rem 0 0.25rem;
    opacity: 0.55;
    line-height: 1;
  }
  .tabs .pmtab .tab-x:hover {
    opacity: 1;
  }
  .tabsep {
    width: 1px;
    align-self: stretch;
    background: var(--mara-border);
    margin: 0.25rem 0.2rem;
    flex: none;
  }
  .actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--mara-danger);
    flex: none;
  }
  .dot[data-state='active'] {
    background: var(--mara-ok);
  }
  .dot[data-state='reconnecting'],
  .dot[data-state='connecting'],
  .dot[data-state='authenticating'] {
    background: #d9a72a;
  }
  .menu-wrap {
    position: relative;
  }
  .iconbtn {
    background: none;
    border: 1px solid var(--mara-border);
    color: inherit;
    border-radius: 6px;
    width: 2rem;
    height: 2rem;
    cursor: pointer;
    font-size: 1.1rem;
    line-height: 1;
  }
  .iconbtn:hover {
    background: var(--mara-hover);
  }
  /* The users-toggle holds an SVG glyph rather than a text glyph — center it. */
  .users-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .users-toggle svg {
    width: 1.15rem;
    height: 1.15rem;
    display: block;
  }
  .users-toggle[aria-expanded='true'] {
    background: var(--mara-hover);
  }
  /* Slide-out user list (when the inline sidebar isn't shown). */
  .users-scrim {
    position: fixed;
    inset: 0;
    border: none;
    padding: 0;
    margin: 0;
    background: rgba(0, 0, 0, 0.45);
    cursor: default;
    z-index: 40;
  }
  .users-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(260px, 78vw);
    z-index: 41;
    display: flex;
    flex-direction: column;
    background: var(--mara-bg);
    border-left: 1px solid var(--mara-border);
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    /* Clear the system bars / display cutout on mobile (0 on desktop). */
    padding-top: env(safe-area-inset-top);
    padding-right: env(safe-area-inset-right);
    padding-bottom: env(safe-area-inset-bottom);
  }
  .users-drawer :global(.mara-userlist) {
    width: 100%;
    height: 100%;
  }
  .menu {
    position: absolute;
    right: 0;
    top: 2.4rem;
    z-index: 20;
    width: 220px;
    background: var(--mara-bg-alt);
    border: 1px solid var(--mara-border);
    border-radius: 8px;
    padding: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .menu-title {
    padding: 0.3rem 0.5rem 0.1rem;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--mara-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .item {
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 0.45rem 0.5rem;
    border-radius: 6px;
    cursor: pointer;
    font: inherit;
  }
  .item:hover {
    background: var(--mara-hover);
  }
  .item.danger {
    color: var(--mara-danger);
  }
  .sep {
    height: 1px;
    background: var(--mara-border);
    margin: 0.25rem 0;
  }
  .who {
    font-size: 0.75rem;
    opacity: 0.55;
    padding: 0.3rem 0.5rem 0.1rem;
  }
  .versions {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    font-size: 0.7rem;
    opacity: 0.5;
    padding: 0 0.5rem 0.3rem;
  }
  .versions .warn {
    color: var(--mara-danger);
    opacity: 1;
  }
  .stale {
    border: 1px solid var(--mara-danger);
    color: var(--mara-danger);
    background: transparent;
    border-radius: 999px;
    font-size: 0.72rem;
    padding: 0.1rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .stale:hover {
    background: var(--mara-danger);
    color: #fff;
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .convo {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr;
    min-height: 0;
  }
  .convo.with-users {
    grid-template-columns: 1fr 180px;
  }
  .placeholder {
    flex: 1;
    display: grid;
    place-content: center;
    opacity: 0.5;
    text-align: center;
    padding: 1rem;
  }
  .splash-logo {
    width: min(256px, 70vw);
    height: auto;
    display: block;
    margin: 0 auto 0.75rem;
  }
  .splash-ver {
    margin: 0.25rem 0 0;
    font-size: 0.75rem;
    opacity: 0.6;
  }
</style>
