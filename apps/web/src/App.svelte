<!--
  Root component: the connect form (display name + appearance) until a session
  exists, then hands off to ChatApp. Owns the single MaraClient instance and the
  settings that seed it.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { MaraClient } from '@mara/client-core';
  import { createPipeline, shrugPlugin } from '@mara/plugin-api';
  import {
    applyTheme,
    loadSettings,
    saveSettings,
    serverUrl,
    type MaraSettings,
  } from './lib/settings.js';
  import { clientBuild, shortBuild } from './lib/version.js';
  import { desktopVersion } from './lib/update.js';
  import ChatApp from './ChatApp.svelte';
  import UpdateBanner from './UpdateBanner.svelte';

  // Build-time plugin registry (CSP-safe for web/mobile). Add plugins here.
  const plugins = createPipeline([shrugPlugin]);

  let settings = $state<MaraSettings>(loadSettings());
  let client = $state<MaraClient | null>(null);
  let error = $state('');
  // The operator-set server name, shown under the logo on the connect screen.
  // Fetched from the public /info endpoint (no login needed); falls back to the
  // app name if the server is unreachable or doesn't report one.
  let serverName = $state('Mara 3');

  async function loadServerName() {
    try {
      // Resolve against the document base so it works at a subpath too.
      const res = await fetch(new URL('info', document.baseURI), { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { name?: unknown };
      if (typeof data.name === 'string' && data.name.trim()) serverName = data.name.trim();
    } catch {
      /* keep the fallback name */
    }
  }

  // Apply the colour theme app-wide whenever it changes (also covers the initial
  // load and toggles made from the in-session menu, which mutate this same object).
  $effect(() => applyTheme(settings.theme));

  function connect() {
    error = '';
    // Persist first so a returning user's name is on disk for onMount auto-connect,
    // even if the connection itself fails.
    saveSettings(settings);

    const c = new MaraClient({
      url: serverUrl(),
      name: settings.name.trim() || 'guest',
      color: settings.color,
      identityKey: settings.identityKey,
      initialChannels: settings.channels,
      plugins,
    });
    c.events.on('loginDenied', (d) => {
      error = d.reason;
      client = null;
    });
    c.events.on('error', (e) => {
      // Only surface errors before we're fully connected; once active, transient
      // socket errors are the client's reconnect concern, not the login form's.
      if (client && client.status !== 'active') error = e.message;
    });

    client = c;
    c.connect();
  }

  function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    connect();
  }

  function disconnect() {
    client?.disconnect();
    client = null;
  }

  // Auto-connect on page load when we already have a display name (returning
  // user). First-time visitors fill the form once; after that it's automatic.
  // The client's own reconnect/backoff then keeps the session alive.
  onMount(() => {
    // Log the build to the console so a stale page is identifiable even without
    // opening the in-app menu (e.g. when debugging a client that didn't refresh).
    console.info(`Mara 3 web client ${clientBuild.version} · build ${clientBuild.buildId}`);
    // In the desktop shell, put the client version in the titlebar (the native window
    // title is overridden by this page's document.title on load). No-op in a browser.
    const dv = desktopVersion();
    if (dv) document.title = `Mara 3 v${dv}`;
    void loadServerName();
    if (settings.name.trim()) connect();
  });
</script>

<!-- Desktop update nudge: persists across the connect screen and the live chat;
     a no-op in a plain browser (nothing to update). -->
<UpdateBanner />

{#if client}
  <ChatApp {client} {settings} onDisconnect={disconnect} persist={() => saveSettings(settings)} />
{:else}
  <div class="connect">
    <form onsubmit={onSubmit}>
      <img class="logo" src="logo.png" alt="Mara 3" />
      <h1>{serverName}</h1>
      <label>
        Display name
        <input bind:value={settings.name} placeholder="your name" required />
      </label>
      <label class="color">
        Color
        <input type="color" bind:value={settings.color} />
      </label>
      <label>
        Theme
        <select bind:value={settings.theme}>
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      {#if error}<p class="error">{error}</p>{/if}
      <button type="submit">Connect</button>
      <p class="build">v{clientBuild.version} · build {shortBuild(clientBuild.buildId)}</p>
    </form>
  </div>
{/if}

<style>
  .connect {
    height: 100vh;
    display: grid;
    place-content: center;
    background: var(--mara-bg);
    color: var(--mara-fg);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(360px, 90vw);
    padding: 1.5rem;
    background: var(--mara-bg-alt);
    border: 1px solid var(--mara-border);
    border-radius: 10px;
  }
  .logo {
    width: min(256px, 100%);
    height: auto;
    display: block;
    margin: 0 auto 0.5rem;
  }
  h1 {
    margin: 0 0 0.5rem;
    text-align: center;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    opacity: 0.9;
  }
  input {
    font: inherit;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border);
    background: var(--mara-input-bg);
    color: inherit;
  }
  .color input[type='color'] {
    padding: 0;
    height: 2.4rem;
    width: 3rem;
  }
  .error {
    color: var(--mara-danger);
    margin: 0;
    font-size: 0.85rem;
  }
  button[type='submit'] {
    padding: 0.6rem;
    border: none;
    border-radius: 6px;
    background: var(--mara-accent);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
  .build {
    margin: 0;
    text-align: center;
    font-size: 0.7rem;
    opacity: 0.4;
  }
</style>
