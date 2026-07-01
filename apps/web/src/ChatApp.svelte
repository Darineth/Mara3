<!--
  Main chat surface once connected: channel/PM tabs, message view, user list,
  input, and the overflow menu. Reads reactive client stores and translates UI
  actions back into MaraClient calls. Mounted only while a session exists, and
  remounted (fresh state) whenever the client instance changes.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { ChatView, ChatInput, UserList, Lightbox } from '@mara/ui';
  import type { ChannelState, ChatLine, MaraClient, Token, UserInfo } from '@mara/client-core';
  import { connectionNotice, type NoticeState } from './lib/connectionNotice.js';
  import { isDesktop, nativeLog, switchServer } from './lib/native.js';
  import { runSlashCommand, type CommandContext } from './lib/commands.js';
  import type { MaraSettings, Theme } from './lib/settings.js';
  import { clientBuild, shortBuild } from './lib/version.js';
  import { getUpdateStatus, updateStatusText, type UpdateStatus } from './lib/update.js';
  import { uploadImage } from './lib/upload.js';
  import MacrosDialog from './MacrosDialog.svelte';
  import FormattingHelp from './FormattingHelp.svelte';
  import OptionsDialog from './OptionsDialog.svelte';

  let {
    client,
    settings,
    onDisconnect,
    persist,
  }: {
    client: MaraClient;
    settings: MaraSettings;
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
    privateMessages,
    serverInfo,
    motd,
  } = client;

  // The page is stale when the server reports serving a different web build than
  // the one this bundle was compiled as — i.e. the browser is running cached old
  // code and should be reloaded. Silent when the server doesn't report a build
  // (dev, or an older server).
  const stale = $derived(!!$serverInfo?.webBuild && $serverInfo.webBuild !== clientBuild.buildId);

  // Once connected, show the server's name in the browser tab; restore the original
  // title (e.g. "Mara 3") when the session ends.
  const baseTitle = typeof document !== 'undefined' ? document.title : '';
  $effect(() => {
    if (typeof document !== 'undefined') document.title = $serverInfo?.name ?? baseTitle;
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

  // Active view: a channel token, a private-message peer token, or neither
  // (placeholder). Mutually exclusive — at most one is non-null at a time;
  // every selector below nulls the other to preserve that invariant, which the
  // title/baseLines deriveds rely on to pick which conversation to show.
  let activeChannel = $state<Token | null>(null);
  let activePm = $state<Token | null>(null);
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

  function markChannelUnread(token: Token) {
    // "Looking at it" requires the channel active AND no PM in front of it.
    if (activeChannel === token && activePm === null) return;
    if (!unreadChannels.has(token)) unreadChannels = new Set(unreadChannels).add(token);
  }
  function markPmUnread(token: Token) {
    if (activePm === token) return;
    if (!unreadPms.has(token)) unreadPms = new Set(unreadPms).add(token);
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
  let motdShown = false;
  $effect(() => {
    if ($serverInfo && !connectAnnounced) {
      connectAnnounced = true;
      // Mark where the backlog ends and this session begins (ChatView draws a rule
      // at the boundary). Captured before the first notice so all session lines
      // (Connected/joined/MOTD/live) sort at or after it.
      sessionStart = client.serverNow();
      pushSystem(`Connected to ${$serverInfo.name}.`);
      // The MOTD is pushed later, on the first channel join, so it reads
      // Connected → joined → MOTD.
    }
  });

  // Subscribe to client events for the life of the component. Each `.on` returns
  // an unsubscribe fn; the cleanup runs them all so handlers don't leak or fire
  // against a stale closure if the effect re-runs.
  $effect(() => {
    const offs = [
      client.events.on('channelJoined', (ch) => {
        // Focus the channel when the user deliberately joined it (via +) or when it's
        // the first view of the session — the server's default channel, which joins
        // first on connect. The other channels we silently rejoin on a fresh session
        // stay background tabs, so a returning user lands on the main channel.
        if (ch.name === pendingFocusJoin || (activeChannel === null && activePm === null)) {
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
        if (activeChannel === ev.channelToken) {
          // Fall back to another channel we're still in, rather than an empty view.
          activeChannel = [...$channels.keys()].find((t) => t !== ev.channelToken) ?? null;
        }
      }),
      client.events.on('privateMessage', (pm) => {
        addPmTab(pm.from);
        // Only auto-focus an incoming PM when nothing is open yet; otherwise just
        // flag it unread so we don't yank the user out of their current view.
        if (activePm === null && activeChannel === null) activePm = pm.from;
        markPmUnread(pm.from);
      }),
      client.events.on('chat', (m) => markChannelUnread(m.channelToken)),
      client.events.on('emote', (m) => markChannelUnread(m.channelToken)),
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
    if (!isDesktop()) return;
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
    ];
    return () => offs.forEach((off) => off());
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
  const showTabs = $derived(channelList.length + pmPeers.length > 1);
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

  function selectPm(token: Token) {
    addPmTab(token);
    activePm = token;
    activeChannel = null;
    unreadPms = clearUnread(unreadPms, token);
  }

  function openPm(user: UserInfo) {
    selectPm(user.token);
  }

  function closePm(token: Token) {
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

  // Apply in-session options: broadcast a name/colour change (server dedupes + tells
  // everyone via userProfile, which updates our own roster/self), apply the theme via
  // the shared settings (App's $effect re-applies it), and persist.
  function applyOptions(next: { name: string; color: string; theme: Theme }) {
    const newName = next.name.trim();
    const update: { name?: string; color?: string } = {};
    if (newName && newName !== settings.name) update.name = newName;
    if (next.color !== settings.color) update.color = next.color;
    if (update.name || update.color) client.setProfile(update);
    if (newName) settings.name = newName;
    settings.color = next.color;
    settings.theme = next.theme;
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
        selectPm(token);
        client.sendPrivateMessage(token, t);
      },
      setAway: (t) => client.sendAway(t),
      setName: (name) => {
        client.setProfile({ name });
        settings.name = name; // optimistic; the server's userProfile broadcast confirms it
        persist();
      },
      notice: (t) => pushSystem(t),
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
    if (connectionLines.length === 0) return baseLines;
    const out: ChatLine[] = [];
    let i = 0;
    for (const line of baseLines) {
      let notice = connectionLines[i];
      while (notice && notice.at < line.at) {
        out.push(notice);
        notice = connectionLines[++i];
      }
      out.push(line);
    }
    if (i < connectionLines.length) out.push(...connectionLines.slice(i));
    return out;
  });
</script>

<div class="app">
  <header class="topbar">
    <div class="convos">
      {#if showTabs}
        <nav class="tabs">
          {#each channelList as channel (channel.token)}
            <button
              class:active={activePm === null && activeChannel === channel.token}
              class:unread={unreadChannels.has(channel.token)}
              onclick={() => openChannel(channel.token)}
              onmousedown={(e) => {
                // Middle-click leaves the channel (and suppress the autoscroll cursor).
                if (e.button === 1) {
                  e.preventDefault();
                  client.leaveChannel(channel.token);
                }
              }}
              title="#{channel.name} — middle-click to leave"
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
                onclick={() => selectPm(peer)}
                onmousedown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    closePm(peer);
                  }
                }}
                title="@{nameOf(peer)} — middle-click to close">@{nameOf(peer)}</button
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
              <button class="item" onclick={() => ((showUsers = !showUsers), (menuOpen = false))}>
                {showUsers ? 'Hide' : 'Show'} user list
              </button>
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
      <div class="convo" class:with-users={activeChannel !== null && showUsers}>
        <ChatView lines={activeLines} users={$directory} {sessionStart} />
        {#if activeChannel !== null && showUsers}
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
      />
    {/if}
  </main>
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
    height: 100vh;
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
  /* Unread channels go semibold. */
  .tabs button.unread:not(.active) {
    font-weight: 600;
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
  /* Unread PMs are stronger than channels: bold + a leading dot. */
  .tabs .pmtab.unread:not(.active) .tab-main {
    font-weight: 700;
    color: var(--mara-link, #5aa9ff);
  }
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
  @media (max-width: 640px) {
    .convo.with-users {
      grid-template-columns: 1fr;
    }
    .convo.with-users :global(.mara-userlist) {
      display: none;
    }
  }
</style>
