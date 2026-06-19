// Single app-wide lightbox: a shared store so any component (chat images, input
// attachment tiles) can open the one full-screen preview, and the Lightbox
// component renders whatever is set.
import { writable } from 'svelte/store';

/** The image currently shown in the full-screen lightbox, or null when closed. */
export interface LightboxImage {
  src: string;
  alt: string;
}

export const lightbox = writable<LightboxImage | null>(null);

/** Show `src` in the full-screen lightbox. */
export function openLightbox(src: string, alt = ''): void {
  lightbox.set({ src, alt });
}

/** Dismiss the lightbox. */
export function closeLightbox(): void {
  lightbox.set(null);
}

// Used when an attachment is removed: if its (object-URL or hosted) src is the
// one currently previewed, close so we don't leave a dangling/revoked image up.
/** Close the lightbox if it is currently showing one of the given sources. */
export function closeLightboxFor(srcs: string[]): void {
  lightbox.update((cur) => (cur && srcs.includes(cur.src) ? null : cur));
}
