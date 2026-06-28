import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Tauri expects a fixed port and host during dev; harmless for plain web too.
const host = process.env.TAURI_DEV_HOST;
// Where the Mara server runs during dev, so we can proxy the WebSocket to it.
const serverPort = process.env.MARA_PORT ?? '5050';

// Build identity, stamped once per build (or dev start). `version` is the package
// semver; `buildId` is a timestamp that changes every build, so two builds of the
// same version are distinguishable. Injected into the bundle via `define` AND
// written to dist/version.json so the server knows which web build it is serving
// (it echoes that build id back in `welcome`, letting a stale page flag itself).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const build = { version: pkg.version, buildId: new Date().toISOString() };

// Emit dist/version.json at build time (not in dev) so the server can read it.
const emitVersion = (): Plugin => ({
  name: 'mara-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(build) });
  },
});

export default defineConfig({
  define: { __MARA_BUILD__: JSON.stringify(build) },
  plugins: [svelte(), emitVersion()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    // In dev (HMR), forward the server-owned routes to the Mara server so the
    // client can use same-origin URLs in every environment: the WebSocket, the
    // image upload endpoint, and the served upload files. (`/upload` also covers
    // `/uploads/...` by prefix, but both are listed for clarity.)
    proxy: {
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      '/info': `http://localhost:${serverPort}`,
      '/upload': `http://localhost:${serverPort}`,
      '/uploads': `http://localhost:${serverPort}`,
    },
  },
  // Produce a relative-path build so it works both as a hosted SPA and inside Tauri.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
