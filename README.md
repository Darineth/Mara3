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
pnpm --filter @mara/web dev       # web client on :5173
```

## Status

Built phase by phase per `../MIGRATION_PLAN.md`. See that file for the roadmap.

## License

LGPL-2.1-or-later (inherited from Mara 2).
