<script lang="ts">
  import { MaraClient } from '@mara/client-core';
  import { createPipeline, shrugPlugin } from '@mara/plugin-api';
  import { loadSettings, saveSettings, type MaraSettings } from './lib/settings.js';
  import ChatApp from './ChatApp.svelte';

  // Build-time plugin registry (CSP-safe for web/mobile). Add plugins here.
  const plugins = createPipeline([shrugPlugin]);

  let settings = $state<MaraSettings>(loadSettings());
  let client = $state<MaraClient | null>(null);
  let error = $state('');

  function connect(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    saveSettings(settings);

    const c = new MaraClient({
      url: settings.serverUrl,
      name: settings.name.trim() || 'guest',
      style: {
        font: {
          family: settings.fontFamily,
          pointSize: settings.fontSize,
          bold: false,
          italic: false,
          underline: false,
        },
        color: settings.color,
      },
      plugins,
    });
    c.events.on('loginDenied', (d) => {
      error = d.updateRequired ? 'Client update required.' : d.reason;
      client = null;
    });
    c.events.on('kicked', (d) => {
      error = `Kicked: ${d.reason}`;
    });
    c.events.on('error', (e) => {
      if (client && client.status !== 'active') error = e.message;
    });

    client = c;
    c.connect();
  }

  function disconnect() {
    client?.disconnect();
    client = null;
  }
</script>

{#if client}
  <ChatApp {client} showTimestamps={settings.showTimestamps} onDisconnect={disconnect} />
{:else}
  <div class="connect">
    <form onsubmit={connect}>
      <h1>Mara 3</h1>
      <label>
        Server
        <input bind:value={settings.serverUrl} placeholder="ws://localhost:5050" required />
      </label>
      <label>
        Display name
        <input bind:value={settings.name} placeholder="your name" required />
      </label>
      <div class="row">
        <label class="color">
          Color
          <input type="color" bind:value={settings.color} />
        </label>
        <label class="grow">
          Font
          <input bind:value={settings.fontFamily} />
        </label>
        <label class="size">
          Size
          <input type="number" min="6" max="32" bind:value={settings.fontSize} />
        </label>
      </div>
      <label class="check">
        <input type="checkbox" bind:checked={settings.showTimestamps} />
        Show timestamps
      </label>
      {#if error}<p class="error">{error}</p>{/if}
      <button type="submit">Connect</button>
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
  .row {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }
  .row .grow {
    flex: 1;
  }
  .row .size {
    width: 4.5rem;
  }
  .color input[type='color'] {
    padding: 0;
    height: 2.4rem;
    width: 3rem;
  }
  .check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
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
</style>
