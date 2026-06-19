import { writable } from 'svelte/store';

/** The image currently shown in the full-screen lightbox, or null when closed. */
export interface LightboxImage {
  src: string;
  alt: string;
}

export const lightbox = writable<LightboxImage | null>(null);

export function openLightbox(src: string, alt = ''): void {
  lightbox.set({ src, alt });
}

export function closeLightbox(): void {
  lightbox.set(null);
}

/** Close the lightbox if it is currently showing one of the given sources. */
export function closeLightboxFor(srcs: string[]): void {
  lightbox.update((cur) => (cur && srcs.includes(cur.src) ? null : cur));
}
