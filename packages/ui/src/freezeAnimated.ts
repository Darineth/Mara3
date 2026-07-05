/**
 * Pause animated chat images and custom emoji after a short play window, and replay them on
 * hover — so a wall of animated emoji/GIFs settles down instead of looping forever.
 *
 * There's no native "pause" for animated image formats, so freezing means capturing the
 * currently-shown frame to a <canvas>, dropping it in the image's place, and hiding the <img>
 * (which stops it painting). Replaying just removes the canvas and shows the <img> again (the
 * browser restarts/resumes its animation). The canvas inherits the image's class, so it keeps
 * the exact box + styling — no layout shift.
 *
 * Wire it to a container of rendered chat lines with {@link freezeAnimatedImages}; it tracks
 * images added/removed later (new messages) via a MutationObserver.
 */

/** How long an animated image plays — from first appearance, and again from each hover — before
 *  it freezes. */
const PLAY_MS = 10_000;

/** Formats that CAN be animated. JPEG/BMP/SVG are always static and skipped outright. */
const ANIMATABLE_EXT = /\.(?:gif|webp|png|apng|avif)(?:$|[?#])/i;

/** Classify by extension: a GIF is assumed animated (a static GIF is rare and freezing it is a
 *  harmless no-op); webp/png/avif are commonly static, so they need a runtime check; anything
 *  else is static. */
export function candidateKind(src: string): 'gif' | 'check' | 'no' {
  if (/\.gif(?:$|[?#])/i.test(src)) return 'gif';
  return ANIMATABLE_EXT.test(src) ? 'check' : 'no';
}

/** Cheap runtime animation test: draw two frames ~150 ms apart and compare pixels. A
 *  cross-origin image taints the canvas (readback throws) — assume those are animated, since we
 *  can't tell and freezing a static one is harmless. */
async function isAnimated(img: HTMLImageElement): Promise<boolean> {
  const w = Math.min(24, img.naturalWidth || 24);
  const h = Math.min(24, img.naturalHeight || 24);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return true;
  const grab = (): Uint8ClampedArray | null => {
    try {
      ctx.drawImage(img, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    } catch {
      return null; // tainted (cross-origin)
    }
  };
  const a = grab();
  if (a === null) return true;
  await new Promise((r) => setTimeout(r, 150));
  const b = grab();
  if (b === null) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return true;
  return false;
}

/** Owns the play/freeze lifecycle for one animated image. */
class Freezer {
  private canvas: HTMLCanvasElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly img: HTMLImageElement,
    private readonly playMs: number,
    private readonly onDisposed: (f: Freezer) => void,
  ) {
    this.play();
  }

  /** Show the (animating) image and arm the freeze timer. */
  private play = (): void => {
    clearTimeout(this.timer);
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    this.img.style.display = '';
    this.timer = setTimeout(this.freeze, this.playMs);
  };

  /** Capture the current frame and swap the image out for it. */
  private freeze = (): void => {
    const rect = this.img.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      // Not laid out yet (e.g. inside a collapsed spoiler) — try again later.
      this.timer = setTimeout(this.freeze, this.playMs);
      return;
    }
    const canvas = document.createElement('canvas');
    // Intrinsic size = the image's natural size, and NO CSS width/height pinning. The shared
    // class (`.mara-emoji` height:1.4em / `.mara-img` max-width, both with the same aspect
    // ratio) then sizes the canvas EXACTLY like the <img> — so its box matches to the sub-pixel
    // and the surrounding chat doesn't shift on freeze/replay.
    canvas.width = this.img.naturalWidth || Math.max(1, Math.round(rect.width));
    canvas.height = this.img.naturalHeight || Math.max(1, Math.round(rect.height));
    canvas.className = this.img.className; // inherit .mara-emoji / .mara-img sizing + cursor
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(this.img, 0, 0, canvas.width, canvas.height);
    } catch {
      return; // shouldn't happen (display only), but never break rendering
    }
    canvas.addEventListener('mouseenter', this.play);
    canvas.addEventListener('click', this.onCanvasClick);
    this.img.after(canvas);
    this.img.style.display = 'none';
    this.canvas = canvas;
  };

  /** A click on the frozen frame should still open the lightbox: re-show the image and forward
   *  the click so ChatView's existing image/emoji click handler fires. */
  private onCanvasClick = (): void => {
    this.play();
    this.img.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  };

  dispose(): void {
    clearTimeout(this.timer);
    this.canvas?.remove();
    this.canvas = null;
    this.img.style.display = '';
    this.onDisposed(this);
  }
}

/**
 * Start pausing/replaying animated images within `root` (a chat-line container). Returns a
 * cleanup function that stops observing and un-freezes everything.
 */
export function freezeAnimatedImages(root: HTMLElement, playMs: number = PLAY_MS): () => void {
  const SELECTOR = 'img.mara-emoji, img.mara-img';
  const seen = new WeakSet<HTMLImageElement>();
  const byImg = new WeakMap<HTMLImageElement, Freezer>();
  const active = new Set<Freezer>();

  const start = (img: HTMLImageElement) => {
    if (!img.isConnected) return;
    const f = new Freezer(img, playMs, (freezer) => {
      active.delete(freezer);
      byImg.delete(img);
    });
    byImg.set(img, f);
    active.add(f);
  };

  const consider = (img: HTMLImageElement) => {
    if (seen.has(img)) return;
    seen.add(img);
    const kind = candidateKind(img.currentSrc || img.src);
    if (kind === 'no') return;
    const begin = () => {
      if (kind === 'gif') start(img);
      else void isAnimated(img).then((yes) => yes && start(img));
    };
    if (img.complete && img.naturalWidth) begin();
    else img.addEventListener('load', begin, { once: true });
  };

  const imgsIn = (node: Node): HTMLImageElement[] => {
    if (node instanceof HTMLImageElement) return [node];
    if (node instanceof HTMLElement) return [...node.querySelectorAll<HTMLImageElement>('img')];
    return [];
  };

  root.querySelectorAll<HTMLImageElement>(SELECTOR).forEach(consider);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        for (const img of imgsIn(node)) if (img.matches(SELECTOR)) consider(img);
      }
      for (const node of m.removedNodes) {
        for (const img of imgsIn(node)) byImg.get(img)?.dispose();
      }
    }
  });
  observer.observe(root, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
    for (const f of [...active]) f.dispose();
  };
}
