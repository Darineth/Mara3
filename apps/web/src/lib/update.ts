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
 * host), so the host must serve `latest.json` with `Access-Control-Allow-Origin: *`
 * (or this origin). Without it the fetch fails and the banner simply never shows.
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

/** Read the shell-injected update context, or null in a plain browser. */
export function updateConfig(): UpdateConfig | null {
  const g = globalThis as { __MARA_UPDATE__?: Partial<UpdateConfig> };
  const cfg = g.__MARA_UPDATE__;
  if (!cfg || typeof cfg.current !== 'string' || typeof cfg.manifestUrl !== 'string') return null;
  return { current: cfg.current, manifestUrl: cfg.manifestUrl };
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
 * Fetch the configured manifest and return the newer build if one exists, else null.
 * Never throws — any non-shell context, missing config, network/parse failure, or
 * not-newer version resolves to null so the caller can ignore it.
 */
export async function checkDesktopUpdate(): Promise<AvailableUpdate | null> {
  const cfg = updateConfig();
  if (!cfg || !cfg.manifestUrl) return null;
  let manifest: UpdateManifest;
  try {
    const res = await fetch(cfg.manifestUrl, { cache: 'no-store' });
    if (!res.ok) return null;
    manifest = (await res.json()) as UpdateManifest;
  } catch {
    return null;
  }
  if (!manifest || typeof manifest.version !== 'string') return null;
  if (cmpVersion(manifest.version, cfg.current) <= 0) return null;
  const url =
    typeof manifest.url === 'string' && /^https?:\/\//i.test(manifest.url) ? manifest.url : '';
  const notes = typeof manifest.notes === 'string' ? manifest.notes : '';
  return { version: manifest.version, url, notes };
}

/** Open an available update's download URL in the system browser. */
export function downloadUpdate(update: AvailableUpdate): void {
  if (update.url) void openExternal(update.url);
}
