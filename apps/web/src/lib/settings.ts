/** User-facing client settings, persisted to localStorage (or Tauri store later). */
export interface MaraSettings {
  serverUrl: string;
  name: string;
  color: string;
  fontFamily: string;
  fontSize: number;
  showTimestamps: boolean;
}

const KEY = 'mara3.settings';

export const defaultSettings: MaraSettings = {
  serverUrl: 'ws://localhost:5050',
  name: '',
  color: '#7aa2f7',
  fontFamily: 'Verdana',
  fontSize: 10,
  showTimestamps: true,
};

export function loadSettings(): MaraSettings {
  if (typeof localStorage === 'undefined') return { ...defaultSettings };
  try {
    const raw = localStorage.getItem(KEY);
    return raw
      ? { ...defaultSettings, ...(JSON.parse(raw) as Partial<MaraSettings>) }
      : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
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
