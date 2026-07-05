// @mara/ui — shared Svelte components for Mara clients.
export { default as ChatView } from './ChatView.svelte';
export { default as ChatInput } from './ChatInput.svelte';
export { default as UserList } from './UserList.svelte';
export { default as Lightbox } from './Lightbox.svelte';
export { openLightbox, closeLightbox, lightbox } from './lightbox.js';
// Re-exported so app code can render the same monogram-avatar initial (e.g. a profile preview).
export { monogramInitial } from '@mara/chat-render';
// Resolve a stored emoji URL to a subpath-safe `<img src>` (shared with the picker/renderer).
export { emojiSrc } from './emojiComplete.js';
