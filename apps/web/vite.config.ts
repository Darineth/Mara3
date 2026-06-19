import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Tauri expects a fixed port and host during dev; harmless for plain web too.
const host = process.env.TAURI_DEV_HOST;
// Where the Mara server runs during dev, so we can proxy the WebSocket to it.
const serverPort = process.env.MARA_PORT ?? '5050';

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    // In dev (HMR), forward the WebSocket endpoint to the Mara server so the
    // client can use a same-origin `/ws` URL in every environment.
    proxy: {
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  // Produce a relative-path build so it works both as a hosted SPA and inside Tauri.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
