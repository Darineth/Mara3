/**
 * Copy text to the clipboard, with a fallback for the case Mara actually runs in.
 *
 * `navigator.clipboard` only exists in a **secure context** — https, or localhost. A Mara server
 * on a LAN is typically plain `http://host:5050`, where the API is simply absent, so relying on
 * it alone would leave the copy button silently dead for most users. The `execCommand('copy')`
 * path is deprecated but has no such requirement and still works everywhere we ship.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or a browser that exposes the API but refuses here — fall through.
    }
  }
  return legacyCopy(text);
}

/** Select-and-copy from an off-screen textarea: the pre-Clipboard-API way, and our insecure-origin path. */
function legacyCopy(text: string): boolean {
  const el = document.createElement('textarea');
  el.value = text;
  // Off-screen but still focusable/selectable — `display: none` or `hidden` would defeat both.
  el.setAttribute('readonly', '');
  el.style.position = 'fixed';
  el.style.top = '-1000px';
  el.style.opacity = '0';
  document.body.appendChild(el);
  try {
    el.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    el.remove();
  }
}
