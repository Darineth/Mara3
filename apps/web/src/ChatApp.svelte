<script lang="ts">
  import { ChatView, ChatInput, UserList } from '@mara/ui';
  import type { ChannelState, MaraClient, Token, UserInfo } from '@mara/client-core';

  let {
    client,
    showTimestamps = true,
    onDisconnect,
  }: {
    client: MaraClient;
    showTimestamps?: boolean;
    onDisconnect: () => void;
  } = $props();

  // The parent remounts ChatApp when `client` changes (keyed by {#if client}),
  // so capturing the (stable) stores once is correct.
  // svelte-ignore state_referenced_locally
  const { connection, self, users, channels, channelMessages, privateMessages } = client;

  // Active view: either a channel token or a private-message peer token.
  let activeChannel = $state<Token | null>(null);
  let activePm = $state<Token | null>(null);
  let joinName = $state('');

  $effect(() => {
    const offs = [
      client.events.on('channelJoined', (ch) => {
        activeChannel = ch.token;
        activePm = null;
      }),
      client.events.on('channelLeft', (ev) => {
        if (activeChannel === ev.channelToken) activeChannel = null;
      }),
      client.events.on('privateMessage', (pm) => {
        if (activePm === null && activeChannel === null) activePm = pm.from;
      }),
    ];
    return () => offs.forEach((off) => off());
  });

  const channelList = $derived([...$channels.values()] as ChannelState[]);
  const pmPeers = $derived([...$privateMessages.keys()] as Token[]);

  function membersOf(token: Token): UserInfo[] {
    const channel = $channels.get(token);
    if (!channel) return [];
    return [...channel.members]
      .map((t) => $users.get(t))
      .filter((u): u is UserInfo => u !== undefined);
  }

  function nameOf(token: Token): string {
    return $users.get(token)?.name ?? `#${token}`;
  }

  function openChannel(token: Token) {
    activeChannel = token;
    activePm = null;
  }

  function openPm(user: UserInfo) {
    activePm = user.token;
    activeChannel = null;
  }

  function join() {
    const name = joinName.trim();
    if (!name) return;
    client.joinChannel(name);
    joinName = '';
  }

  function leaveActive() {
    if (activeChannel !== null) client.leaveChannel(activeChannel);
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

  const activeLines = $derived(
    activePm !== null
      ? ($privateMessages.get(activePm) ?? [])
      : activeChannel !== null
        ? ($channelMessages.get(activeChannel) ?? [])
        : [],
  );
</script>

<div class="app">
  <aside class="sidebar">
    <div class="brand">Mara 3</div>

    <div class="section-title">Channels</div>
    <ul class="nav">
      {#each channelList as channel (channel.token)}
        <li>
          <button
            class:active={activeChannel === channel.token}
            onclick={() => openChannel(channel.token)}
          >
            #{channel.name}
          </button>
        </li>
      {/each}
    </ul>
    <form class="join" onsubmit={(e) => (e.preventDefault(), join())}>
      <input bind:value={joinName} placeholder="join channel…" />
      <button type="submit">+</button>
    </form>

    {#if pmPeers.length > 0}
      <div class="section-title">Messages</div>
      <ul class="nav">
        {#each pmPeers as peer (peer)}
          <li>
            <button class:active={activePm === peer} onclick={() => (activePm = peer)}
              >@{nameOf(peer)}</button
            >
          </li>
        {/each}
      </ul>
    {/if}

    <div class="spacer"></div>
    <div class="status" data-state={$connection}>
      <span class="dot"></span>
      {$connection}{#if $self}
        · {$self.name}{/if}
    </div>
    <button class="disconnect" onclick={onDisconnect}>Disconnect</button>
  </aside>

  <main class="main">
    {#if activeChannel === null && activePm === null}
      <div class="placeholder">
        {#if $connection !== 'active'}
          <p>Connecting…</p>
        {:else}
          <p>Join a channel to start chatting.</p>
        {/if}
      </div>
    {:else}
      <header class="head">
        <h1>
          {activePm !== null
            ? `@${nameOf(activePm)}`
            : `#${$channels.get(activeChannel as Token)?.name ?? ''}`}
        </h1>
        {#if activeChannel !== null}
          <button class="leave" onclick={leaveActive}>Leave</button>
        {/if}
      </header>

      <div class="body">
        <ChatView lines={activeLines} users={$users} {showTimestamps} />
        {#if activeChannel !== null}
          <UserList
            users={membersOf(activeChannel)}
            selfToken={$self?.token ?? null}
            onselect={openPm}
          />
        {/if}
      </div>

      <ChatInput onsend={handleSend} disabled={$connection !== 'active'} />
    {/if}
  </main>
</div>

<style>
  .app {
    display: grid;
    grid-template-columns: 220px 1fr;
    height: 100vh;
    background: var(--mara-bg);
    color: var(--mara-fg);
  }
  .sidebar {
    display: flex;
    flex-direction: column;
    background: var(--mara-bg-alt);
    border-right: 1px solid var(--mara-border);
    padding: 0.5rem;
  }
  .brand {
    font-weight: 700;
    padding: 0.5rem;
    font-size: 1.1rem;
  }
  .section-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.5;
    margin: 0.75rem 0.5rem 0.25rem;
  }
  .nav {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .nav button {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: inherit;
    padding: 0.35rem 0.5rem;
    border-radius: 5px;
    cursor: pointer;
    font: inherit;
  }
  .nav button:hover {
    background: var(--mara-hover);
  }
  .nav button.active {
    background: var(--mara-accent);
    color: #fff;
  }
  .join {
    display: flex;
    gap: 0.25rem;
    margin: 0.25rem 0.25rem 0;
  }
  .join input {
    flex: 1;
    min-width: 0;
    background: var(--mara-input-bg);
    border: 1px solid var(--mara-border);
    border-radius: 5px;
    color: inherit;
    padding: 0.3rem 0.4rem;
    font: inherit;
  }
  .join button {
    width: 1.8rem;
    border: none;
    border-radius: 5px;
    background: var(--mara-accent);
    color: #fff;
    cursor: pointer;
  }
  .spacer {
    flex: 1;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    padding: 0.4rem 0.5rem;
    opacity: 0.85;
  }
  .status .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--mara-danger);
  }
  .status[data-state='active'] .dot {
    background: var(--mara-ok);
  }
  .status[data-state='reconnecting'] .dot,
  .status[data-state='connecting'] .dot,
  .status[data-state='authenticating'] .dot {
    background: #d9a72a;
  }
  .disconnect {
    background: none;
    border: 1px solid var(--mara-border);
    color: inherit;
    border-radius: 5px;
    padding: 0.35rem;
    cursor: pointer;
    margin-top: 0.25rem;
  }
  .main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid var(--mara-border);
  }
  .head h1 {
    font-size: 1rem;
    margin: 0;
  }
  .leave {
    background: none;
    border: 1px solid var(--mara-border);
    color: inherit;
    border-radius: 5px;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
  }
  .body {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 180px;
    min-height: 0;
  }
  .body :global(.mara-chatview) {
    border-right: 0;
  }
  .placeholder {
    flex: 1;
    display: grid;
    place-content: center;
    opacity: 0.5;
  }
  @media (max-width: 640px) {
    .app {
      grid-template-columns: 1fr;
    }
    .sidebar {
      display: none;
    }
    .body {
      grid-template-columns: 1fr;
    }
    .body :global(.mara-userlist) {
      display: none;
    }
  }
</style>
