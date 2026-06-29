<!--
  Desktop-client update nudge, shown inside the Tauri shell once it has navigated
  past the launch picker into the live UI (the picker shows its own banner only
  briefly at startup). A no-op in a plain browser — there's no client to update —
  and dismissals are remembered per version so it never nags for the same build.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { getUpdateStatus, downloadUpdate, type AvailableUpdate } from './lib/update.js';

  const DISMISS_KEY = 'mara.dismissedUpdate';

  let update = $state<AvailableUpdate | null>(null);

  function dismissed(version: string): boolean {
    try {
      return localStorage.getItem(DISMISS_KEY) === version;
    } catch {
      return false;
    }
  }

  function dismiss() {
    if (update) {
      try {
        localStorage.setItem(DISMISS_KEY, update.version);
      } catch {
        /* private mode / disabled storage — just hide for this session */
      }
    }
    update = null;
  }

  onMount(async () => {
    const status = await getUpdateStatus();
    if (status.state === 'available' && !dismissed(status.update.version)) update = status.update;
  });
</script>

{#if update}
  <div class="update" role="status">
    <span class="text">
      Mara&nbsp;3 <strong>{update.version}</strong> is available.{#if update.notes}
        {update.notes}{/if}
    </span>
    {#if update.url}
      <button class="download" onclick={() => downloadUpdate(update!)}>Download</button>
    {/if}
    <button class="dismiss" title="Dismiss" aria-label="Dismiss" onclick={dismiss}>×</button>
  </div>
{/if}

<style>
  .update {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.8rem;
    background: var(--mara-accent);
    color: #fff;
    font-size: 0.85rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  }
  .text {
    flex: 1;
  }
  .download {
    padding: 0.3rem 0.7rem;
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .dismiss {
    padding: 0.1rem 0.4rem;
    border: none;
    background: transparent;
    color: #fff;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.85;
  }
  .dismiss:hover {
    opacity: 1;
  }
</style>
