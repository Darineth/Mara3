import { readFileSync } from 'node:fs';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin } from 'vite';

// Tauri expects a fixed port and host during dev; harmless for plain web too.
const host = process.env.TAURI_DEV_HOST;
// Where the Mara server runs during dev, so we can proxy the WebSocket to it.
const serverPort = process.env.MARA_PORT ?? '5050';

// Serve the dev app under a *subpath* rather than the domain root, so any URL that isn't
// correctly page-relative — an upload, avatar, emoji image, or the WebSocket — breaks here in
// dev instead of only in a real subpath deployment (https://host/mara/). Override with
// MARA_DEV_BASE (must start and end with '/'); set '/' to serve at the root. The production
// build is unaffected — it stays base:'./' (relative) for Tauri and hosted use.
const devBase = process.env.MARA_DEV_BASE ?? '/mara/';

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

// Redirect the bare root to the dev subpath so hitting http://localhost:5173/ (bookmark, the
// desktop shell, muscle memory) lands on the app instead of a 404. No-op when devBase is '/'.
const redirectToBase = (base: string): Plugin => ({
  name: 'mara-dev-base-redirect',
  configureServer(server) {
    if (base === '/') return;
    server.middlewares.use((req, res, next) => {
      if (req.url === '/' || req.url === '') {
        res.writeHead(302, { Location: base });
        res.end();
        return;
      }
      next();
    });
  },
});

// The server-owned routes the client reaches; each is proxied to the Mara server, and the dev
// subpath prefix is stripped before forwarding (so `/mara/uploads/x` → `/uploads/x`). `ws` is
// the WebSocket; the rest are plain HTTP. Vite matches by prefix, so `/…/upload` also covers
// `/…/uploads/…`, and `/…/emoji` covers `/…/emoji-upload` — every match strips the same prefix.
const serverRoutes = ['ws', 'info', 'upload', 'uploads', 'avatar', 'avatars', 'emoji'];
const strip = devBase.length - 1; // keep the leading slash: '/mara/ws'.slice(5) === '/ws'
const proxy = Object.fromEntries(
  serverRoutes.map((route) => [
    `${devBase}${route}`,
    {
      target: `${route === 'ws' ? 'ws' : 'http'}://localhost:${serverPort}`,
      ws: route === 'ws',
      rewrite: (path: string) => path.slice(strip),
    },
  ]),
);

export default defineConfig(({ command }) => ({
  // Dev serves under the subpath; the build stays relative for Tauri / hosted subpaths.
  base: command === 'serve' ? devBase : './',
  define: { __MARA_BUILD__: JSON.stringify(build) },
  plugins: [svelte(), emitVersion(), redirectToBase(devBase)],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    proxy,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
