// Per-file-card state the message HTML can't carry on its own. The {@html} blocks are
// rebuilt whenever the roster or timestamps change, so anything stamped onto a card's DOM
// node would be wiped; these stores are the durable side, reconciled onto the cards after
// each render (the same reason hidden images are tracked in a set).
import { writable } from 'svelte/store';

/** Hrefs (as written in the card, i.e. base-relative) known to be gone from the server.
 *  Files roll out of the store oldest-first, so a card in old scrollback can outlive its
 *  file. */
export const goneFiles = writable<Set<string>>(new Set());

/** Remember that `url` is no longer available, so every card for it says so. */
export function markFileGone(url: string): void {
  goneFiles.update((set) => (set.has(url) ? set : new Set(set).add(url)));
}

/** Hrefs whose download has just been started, so the card can show it happened. */
export const savingFiles = writable<Set<string>>(new Set());

/** How long a card acknowledges a download. Nothing tells the page when a download
 *  actually finishes, so this is an acknowledgement rather than progress — long enough to
 *  read, short enough not to outstay a small file. */
const SAVING_MS = 4000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Note that a download for `url` has begun.
 *
 * A download can be completely invisible: the Evergreen WebView2 in the modern desktop
 * shell saves straight to the downloads folder with no flyout of its own, so a click with
 * no feedback reads as broken — and gets clicked again, saving the file another time. (The
 * Win7 client's older pinned runtime does show a download UI; this makes the two agree.)
 */
export function markFileSaving(url: string): void {
  clearTimeout(timers.get(url));
  savingFiles.update((set) => (set.has(url) ? set : new Set(set).add(url)));
  timers.set(
    url,
    setTimeout(() => {
      timers.delete(url);
      savingFiles.update((set) => {
        if (!set.has(url)) return set;
        const next = new Set(set);
        next.delete(url);
        return next;
      });
    }, SAVING_MS),
  );
}
