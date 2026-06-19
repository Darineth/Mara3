<!-- Full-screen image preview driven by the shared `lightbox` store. Mount once
     near the app root; clicking the backdrop or pressing Escape dismisses it. -->
<script lang="ts">
  import { lightbox, closeLightbox } from './lightbox.js';

  // Escape closes, but only when something is open so the handler is otherwise inert.
  function onWindowKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && $lightbox) closeLightbox();
  }
</script>

{#if $lightbox}
  <div class="mara-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
    <button type="button" class="backdrop" onclick={closeLightbox} aria-label="Close preview"
    ></button>
    <img src={$lightbox.src} alt={$lightbox.alt} />
    <button type="button" class="close" onclick={closeLightbox} aria-label="Close preview">×</button
    >
  </div>
{/if}

<svelte:window onkeydown={onWindowKey} />

<style>
  .mara-lightbox {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
  }
  .mara-lightbox .backdrop {
    position: absolute;
    inset: 0;
    border: none;
    padding: 0;
    background: rgba(0, 0, 0, 0.8);
    cursor: zoom-out;
  }
  .mara-lightbox img {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    object-fit: contain;
    border-radius: 6px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5);
  }
  .mara-lightbox .close {
    position: absolute;
    top: 1rem;
    right: 1rem;
    width: 36px;
    height: 36px;
    padding: 0;
    font-size: 22px;
    line-height: 1;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
  }
</style>
