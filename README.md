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

### Run the web client + server together

```bash
pnpm --filter @mara/server dev    # ws server on :5050
pnpm --filter @mara/web dev       # web client on :5173, open http://localhost:5173
```

### Desktop app (Tauri 2 — needs the Rust toolchain)

```bash
pnpm --filter @mara/shell tauri:dev      # native window over the web UI
pnpm --filter @mara/shell tauri:build    # installers in apps/shell/src-tauri/target
```

See `apps/shell/README.md` for desktop/mobile prerequisites and the signed updater.

## Status

All migration phases (0–7) are implemented — see `../MIGRATION_PLAN.md` for the
roadmap and `PARITY.md` for the feature-by-feature Mara 2 → Mara 3 mapping.

- **Verified:** protocol round-trips, server + client integration tests, the web
  client in a browser (login → join → chat), and a Windows desktop build with a
  signed auto-updater.
- **Pending external toolchains:** macOS/Linux desktop builds and iOS/Android
  (scaffolded; need those hosts/SDKs).

Test suites (78 total): `@mara/protocol` (44), `@mara/server` (11),
`@mara/client-core` (9), `@mara/chat-render` (9), `@mara/plugin-api` (5).

## License

LGPL-2.1-or-later (inherited from Mara 2).
