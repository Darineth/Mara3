import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Tauri expects a fixed port and host during dev; harmless for plain web too.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
  },
  // Produce a relative-path build so it works both as a hosted SPA and inside Tauri.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
