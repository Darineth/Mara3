/**
 * Desktop client update check. The thin Tauri shell injects `window.__MARA_UPDATE__`
 * (this build's version + the self-hosted manifest URL it was built with) on every
 * page it loads — including this hosted web UI — so the same web app that shows the
 * picker's launch banner can also surface a persistent banner once the shell has
 * navigated past the picker into the live UI.
 *
 * Plain browsers have no `__MARA_UPDATE__` (and nothing to update), so every check
 * here is a safe no-op outside the shell. The check only NOTIFIES — the client stays
 * a portable single exe; the Download link opens the host in the system browser.
 *
 * NOTE: the manifest is fetched cross-origin (this UI's server origin → the update
 * host), so the host MUST serve it with `Access-Control-Allow-Origin: *` (or this
 * origin) — without it the fetch fails and the banner simply never shows. GitHub
 * *release assets* do NOT send CORS, so the default manifest is served from the repo's
 * `updates/` dir via `raw.githubusercontent.com` (which does); a self-hosted manifest
 * must likewise send CORS. The download link inside the manifest points at the release
 * asset (opened in the system browser — no fetch, so CORS doesn't apply there).
 */

import { openExternal } from './native.js';

/** Shell-injected update context. Absent in a plain browser. */
export interface UpdateConfig {
  /** The running desktop client's version (semver, e.g. "3.0.0"). */
  current: string;
  /** Self-hosted `latest.json` URL; empty when the build disabled the check. */
  manifestUrl: string;
}

/** The self-hosted `latest.json` shape (extra fields ignored). */
interface UpdateManifest {
  version: string;
  url?: string;
  notes?: string;
}

/** A newer build the user can download. */
export interface AvailableUpdate {
  version: string;
  /** http(s) download URL, or '' when the manifest didn't supply a usable one. */
  url: string;
  notes: string;
}

/** Outcome of an update check, for reporting "did we check, and what did we find".
 *  `disabled` = not in the desktop shell or the build has no manifest URL. */
export type UpdateStatus =
  | { state: 'disabled' }
  | { state: 'error'; current: string }
  | { state: 'uptodate'; current: string }
  | { state: 'available'; current: string; update: AvailableUpdate };

/** Read the shell-injected update context, or null in a plain browser. */
export function updateConfig(): UpdateConfig | null {
  const g = globalThis as { __MARA_UPDATE__?: Partial<UpdateConfig> };
  const cfg = g.__MARA_UPDATE__;
  if (!cfg || typeof cfg.current !== 'string' || typeof cfg.manifestUrl !== 'string') return null;
  return { current: cfg.current, manifestUrl: cfg.manifestUrl };
}

/** The running desktop client's version, or null in a plain browser. Used for the
 *  titlebar / splash so they show the SHELL's version (not the web build's). */
export function desktopVersion(): string | null {
  return updateConfig()?.current ?? null;
}

/**
 * Numeric dotted-version compare: -1 / 0 / 1 for a < / == / > b. Tolerant of
 * missing/extra segments and non-numeric junk (each treated as 0).
 */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (parseInt(pa[i] ?? '', 10) || 0) - (parseInt(pb[i] ?? '', 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Map a baked manifest URL to a CORS-fetchable one. Clients shipped before the CORS fix baked
 * a GitHub *release-asset* URL (`…/releases/latest/download/latest-*.json`), which sends no CORS
 * headers, so the cross-origin fetch fails and the check silently errors. Rewrite that known
 * pattern to the SAME manifest served from the repo's `updates/` dir via raw.githubusercontent
 * .com (which sends `Access-Control-Allow-Origin: *`). Because this check runs in the web build
 * the client loads from its server — not in the shell binary — an already-installed client
 * starts detecting updates as soon as its server serves a web build with this code, no client
 * rebuild needed. Any other URL (already raw content, or a self-hosted CORS-enabled manifest)
 * passes through unchanged.
 */
export function corsSafeManifestUrl(url: string): string {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/latest\/download\/(latest-[A-Za-z0-9._-]+\.json)$/,
  );
  return m ? `https://raw.githubusercontent.com/${m[1]}/main/updates/${m[2]}` : url;
}

/**
 * Run the update check and report the full outcome (disabled / error / uptodate /
 * available). Never throws — any failure resolves to a status, so callers can show
 * "did we check, and what did we find" rather than only surfacing newer builds.
 */
async function computeStatus(): Promise<UpdateStatus> {
  const cfg = updateConfig();
  if (!cfg || !cfg.manifestUrl) return { state: 'disabled' };
  let manifest: UpdateManifest;
  try {
    const res = await fetch(corsSafeManifestUrl(cfg.manifestUrl), { cache: 'no-store' });
    if (!res.ok) return { state: 'error', current: cfg.current };
    manifest = (await res.json()) as UpdateManifest;
  } catch {
    return { state: 'error', current: cfg.current };
  }
  if (!manifest || typeof manifest.version !== 'string')
    return { state: 'error', current: cfg.current };
  if (cmpVersion(manifest.version, cfg.current) <= 0)
    return { state: 'uptodate', current: cfg.current };
  const url =
    typeof manifest.url === 'string' && /^https?:\/\//i.test(manifest.url) ? manifest.url : '';
  const notes = typeof manifest.notes === 'string' ? manifest.notes : '';
  return {
    state: 'available',
    current: cfg.current,
    update: { version: manifest.version, url, notes },
  };
}

// Memoized: the banner and the in-menu status share one fetch per page load.
let cached: Promise<UpdateStatus> | undefined;
export function getUpdateStatus(): Promise<UpdateStatus> {
  if (!cached) cached = computeStatus();
  return cached;
}

/** Clear the memoized status so the next getUpdateStatus() re-checks (tests/refresh). */
export function resetUpdateStatus(): void {
  cached = undefined;
}

/** Human-readable one-liner for a status, for the picker/menu "update" note. */
export function updateStatusText(s: UpdateStatus): string {
  switch (s.state) {
    case 'disabled':
      return 'Update check off';
    case 'error':
      return 'Update check failed';
    case 'uptodate':
      // The version is already shown next to this (client line / picker meta) — don't repeat it.
      return 'Up to date';
    case 'available':
      return `Update available: v${s.update.version}`;
  }
}

/** Open an available update's download URL in the system browser. */
export function downloadUpdate(update: AvailableUpdate): void {
  if (update.url) void openExternal(update.url);
}
