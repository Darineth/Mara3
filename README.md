# Mara 3

Cross-platform chat application. A ground-up TypeScript replatforming of the
original Qt4/C++ **Mara 2** (see `../Mara*` and `../MIGRATION_PLAN.md`).

One web UI serves **desktop, web, and mobile**; one shared protocol package is the
single source of truth for the wire format used by both client and server.

## Stack

| Layer        | Tech                                    |
| ------------ | --------------------------------------- |
| UI           | Svelte 5 + Vite (TypeScript)            |
| Native shell | Tauri 2 (desktop + iOS/Android)         |
| Server       | Node + TypeScript (`ws`)                |
| Protocol     | JSON over WebSocket, validated with Zod |
| Monorepo     | pnpm workspaces + Turborepo             |

## Layout

```
packages/
  protocol/      @mara/protocol      wire format (Zod) — shared by server + clients
  client-core/   @mara/client-core   WebSocket client, session, Svelte stores
  chat-render/   @mara/chat-render   message → HTML
  ui/            @mara/ui            shared Svelte components
apps/
  web/           browser client + Tauri frontend
  server/        Node/TS WebSocket server
  shell/         Tauri 2 native shell (added in Phase 5)
```

## Develop

```bash
pnpm install
pnpm build        # build all packages (topologically)
pnpm test         # run all tests
pnpm typecheck    # type-check everything
pnpm dev          # run dev servers (web + server)
```

### Run it (single port — server hosts the web UI)

The server serves the built web client **and** the WebSocket on one port, so the
whole app is just `http://localhost:5050`:

```bash
pnpm start          # builds the web client, then runs the server that hosts it
# → open http://localhost:5050
```

On Windows you can double-click **start.bat** instead. The WebSocket lives at
`/ws` on the same origin, so the client connects with no configuration.

### Develop with hot-reload (two ports)

For fast frontend iteration, run the server and the Vite dev server separately;
Vite proxies `/ws` through to the server so the app behaves identically:

```bash
pnpm --filter @mara/server dev    # server on :5050
pnpm --filter @mara/web dev       # Vite HMR on :5173, open http://localhost:5173
```

(or **dev.bat** on Windows.)

### Desktop app (Tauri 2 — needs the Rust toolchain)

```bash
pnpm --filter @mara/shell tauri:dev      # native window loading the server's UI
pnpm --filter @mara/shell tauri:build    # installers in apps/shell/src-tauri/target
```

On Windows, **desktop.bat** builds and launches the desktop client for testing —
it starts a local server first (if one isn't already running) since the client is
a thin shell that loads the server's hosted UI. The desktop client is the only
piece that needs Rust. See `apps/shell/README.md` for prerequisites, the
`MARA_URL` setting, and the signed updater.

### Package distributables

Build everything for distribution into `dist/` (double-click **package.bat** on
Windows, or `pnpm package`):

```
dist/
  server/    self-contained server — bundled node.exe + server + web build.
             Copy the folder anywhere and run Mara3-Server.bat; nothing needs to
             be installed. Serves the UI + WebSocket on http://localhost:5050.
  web/       the raw web build, for hosting on your own server/CDN.
  desktop/   Tauri installers (MSI + NSIS) — only if Rust is installed.
```

Flags: `package.bat --skip-tests --skip-desktop`. The desktop step is skipped
automatically when Rust isn't present, and builds **unsigned** installers unless
the updater signing key is available.

## Status

All migration phases (0–7) are implemented — see `../MIGRATION_PLAN.md` for the
roadmap and `PARITY.md` for the feature-by-feature Mara 2 → Mara 3 mapping.

- **Verified:** protocol round-trips, server + client integration tests, the web
  client in a browser (login → join → chat), and a Windows desktop build with a
  signed auto-updater.
- **Pending external toolchains:** macOS/Linux desktop builds and iOS/Android
  (scaffolded; need those hosts/SDKs).

Test suites (80 total): `@mara/protocol` (44), `@mara/server` (13),
`@mara/client-core` (9), `@mara/chat-render` (9), `@mara/plugin-api` (5).

## License

LGPL-2.1-or-later (inherited from Mara 2).
