<!-- Message composer: autosizing textarea with sent-line history recall, F-key
     macros, and image attachments (drag-drop / paste) that upload in the
     background and are appended to the message as URLs on send. -->
<script lang="ts">
  import { tick } from 'svelte';
  import { openLightbox, closeLightboxFor } from './lightbox.js';
  import { emojiSrc, matchEmojiShortcode } from './emojiComplete.js';
  import { matchMention } from './mentionComplete.js';

  let {
    onsend,
    maxLength = 10000,
    placeholder = 'Type a message…',
    disabled = false,
    macros = [],
    upload,
    focusKey = null,
    color = null,
    emoji = {},
    emojiOwners = {},
    mentionNames = [],
  }: {
    onsend: (text: string) => void;
    maxLength?: number;
    placeholder?: string;
    disabled?: boolean;
    /** Quick-text macros indexed 0–11 for F1–F12. */
    macros?: string[];
    /** Upload an image and resolve its hosted URL; enables drag-drop & paste. */
    upload?: (file: File) => Promise<string>;
    /** The server's custom emoji (shortcode → image URL); drives the picker. Empty = no
     *  picker button. Clicking one inserts its `:name:` shortcode at the cursor. */
    emoji?: Record<string, string>;
    /** Adder display name per user-contributed emoji (shortcode → name), shown in the picker
     *  tooltip. Absent for operator-provided ("built-in") emoji. */
    emojiOwners?: Record<string, string>;
    /** An opaque identity for the active conversation. Whenever it changes (and on first
     *  mount), the textarea grabs focus — so joining or switching a channel/PM lands the
     *  cursor in the field, ready to type. `null` (no conversation) doesn't focus. */
    focusKey?: string | null;
    /** The user's own display colour (`#rrggbb`), echoed as the composer text colour so
     *  typing matches how their messages appear. Null/invalid falls back to the theme fg. */
    color?: string | null;
    /** Display names offered by the `@name` mention autocomplete (typically the
     *  connected roster). Empty = mentions don't autocomplete. */
    mentionNames?: string[];
  } = $props();

  // Validate before it's interpolated into an inline style (as renderLine does for the
  // author colour); an invalid value falls through to the textarea's `color: inherit`.
  const inputColor = $derived(/^#[0-9a-fA-F]{6}$/.test(color ?? '') ? color : null);

  // Emoji picker: opens a popover of the server's custom emoji; picking one inserts its
  // `:name:` at the cursor. Only shown when the server actually has emoji.
  let pickerOpen = $state(false);
  let pickerWrap = $state<HTMLElement | null>(null);
  const emojiList = $derived(Object.entries(emoji));

  // Hidden file input behind the "attach image" button (only shown when uploads are enabled).
  let fileInput = $state<HTMLInputElement | null>(null);
  // Trailing icon buttons in the field (send, plus attach/emoji when present) — drives how much
  // right padding the textarea needs so text never slides under them.
  const trailingCount = $derived(1 + (upload ? 1 : 0) + (emojiList.length > 0 ? 1 : 0));

  // Inline `:shortcode` autocomplete: as you type `:que`, matching emoji are offered in a
  // menu above the field; Up/Down move the selection, Enter/Tab accept, Esc dismisses.
  interface EmojiMenu {
    items: [string, string][];
    active: number;
    /** Index in `text` of the triggering `:`, so accepting replaces from there. */
    start: number;
  }
  let emojiMenu = $state<EmojiMenu | null>(null);
  let acList = $state<HTMLElement | null>(null);

  // Inline `@name` mention autocomplete: same interaction as the emoji menu (only one of
  // the two can be active — each is anchored to its own trigger token at the caret).
  interface MentionMenu {
    items: string[];
    active: number;
    /** Index in `text` of the triggering `@`, so accepting replaces from there. */
    start: number;
  }
  let mentionMenu = $state<MentionMenu | null>(null);
  let mentionList = $state<HTMLElement | null>(null);

  function chooseEmoji(name: string) {
    void insertAtCursor(`:${name}:`);
    pickerOpen = false;
  }

  // Dismiss the picker on an outside click or Escape (only wired while it's open).
  $effect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerWrap && !pickerWrap.contains(e.target as Node)) pickerOpen = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') pickerOpen = false;
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  });

  /** A pending image attachment shown as a tile above the input. */
  interface Attachment {
    id: number;
    name: string;
    /** Object URL for an instant local preview while the upload is in flight. */
    preview: string;
    /** Hosted URL once the upload resolves; undefined while uploading. */
    url?: string;
  }

  let text = $state('');
  let history = $state<string[]>([]);
  let historyIndex = $state(-1); // -1 = editing a fresh line
  let draft = ''; // the in-progress line, stashed while walking back through history
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let attachments = $state<Attachment[]>([]);
  let dragOver = $state(false);
  let uploadError = $state('');
  let nextAttachId = 0;

  // Touch devices pop a soft keyboard whenever the field takes focus, which covers the
  // chat and is jarring when you only wanted to read. Detect a touch-primary device so we
  // can skip the *automatic* focus below; explicit actions (send, history recall, accepting
  // a mention) still focus on demand.
  //
  // `(pointer: coarse)` is unreliable here — the Android WebView reports `pointer: fine`
  // (it follows the host mouse on the emulator), so we key off touch points plus the
  // absence of hover instead. Desktop keeps auto-focus: a mouse reports `hover: hover`, and
  // a mouseless desktop reports `maxTouchPoints: 0`.
  const softKeyboard =
    typeof window !== 'undefined' &&
    (navigator.maxTouchPoints ?? 0) > 0 &&
    !!window.matchMedia?.('(hover: none)').matches;

  // Land the cursor in the field whenever the active conversation changes (and on first
  // mount), so joining or switching a channel/PM is ready to type into without a click. A
  // disabled field can't take focus — harmless, and by the time a conversation is open the
  // connection is active anyway. Skipped on touch devices so it doesn't force the keyboard up.
  $effect(() => {
    focusKey; // tracked: re-focus on every change
    if (focusKey != null && !softKeyboard) textarea?.focus();
  });

  // "Type to focus": pressing a printable key while focus isn't already in an editable
  // field jumps into the composer, so you can start typing without clicking it first. We
  // don't preventDefault, so that same keystroke then lands in the textarea.
  $effect(() => {
    function onKeydown(e: KeyboardEvent) {
      if (disabled || !textarea) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (e.key.length !== 1) return; // single printable chars only (not Enter/Tab/arrows/F-keys)
      const active = document.activeElement as HTMLElement | null;
      if (active === textarea) return; // already typing here
      // Don't steal from another editable field (other inputs, dialogs, etc.).
      if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)))
        return;
      textarea.focus();
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  });

  // An attachment with no resolved `url` yet is still uploading; block send until
  // all resolve so we never emit a message referencing a not-yet-hosted image.
  const uploading = $derived(attachments.some((a) => a.url === undefined));
  // Allow send when there's something to send (text or attachments) and nothing
  // blocks it; gates both the button and the Enter handler.
  const canSend = $derived(
    !disabled && !uploading && (text.trim() !== '' || attachments.length > 0),
  );

  /** Upload dropped/pasted image files, each shown as a tile until it resolves. */
  async function uploadFiles(files: File[]) {
    if (!upload) return;
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    uploadError = '';
    for (const file of images) {
      const id = nextAttachId++;
      const preview = URL.createObjectURL(file);
      attachments = [...attachments, { id, name: file.name, preview }];
      try {
        const url = await upload(file);
        attachments = attachments.map((a) => (a.id === id ? { ...a, url } : a));
      } catch (err) {
        uploadError = err instanceof Error ? err.message : 'Upload failed';
        removeAttachment(id);
      }
    }
  }

  // Revoke the preview object URL on removal to avoid leaking it, and drop the
  // lightbox if it happens to be showing this image.
  function removeAttachment(id: number) {
    const gone = attachments.find((a) => a.id === id);
    if (gone) {
      closeLightboxFor([gone.preview, gone.url].filter((s): s is string => !!s));
      URL.revokeObjectURL(gone.preview);
    }
    attachments = attachments.filter((a) => a.id !== id);
  }

  // "Attach image" button → hidden file input → the same upload path as drop/paste.
  function pickFiles(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (files.length) void uploadFiles(files);
    input.value = ''; // reset so picking the same file again still fires onchange
  }

  function onDrop(event: DragEvent) {
    if (!upload) return;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      event.preventDefault();
      dragOver = false;
      void uploadFiles(files);
    }
  }

  function onDragOver(event: DragEvent) {
    if (!upload || !event.dataTransfer) return;
    if ([...event.dataTransfer.items].some((i) => i.kind === 'file')) {
      event.preventDefault();
      dragOver = true;
    }
  }

  // Pull image files out of a clipboard payload. Chromium/WebView2 (Windows) exposes a pasted
  // bitmap via clipboardData.files, but WebKitGTK (the Linux client's webview) only exposes it
  // via items[].getAsFile() — so fall back to items when .files has no image, or paste silently
  // does nothing there.
  function imagesFromClipboard(cd: DataTransfer): File[] {
    let images = [...cd.files].filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) {
      images = [...cd.items]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f != null);
    }
    return images;
  }

  function onPaste(event: ClipboardEvent) {
    if (!upload || !event.clipboardData) return;
    const images = imagesFromClipboard(event.clipboardData);
    if (images.length > 0) {
      event.preventDefault();
      void uploadFiles(images);
    }
  }

  // A Ctrl/Cmd+V paste while focus is on the chat area (not a text field) routes into the
  // composer, as if the field were focused: pasted text is inserted at the caret, a pasted
  // image is attached. Pastes that target an editable element (our own textarea, a dialog's
  // field) are left alone — the textarea handles its own onpaste, and dialogs handle theirs.
  $effect(() => {
    const onWindowPaste = (event: ClipboardEvent) => {
      if (disabled || !event.clipboardData) return;
      const t = event.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(?:input|textarea|select)$/i.test(t.tagName))) return;
      const images = imagesFromClipboard(event.clipboardData);
      if (images.length > 0) {
        if (!upload) return;
        event.preventDefault();
        void uploadFiles(images);
        return;
      }
      const pasted = event.clipboardData.getData('text');
      if (pasted) {
        event.preventDefault();
        void insertAtCursor(pasted);
      }
    };
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  });

  async function insertAtCursor(snippet: string) {
    const ta = textarea;
    if (!ta) {
      text += snippet;
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    text = text.slice(0, start) + snippet + text.slice(end);
    await tick();
    const pos = start + snippet.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    autosize();
  }

  // Recompute the inline autocompletes from the text just before a collapsed caret:
  // `:shortcode` (emoji) and `@name` (mentions). Each is anchored to its own trigger
  // token at the caret, so at most one is active; emoji wins the (impossible) tie.
  function updateMenus() {
    const ta = textarea;
    const caret = ta?.selectionStart ?? text.length;
    if (!ta || caret !== (ta.selectionEnd ?? caret)) {
      emojiMenu = null; // no field, or a non-empty selection: not typing a token
      mentionMenu = null;
      return;
    }
    const before = text.slice(0, caret);
    const em = emojiList.length > 0 ? matchEmojiShortcode(before, emojiList) : null;
    emojiMenu = em ? { items: em.items, active: 0, start: em.start } : null;
    const mm = !em && mentionNames.length > 0 ? matchMention(before, mentionNames) : null;
    mentionMenu = mm ? { items: mm.items, active: 0, start: mm.start } : null;
  }

  // Accept the autocomplete entry at `index`: replace the typed `:query` with `:name: `.
  async function acceptEmoji(index: number) {
    const menu = emojiMenu;
    const ta = textarea;
    if (!menu || !ta) return;
    const item = menu.items[index];
    if (!item) return;
    const caret = ta.selectionStart ?? text.length;
    const insert = `:${item[0]}: `;
    text = text.slice(0, menu.start) + insert + text.slice(caret);
    emojiMenu = null;
    await tick();
    const pos = menu.start + insert.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    autosize();
  }

  // Accept the mention entry at `index`: replace the typed `@query` with `@Name `.
  async function acceptMention(index: number) {
    const menu = mentionMenu;
    const ta = textarea;
    if (!menu || !ta) return;
    const name = menu.items[index];
    if (name === undefined) return;
    const caret = ta.selectionStart ?? text.length;
    const insert = `@${name} `;
    text = text.slice(0, menu.start) + insert + text.slice(caret);
    mentionMenu = null;
    await tick();
    const pos = menu.start + insert.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    autosize();
  }

  // Only caret-moving keys need a recompute on keyup; typing already recomputes via oninput.
  function onKeyup(event: KeyboardEvent) {
    if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(event.key)) updateMenus();
  }

  // Keep the highlighted suggestion scrolled into view as Up/Down move it.
  $effect(() => {
    void emojiMenu?.active;
    acList?.querySelector('.emoji-ac-item.active')?.scrollIntoView({ block: 'nearest' });
  });
  $effect(() => {
    void mentionMenu?.active;
    mentionList?.querySelector('.emoji-ac-item.active')?.scrollIntoView({ block: 'nearest' });
  });

  // Grow the textarea to fit its content, capped at 160px (matches the CSS
  // max-height, beyond which it scrolls). Reset to 'auto' first so it can shrink.
  function autosize() {
    if (!textarea) return;
    textarea.style.height = 'auto';
    // scrollHeight excludes the border, but with box-sizing:border-box the height
    // we set IS the border box — so add the vertical border back, otherwise the
    // content is a couple of px too tall for its box and a scrollbar appears even
    // while the field is still auto-expanding.
    const cs = getComputedStyle(textarea);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const full = textarea.scrollHeight + border;
    textarea.style.height = `${Math.min(full, 160)}px`;
    // Only allow scrolling once the content exceeds the cap; below it, keep the
    // scrollbar hidden so the expanding field never flashes one.
    textarea.style.overflowY = full > 160 ? 'auto' : 'hidden';
  }

  function submit() {
    if (!canSend) return;
    const typed = text.trim();
    const urls = attachments.map((a) => a.url).filter((u): u is string => !!u);
    // Image URLs go on their own lines so the renderer turns each into an inline
    // image; the typed text (if any) leads.
    const value = [typed, ...urls].filter((p) => p !== '').join('\n');
    if (value === '') return;
    onsend(value);
    if (typed) history = [...history, typed].slice(-100); // recall text only, not URLs
    historyIndex = -1;
    draft = '';
    text = '';
    for (const a of attachments) URL.revokeObjectURL(a.preview);
    attachments = [];
    queueMicrotask(autosize);
  }

  // After loading a recalled line, resize and drop the caret at the end.
  function caretToEnd() {
    queueMicrotask(() => {
      autosize();
      const ta = textarea;
      if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  // True when the (collapsed) caret sits on the first / last line of the field — the
  // boundary where Up/Down recall history instead of moving between lines.
  function caretOnFirstLine(): boolean {
    const ta = textarea;
    if (!ta || ta.selectionStart !== ta.selectionEnd) return false;
    return !text.slice(0, ta.selectionStart).includes('\n');
  }
  function caretOnLastLine(): boolean {
    const ta = textarea;
    if (!ta || ta.selectionStart !== ta.selectionEnd) return false;
    return !text.slice(ta.selectionStart).includes('\n');
  }

  // Walk sent-message history (terminal-style). Entering recall stashes the in-progress
  // draft; stepping back past the oldest clamps; stepping forward past the newest restores
  // the draft. -1 = the fresh draft line.
  function recall(direction: -1 | 1) {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      if (direction === 1) return; // already on the fresh line
      draft = text; // save what was being typed before walking into history
      historyIndex = history.length - 1;
    } else {
      const next = historyIndex + direction;
      if (next >= history.length) {
        historyIndex = -1;
        text = draft; // back to the fresh line — restore the draft
        caretToEnd();
        return;
      }
      historyIndex = Math.max(next, 0);
    }
    text = history[historyIndex] ?? '';
    caretToEnd();
  }

  function onKeydown(event: KeyboardEvent) {
    // While an autocomplete (emoji or mention) is open it owns the navigation/commit
    // keys, so they move/accept a suggestion instead of submitting or recalling history.
    const menu = emojiMenu ?? mentionMenu;
    if (menu) {
      const len = menu.items.length;
      const set = (active: number) => {
        if (emojiMenu) emojiMenu = { ...emojiMenu, active };
        else if (mentionMenu) mentionMenu = { ...mentionMenu, active };
      };
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        set((menu.active + 1) % len);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        set((menu.active - 1 + len) % len);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (emojiMenu) void acceptEmoji(menu.active);
        else void acceptMention(menu.active);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        emojiMenu = null;
        mentionMenu = null;
        return;
      }
    }
    // Escape clears the draft. (An open autocomplete swallows Escape above, so reaching here
    // means none is open.) Left as a no-op on an already-empty field so Escape isn't captured
    // for nothing.
    if (event.key === 'Escape') {
      if (text.length === 0) return;
      event.preventDefault();
      text = '';
      historyIndex = -1; // abandon any history navigation; back to a fresh line
      draft = '';
      void tick().then(autosize); // shrink the field back to one row
      return;
    }
    // F1–F12 insert the matching macro (only when one is set, so e.g. F5 still
    // refreshes the page when its slot is empty).
    const fkey = /^F([1-9]|1[0-2])$/.exec(event.key);
    if (fkey) {
      const snippet = macros[Number(fkey[1]) - 1];
      if (snippet) {
        event.preventDefault();
        void insertAtCursor(snippet);
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      // Recall when the caret is at the top/bottom edge of the field, so a single-line
      // draft steps through history while a multi-line one still navigates between lines.
    } else if (event.key === 'ArrowUp' && caretOnFirstLine()) {
      event.preventDefault();
      recall(-1);
    } else if (event.key === 'ArrowDown' && historyIndex !== -1 && caretOnLastLine()) {
      event.preventDefault();
      recall(1);
    }
  }
</script>

<div
  class="mara-input"
  class:dragover={dragOver}
  ondrop={onDrop}
  ondragover={onDragOver}
  ondragleave={() => (dragOver = false)}
  role="group"
>
  {#if uploadError}
    <div class="mara-upload-error" role="alert">{uploadError}</div>
  {/if}
  <!-- Attachment tiles: local `preview` stays the thumbnail throughout (no
       re-fetch of the hosted URL); a spinner overlays until the upload resolves. -->
  {#if attachments.length > 0}
    <div class="mara-attachments">
      {#each attachments as att (att.id)}
        <div class="mara-tile" class:uploading={att.url === undefined} title={att.name}>
          <button
            type="button"
            class="open"
            onclick={() => openLightbox(att.url ?? att.preview, att.name)}
            aria-label="Preview {att.name || 'image'}"
          >
            <img src={att.preview} alt={att.name} />
          </button>
          {#if att.url === undefined}
            <span class="spinner" aria-label="Uploading"></span>
          {/if}
          <button
            type="button"
            class="remove"
            onclick={() => removeAttachment(att.id)}
            aria-label="Remove image">×</button
          >
        </div>
      {/each}
    </div>
  {/if}
  <div class="mara-field" style="--mara-actions-pad:{trailingCount * 1.95 + 0.4}rem">
    <textarea
      bind:this={textarea}
      bind:value={text}
      style={inputColor ? `color:${inputColor}` : undefined}
      {placeholder}
      {disabled}
      maxlength={maxLength}
      rows="1"
      onkeydown={onKeydown}
      oninput={() => {
        autosize();
        updateMenus();
      }}
      onkeyup={onKeyup}
      onclick={updateMenus}
      onblur={() => {
        emojiMenu = null;
        mentionMenu = null;
      }}
      onpaste={onPaste}
    ></textarea>
    {#if emojiMenu}
      <ul class="emoji-ac" role="listbox" aria-label="Emoji suggestions" bind:this={acList}>
        {#each emojiMenu.items as [name, url], i (name)}
          <li>
            <button
              type="button"
              class="emoji-ac-item"
              class:active={i === emojiMenu.active}
              role="option"
              aria-selected={i === emojiMenu.active}
              onmousedown={(e) => {
                e.preventDefault(); // keep focus in the field so accepting doesn't blur it
                void acceptEmoji(i);
              }}
              onmouseenter={() => {
                if (emojiMenu) emojiMenu = { ...emojiMenu, active: i };
              }}
            >
              <img src={emojiSrc(url)} alt="" loading="lazy" />
              <span class="emoji-ac-name">:{name}:</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if mentionMenu}
      <ul class="emoji-ac" role="listbox" aria-label="Mention suggestions" bind:this={mentionList}>
        {#each mentionMenu.items as name, i (name)}
          <li>
            <button
              type="button"
              class="emoji-ac-item"
              class:active={i === mentionMenu.active}
              role="option"
              aria-selected={i === mentionMenu.active}
              onmousedown={(e) => {
                e.preventDefault(); // keep focus in the field so accepting doesn't blur it
                void acceptMention(i);
              }}
              onmouseenter={() => {
                if (mentionMenu) mentionMenu = { ...mentionMenu, active: i };
              }}
            >
              <span class="emoji-ac-name">@{name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    <div class="mara-actions">
      {#if upload}
        <button
          type="button"
          class="emoji-btn attach-btn"
          onclick={() => fileInput?.click()}
          aria-label="Attach image"
          title="Attach image"
          {disabled}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </button>
        <input
          class="hidden-file"
          type="file"
          accept="image/*"
          multiple
          bind:this={fileInput}
          onchange={pickFiles}
        />
      {/if}
      {#if emojiList.length > 0}
        <div class="emoji-picker-wrap" bind:this={pickerWrap}>
          <button
            type="button"
            class="emoji-btn"
            onclick={() => (pickerOpen = !pickerOpen)}
            aria-label="Insert emoji"
            aria-expanded={pickerOpen}
            title="Emoji"
            {disabled}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M8 14s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
          </button>
          {#if pickerOpen}
            <div class="emoji-popover" role="listbox" aria-label="Emoji">
              {#each emojiList as [name, url] (name)}
                <button
                  type="button"
                  class="emoji-choice"
                  title={emojiOwners[name]
                    ? `:${name}: · added by ${emojiOwners[name]}`
                    : `:${name}:`}
                  onclick={() => chooseEmoji(name)}
                >
                  <img src={emojiSrc(url)} alt=":{name}:" loading="lazy" />
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <button
        type="button"
        class="send"
        onclick={submit}
        disabled={!canSend}
        aria-label="Send"
        title="Send message"
      >
        <svg
          class="send-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  .mara-input {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem;
    /* Lift the composer above the device's bottom inset (gesture bar / home indicator);
       0 on desktop, so unchanged there. */
    padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
    border-top: 1px solid var(--mara-border, #333);
    /* Opaque so nothing shows through: the composer sits over the message list, and when it
       grows (multi-line input, attachments) an unpainted background would let messages behind
       it bleed through, especially near the top edge. */
    background: var(--mara-bg, #000);
    align-items: flex-end;
  }
  .mara-input.dragover {
    outline: 2px dashed var(--mara-accent, #3b82f6);
    outline-offset: -4px;
    border-radius: 6px;
  }
  .mara-upload-error {
    flex-basis: 100%;
    font-size: 0.8rem;
    color: var(--mara-error, #f87171);
  }
  .mara-attachments {
    flex-basis: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .mara-tile {
    position: relative;
    width: 56px;
    height: 56px;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid var(--mara-border, #333);
    background: rgba(127, 127, 127, 0.12);
  }
  .mara-tile .open {
    all: unset;
    display: block;
    width: 100%;
    height: 100%;
    cursor: zoom-in;
  }
  .mara-tile img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .mara-tile.uploading img {
    opacity: 0.4;
  }
  .mara-tile .remove {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 18px;
    height: 18px;
    padding: 0;
    line-height: 1;
    font-size: 13px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mara-tile .spinner {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 18px;
    height: 18px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: mara-spin 0.7s linear infinite;
  }
  @keyframes mara-spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* The trailing icon buttons (attach, emoji, send), pinned to the field's bottom-right corner
     as it grows; a flex row so they lay out left-to-right regardless of which are shown. */
  .mara-actions {
    position: absolute;
    right: 0.3rem;
    bottom: 0.3rem;
    display: flex;
    align-items: center;
    gap: 0.1rem;
  }
  .hidden-file {
    display: none;
  }
  /* Relative so the emoji popover anchors to this button (not the whole field). */
  .emoji-picker-wrap {
    position: relative;
  }
  .emoji-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.85rem;
    height: 1.85rem;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--mara-fg, #ddd);
    cursor: pointer;
    opacity: 0.6;
    transition:
      background-color 0.15s ease,
      opacity 0.15s ease;
  }
  .emoji-btn:hover:not(:disabled) {
    opacity: 1;
    background: rgba(127, 127, 127, 0.16);
  }
  .emoji-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .emoji-btn svg {
    width: 1.15rem;
    height: 1.15rem;
    display: block;
  }
  .emoji-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    /* Anchored to the button's right edge so it opens leftward into the field, not off the
       right edge of the window. */
    right: 0;
    z-index: 50;
    width: min(280px, 78vw);
    max-height: 220px;
    overflow-y: auto;
    display: grid;
    /* Stretch columns to fill the row (min 2rem each) so there's no ragged empty
       space on the right — fixed-width tracks would leave the leftover width there. */
    grid-template-columns: repeat(auto-fill, minmax(2rem, 1fr));
    gap: 0.2rem;
    padding: 0.4rem;
    background: var(--mara-bg-alt, #252526);
    border: 1px solid var(--mara-border, #333);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .emoji-choice {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Fill the (stretched) grid cell so the hover target has no gaps between cells. */
    width: 100%;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: none;
    cursor: pointer;
  }
  .emoji-choice:hover {
    background: rgba(127, 127, 127, 0.18);
  }
  .emoji-choice img {
    max-width: 1.5rem;
    max-height: 1.5rem;
    object-fit: contain;
  }
  /* `:shortcode` autocomplete menu, floating above the field. */
  .emoji-ac {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    z-index: 60;
    width: min(300px, 100%);
    max-height: 220px;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    background: var(--mara-bg-alt, #252526);
    border: 1px solid var(--mara-border, #333);
    border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .emoji-ac li {
    margin: 0;
  }
  .emoji-ac-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .emoji-ac-item.active {
    background: rgba(127, 127, 127, 0.22);
  }
  .emoji-ac-item img {
    width: 1.4rem;
    height: 1.4rem;
    object-fit: contain;
    flex: none;
  }
  .emoji-ac-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.9;
  }
  .mara-field {
    position: relative;
    flex: 1;
    display: flex;
  }
  textarea {
    flex: 1;
    resize: none;
    font: inherit;
    /* Right padding leaves room for the trailing icon buttons (attach/emoji/send) that sit
       inside the field; sized to how many are shown via --mara-actions-pad. */
    padding: 0.45rem var(--mara-actions-pad, 4.3rem) 0.45rem 0.6rem;
    border-radius: 6px;
    border: 1px solid var(--mara-border, #333);
    background: var(--mara-input-bg, #2a2a2a);
    color: inherit;
    max-height: 160px;
    /* Resting state: no scrollbar. autosize() switches this to `auto` only when
       the content passes the max-height cap. */
    overflow-y: hidden;
  }
  /* Pure icon button living INSIDE the field at the bottom-right corner, so it
     can't drift out of height-sync with the textarea: the field grows, the icon
     stays pinned to the corner. */
  .send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.85rem;
    height: 1.85rem;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--mara-accent, #3b82f6);
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      color 0.15s ease,
      transform 0.06s ease;
  }
  .send-icon {
    width: 1.15rem;
    height: 1.15rem;
    display: block;
    /* The paper plane's mass sits low-left; nudge it to look optically centered. */
    transform: translate(-1px, 1px);
  }
  .send:hover:not(:disabled) {
    background: rgba(127, 127, 127, 0.16);
  }
  .send:active:not(:disabled) {
    transform: translateY(1px);
  }
  .send:focus-visible {
    outline: 2px solid var(--mara-accent, #3b82f6);
    outline-offset: 1px;
  }
  .send:disabled {
    /* Muted but still clearly legible — not the very-dim border colour. */
    color: var(--mara-fg, #ddd);
    opacity: 0.5;
    cursor: default;
  }
</style>
