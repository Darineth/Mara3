/** Number of macro slots (F1–F12). */
export const MACRO_COUNT = 12;

/** User-facing client settings, persisted to localStorage (or Tauri store later). */
export interface MaraSettings {
  name: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  showTimestamps: boolean;
  /** Quick-text macros, indexed 0–11 for F1–F12. */
  macros: string[];
}

const KEY = 'mara3.settings';

/** Coerce stored macros to exactly MACRO_COUNT string entries. */
function normalizeMacros(value: unknown): string[] {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: MACRO_COUNT }, (_, i) =>
    typeof source[i] === 'string' ? (source[i] as string) : '',
  );
}

/**
 * The WebSocket URL to connect to. When the page is served by the Mara server
 * (the normal case), that is the same origin's `/ws` endpoint — so there is
 * nothing to configure. In Vite dev (port 5173) the dev server proxies `/ws`
 * through to the real server. The localhost fallback covers non-HTTP origins
 * (e.g. a future Tauri build pointed at a local server).
 */
export function serverUrl(): string {
  if (typeof window !== 'undefined' && window.location?.protocol.startsWith('http')) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }
  return 'ws://localhost:5050/ws';
}

export const defaultSettings: MaraSettings = {
  name: '',
  color: '#7aa2f7',
  fontFamily: 'Verdana',
  fontSize: 10,
  showTimestamps: true,
  macros: normalizeMacros([]),
};

export function loadSettings(): MaraSettings {
  const fresh = (): MaraSettings => ({ ...defaultSettings, macros: normalizeMacros([]) });
  if (typeof localStorage === 'undefined') return fresh();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const saved = JSON.parse(raw) as Partial<MaraSettings>;
    return { ...defaultSettings, ...saved, macros: normalizeMacros(saved.macros) };
  } catch {
    return fresh();
  }
}

export function saveSettings(settings: MaraSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}
