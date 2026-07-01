<!--
  Reference dialog for message formatting: the markdown, links/images, and legacy
  Mara 2 tags the renderer (@mara/chat-render) understands. Read-only — closes on
  the backdrop, Escape, or Done. Kept in sync with text.ts (applyMarkdown +
  applyBlocks + the image/link passes).
-->
<script lang="ts">
  let { onClose }: { onClose: () => void } = $props();

  let backdrop = $state<HTMLDivElement | null>(null);

  // Close on backdrop click and Escape (mirrors MacrosDialog).
  $effect(() => {
    const el = backdrop;
    if (!el) return;
    const onBackdrop = (e: Event) => {
      if (e.target === el) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    el.addEventListener('click', onBackdrop);
    window.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('click', onBackdrop);
      window.removeEventListener('keydown', onKey);
    };
  });
</script>

<div class="backdrop" bind:this={backdrop}>
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Message formatting">
    <header>
      <h2>Message formatting</h2>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>
    <p class="hint">Type these in the message box.</p>

    <h3>Text</h3>
    <div class="rows">
      <div class="row"><code>**bold**</code><span><strong>bold</strong></span></div>
      <div class="row"><code>*italic*</code><span><em>italic</em></span></div>
      <div class="row">
        <code>***bold italic***</code><span><strong><em>bold italic</em></strong></span>
      </div>
      <div class="row"><code>__underline__</code><span><u>underline</u></span></div>
      <div class="row"><code>~~strike~~</code><span><s>strike</s></span></div>
      <div class="row"><code>`code`</code><span class="mono">code</span></div>
      <div class="row"><code>```code block```</code><span class="dim">monospace block</span></div>
      <div class="row"><code>||spoiler||</code><span class="dim">hidden until clicked</span></div>
    </div>

    <h3>Lines &amp; blocks</h3>
    <p class="hint">Put these at the start of a line.</p>
    <div class="rows">
      <div class="row"><code># ## ###</code><span class="dim">headers (big → small)</span></div>
      <div class="row"><code>-# subtext</code><span class="dim">small, dim text</span></div>
      <div class="row">
        <code>&gt; quote</code><span class="dim">block quote (&gt;&gt;&gt; quotes the rest)</span>
      </div>
      <div class="row">
        <code>- item</code><span class="dim">bullet list (or <code>1.</code> for numbered)</span>
      </div>
    </div>

    <h3>Links &amp; images</h3>
    <div class="rows">
      <div class="row">
        <code>https://example.com</code><span class="dim"
          >becomes a link; image URLs show inline</span
        >
      </div>
      <div class="row">
        <code>![alt](https://…/pic.png)</code><span class="dim">inline image, with alt text</span>
      </div>
      <div class="row">
        <code>!https://…</code><span class="dim">force any URL to show inline as an image</span>
      </div>
      <div class="row">
        <code>[img]https://…[/img]</code><span class="dim">inline image (legacy)</span>
      </div>
    </div>

    <h3>Legacy Mara 2 tags</h3>
    <div class="rows">
      <div class="row">
        <code>[b] [i] [u] [s]</code>
        <span><strong>b</strong> <em>i</em> <u>u</u> <s>s</s></span>
      </div>
      <div class="row"><code>[spoiler]…[/spoiler]</code><span class="dim">spoiler</span></div>
    </div>

    <footer>
      <button class="done" onclick={onClose}>Done</button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .dialog {
    width: min(460px, 92vw);
    max-height: 86vh;
    overflow-y: auto;
    background: var(--mara-bg-alt, #252526);
    color: var(--mara-fg, #e6e6e6);
    border: 1px solid var(--mara-border, #333);
    border-radius: 10px;
    padding: 1rem 1.1rem;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.1rem;
  }
  h3 {
    margin: 1rem 0 0.4rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.55;
  }
  .close {
    background: none;
    border: none;
    color: inherit;
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
  }
  .hint {
    margin: 0.25rem 0 0.25rem;
    font-size: 0.8rem;
    opacity: 0.6;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.6rem;
    align-items: baseline;
  }
  .row code {
    font-family: var(--mara-mono, monospace);
    font-size: 0.82rem;
    background: var(--mara-input-bg, #2a2a2a);
    border: 1px solid var(--mara-border, #333);
    border-radius: 5px;
    padding: 0.1rem 0.35rem;
    word-break: break-word;
    justify-self: start;
  }
  .row .mono {
    font-family: var(--mara-mono, monospace);
  }
  .row .dim {
    opacity: 0.6;
    font-size: 0.85rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }
  .done {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 6px;
    background: var(--mara-accent, #3b82f6);
    color: #fff;
    cursor: pointer;
  }
</style>
