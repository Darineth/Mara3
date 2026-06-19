<script lang="ts">
  import { get } from 'svelte/store';
  import { ChatView, ChatInput, UserList, Lightbox } from '@mara/ui';
  import type { ChannelState, ChatLine, MaraClient, Token, UserInfo } from '@mara/client-core';
  import { connectionNotice, type NoticeState } from './lib/connectionNotice.js';
  import { isDesktop, nativeLog } from './lib/native.js';
  import type { MaraSettings } from './lib/settings.js';
  import { uploadImage } from './lib/upload.js';
  import MacrosDialog from './MacrosDialog.svelte';

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
  let menuOpen = $state(false);
  let showUsers = $state(true);
  let menuEl = $state<HTMLElement | null>(null);
  let joinOpen = $state(false);
  let joinEl = $state<HTMLElement | null>(null);
  let joinInput = $state<HTMLInputElement | null>(null);

  // The parent remounts ChatApp when `client` changes (keyed by {#if client}),
  // so capturing the (stable) stores once is correct.
  // svelte-ignore state_referenced_locally
  const { connection, self, users, directory, channels, channelMessages, privateMessages } = client;

  // Active view: either a channel token or a private-message peer token.
  let activeChannel = $state<Token | null>(null);
  let activePm = $state<Token | null>(null);
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
    if (activeChannel === token && activePm === null) return; // already looking at it
    if (!unreadChannels.has(token)) unreadChannels = new Set(unreadChannels).add(token);
  }
  function markPmUnread(token: Token) {
    if (activePm === token) return;
    if (!unreadPms.has(token)) unreadPms = new Set(unreadPms).add(token);
  }
  function clearUnread(set: Set<Token>, token: Token): Set<Token> {
    if (!set.has(token)) return set;
    const next = new Set(set);
    next.delete(token);
    return next;
  }

  // Connection drop/recover notices, shown inline in every conversation.
  let connectionLines = $state<ChatLine[]>([]);
  let sysSeq = 0;
  const noticeState: NoticeState = { dropAnnounced: false };

  function pushSystem(text: string) {
    const line: ChatLine = { id: --sysSeq, kind: 'system', from: null, text, at: Date.now() };
    connectionLines = [...connectionLines, line].slice(-50);
  }

  $effect(() => {
    const offs = [
      client.events.on('channelJoined', (ch) => {
        activeChannel = ch.token;
        activePm = null;
      }),
      client.events.on('channelLeft', (ev) => {
        if (activeChannel === ev.channelToken) {
          // Fall back to another channel we're still in, rather than an empty view.
          activeChannel = [...$channels.keys()].find((t) => t !== ev.channelToken) ?? null;
        }
      }),
      client.events.on('privateMessage', (pm) => {
        addPmTab(pm.from);
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
  $effect(() => {
    if (!isDesktop()) return;
    const offs = [
      client.events.on('connected', (i) => void nativeLog(`connected as ${i.name}`)),
      client.events.on('statusChanged', (s) => void nativeLog(`status: ${s}`)),
      client.events.on(
        'chat',
        (m) => void nativeLog(`#${m.channelToken} <${nameOf(m.from)}> ${m.text}`),
      ),
      client.events.on(
        'privateMessage',
        (m) => void nativeLog(`[pm] <${nameOf(m.from)}> ${m.text}`),
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

  function join() {
    const name = joinName.trim();
    if (!name) return;
    client.joinChannel(name);
    joinName = '';
    joinOpen = false;
  }

  function leaveActive() {
    if (activeChannel !== null) client.leaveChannel(activeChannel);
    menuOpen = false;
  }

  function handleSend(text: string) {
    if (activePm !== null) {
      client.sendPrivateMessage(activePm, text);
      return;
    }
    if (activeChannel === null) return;
    if (text.startsWith('/me ')) client.sendEmote(activeChannel, text.slice(4));
    else if (text.startsWith('/away ')) client.sendAway(text.slice(6));
    else if (text === '/away') client.sendAway('');
    else client.sendChat(activeChannel, text);
  }

  const baseLines = $derived(
    activePm !== null
      ? ($privateMessages.get(activePm) ?? [])
      : activeChannel !== null
        ? ($channelMessages.get(activeChannel) ?? [])
        : [],
  );

  // Interleave connection notices with the conversation, in time order.
  const activeLines = $derived(
    connectionLines.length === 0
      ? baseLines
      : [...baseLines, ...connectionLines].sort((a, b) => a.at - b.at || a.id - b.id),
  );
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
              <button class="tab-main" onclick={() => selectPm(peer)}>@{nameOf(peer)}</button>
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
            {#if activeChannel !== null}
              <button class="item" onclick={leaveActive}>Leave channel</button>
              <button class="item" onclick={() => ((showUsers = !showUsers), (menuOpen = false))}>
                {showUsers ? 'Hide' : 'Show'} user list
              </button>
            {/if}
            <button class="item" onclick={() => ((showMacros = true), (menuOpen = false))}
              >Macros…</button
            >
            <div class="sep"></div>
            <button class="item danger" onclick={onDisconnect}>Disconnect</button>
            <div class="who" data-state={$connection}>
              {$connection}{#if $self}
                · {$self.name}{/if}
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
          <p>Connecting…</p>
        {:else}
          <p>Join a channel with the + button to start chatting.</p>
        {/if}
      </div>
    {:else}
      <div class="convo" class:with-users={activeChannel !== null && showUsers}>
        <ChatView lines={activeLines} users={$directory} showTimestamps={settings.showTimestamps} />
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
        macros={settings.macros}
        upload={(file) => uploadImage(file, client.sessionToken)}
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
    flex: 1;
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
  @media (max-width: 640px) {
    .convo.with-users {
      grid-template-columns: 1fr;
    }
    .convo.with-users :global(.mara-userlist) {
      display: none;
    }
  }
</style>
