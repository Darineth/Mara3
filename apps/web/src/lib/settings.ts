/** Number of macro slots (F1–F12). */
export const MACRO_COUNT = 12;

/** Colour theme: follow the OS, or force dark/light. "system" can't be expressed
 *  on some platforms (e.g. Windows 7), where it resolves to dark. */
export type Theme = 'system' | 'dark' | 'light';

/** User-facing client settings, persisted to localStorage (or Tauri store later). */
export interface MaraSettings {
  name: string;
  color: string;
  /** Dark/light theme (or follow the OS). */
  theme: Theme;
  /** Quick-text macros, indexed 0–11 for F1–F12. */
  macros: string[];
  /**
   * Stable per-client identity secret, generated once and persisted. Sent on
   * login so the server keeps handing this client the same user token across
   * reconnects and restarts.
   */
  identityKey: string;
  /** Channel names the user was in, persisted so a fresh session rejoins them
   *  (seeded into the client as `initialChannels`). */
  channels: string[];
}

const KEY = 'mara3.settings';

/** Longest identity key we accept, matching the wire's login `identityKey` bound. */
export const IDENTITY_KEY_MAX = 128;

/** Whether a pasted string is acceptable to import as an identity key: 1–128 chars
 *  once trimmed (the same bound the server validates on login). */
export function isValidIdentityKey(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length >= 1 && trimmed.length <= IDENTITY_KEY_MAX;
}

/** Generate a fresh identity secret (random; persisted for the life of the install). */
function newIdentityKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Default text for the F1 slot; the rest start empty. */
const DEFAULT_F1_MACRO = 'Mara 3: Who even presses F1 anymore?  Seriously.';

/** A fresh default macro set: F1 pre-filled, the rest blank. */
function defaultMacros(): string[] {
  const macros = Array.from({ length: MACRO_COUNT }, () => '');
  macros[0] = DEFAULT_F1_MACRO;
  return macros;
}

/** Coerce stored macros to exactly MACRO_COUNT string entries. A user who has never had
 *  a macros array gets the defaults (F1 pre-filled); a saved array is kept verbatim, so a
 *  slot the user cleared stays cleared. */
function normalizeMacros(value: unknown): string[] {
  if (!Array.isArray(value)) return defaultMacros();
  return Array.from({ length: MACRO_COUNT }, (_, i) =>
    typeof value[i] === 'string' ? (value[i] as string) : '',
  );
}

/** Coerce stored channels to a fresh array of (non-empty) string names. */
function normalizeChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is string => typeof c === 'string' && c.length > 0);
}

/**
 * The WebSocket URL to connect to. When the page is served by the Mara server
 * (the normal case), that is the `ws` endpoint resolved relative to the page's
 * base URL — so it works whether the app is hosted at the domain root or under a
 * subpath (e.g. `https://host/mara/` → `wss://host/mara/ws`). A subpath deployment
 * must be served with a trailing slash, as is standard. In Vite dev (port 5173)
 * the dev server proxies `/ws` through to the real server. The localhost fallback
 * covers non-HTTP origins (e.g. a Tauri build pointed at a local server).
 */
export function serverUrl(): string {
  if (typeof document !== 'undefined' && window.location?.protocol.startsWith('http')) {
    // Resolve `ws` against the document base so a subpath prefix is preserved;
    // `new URL` drops a trailing filename (e.g. /mara/index.html → /mara/ws).
    const httpUrl = new URL('ws', document.baseURI);
    const wsProto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${httpUrl.host}${httpUrl.pathname}${httpUrl.search}`;
  }
  return 'ws://localhost:5050/ws';
}

/** Baseline used for first-time visitors and as the merge base for stored settings.
 *  `identityKey` is left blank here and minted per-install in {@link loadSettings}. */
export const defaultSettings: MaraSettings = {
  name: '',
  color: '#7aa2f7',
  theme: 'system',
  macros: defaultMacros(),
  identityKey: '',
  channels: [],
};

/** Apply a theme to the document: explicit dark/light set `data-theme` on <html>;
 *  "system" removes it so the stylesheet's prefers-color-scheme query takes over. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

/**
 * Read persisted settings, merged over {@link defaultSettings} so fields added
 * since the user last saved get sane values. Any failure (missing key, bad JSON,
 * no localStorage) falls back to a fresh copy rather than throwing — settings
 * must never block startup.
 */
export function loadSettings(): MaraSettings {
  // Fresh copies clone `macros`/`channels` and mint a new identity key.
  const fresh = (): MaraSettings => ({
    ...defaultSettings,
    macros: defaultMacros(),
    channels: [],
    identityKey: newIdentityKey(),
  });
  if (typeof localStorage === 'undefined') return fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const saved = JSON.parse(raw) as Partial<MaraSettings>;
    return {
      ...defaultSettings,
      ...saved,
      macros: normalizeMacros(saved.macros),
      channels: normalizeChannels(saved.channels),
      // Keep the stored key; mint one for installs from before this field existed.
      identityKey: saved.identityKey || newIdentityKey(),
    };
  } catch {
    return fresh();
  }
}

/** Persist settings; swallows quota/privacy-mode errors so a failed write is never fatal. */
export function saveSettings(settings: MaraSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
