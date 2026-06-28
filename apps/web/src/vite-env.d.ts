/// <reference types="svelte" />
/// <reference types="vite/client" />

/** Build identity injected by Vite `define` (see vite.config.ts). */
declare const __MARA_BUILD__: { version: string; buildId: string };

interface Window {
  /** Desktop-client update context injected by the Tauri shell (see apps/shell);
   *  absent in a plain browser. `current` is the running client version; `manifestUrl`
   *  is the self-hosted latest.json it was built to poll (empty when disabled). */
  __MARA_UPDATE__?: { current: string; manifestUrl: string };
}
