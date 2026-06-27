# Mara 3

A self-hosted, account-less chat application. A single Node server hosts **both**
the web UI and the WebSocket on one port, so the whole app is just a URL — open it
in a browser, or run the portable desktop client that loads the same server-hosted
UI. It's a ground-up TypeScript reimplementation of the original Qt4/C++ *Mara 2*;
the wire protocol is clean JSON-over-WebSocket (deliberately not compatible with the
old Qt protocol). One shared `@mara/protocol` package is the single source of truth
for the wire format used by both server and clients.

## What it does

- **Channels** — auto-joined "Main"; join more with `+`; collapsible sidebar; unread
  highlighting (PMs stronger); join/leave/disconnect system lines.
- **Private messages** — a tab per peer, closable; threads survive a reconnect (they
  migrate to the peer's new token by name).
- **Rich text** — Discord-style markdown (bold, italic, underline, strikethrough,
  spoiler), code blocks, optional emoticons, and inline images from URLs (click to
  lightbox, hide/restore).
- **Image uploads** — server temp-stores with per-file and rolling-cache size caps;
  `/upload` requires a WS session token; SVG rejected; served with `nosniff` + a
  sandbox CSP.
- **Persistent identity** — a client-chosen identity key maps to a stable server
  token, so reconnects and restarts keep your identity; message history is persisted
  and replayed on join.
- **Reconnect UX** — auto-connect on load; drops/recoveries noted in chat; always-on
  timestamps; component version display + stale-client detection.
- **Theme** — System / Dark / Light.

## Stack

| Layer         | Tech                                      |
| ------------- | ----------------------------------------- |
| UI            | Svelte 5 + Vite (TypeScript)              |
| Desktop shell | Tauri 2 (single portable `.exe`)          |
| Windows 7     | Tauri 1 (separate legacy client)          |
| Server        | Node ≥20 + TypeScript (`ws`, `node:http`) |
| Protocol      | JSON over WebSocket, validated with Zod   |
| Monorepo      | pnpm workspaces + Turborepo, Vitest       |

## Layout

```
packages/
  protocol/      @mara/protocol      wire format (Zod) — shared by server + clients
  client-core/   @mara/client-core   WebSocket client, session, channels, PMs
  chat-render/   @mara/chat-render   message text → safe HTML
  plugin-api/    @mara/plugin-api    client text plugins (/me, /away, /shrug, …)
  ui/            @mara/ui            shared Svelte components (consumed as source)
apps/
  server/        @mara/server        Node WebSocket + HTTP server (hosts the web UI)
  web/           @mara/web           Svelte web client (the UI; also what the shell loads)
  shell/         @mara/shell         Tauri 2 desktop shell (server picker + portable settings)
  client-legacy/ @mara/client-legacy Tauri 1 Windows 7 client
```

## Develop

```bash
pnpm install
pnpm build        # build all packages (topologically) + the web client
pnpm test         # run all tests (Vitest)
pnpm typecheck    # type-check everything
pnpm dev          # run dev servers (web + server) with hot reload
```

### Run it (single port — the server hosts the web UI)

```bash
pnpm start          # builds the web client, then runs the server that hosts it
# → open http://localhost:5050
```

On Windows you can double-click **start.bat**. The WebSocket lives at `/ws` on the
same origin, so the client connects with no configuration. Set `MARA_PORT` to change
the port.

### Hot-reload (two ports)

For fast frontend iteration, run the server and the Vite dev server separately; Vite
proxies `/ws` to the server so the app behaves identically:

```bash
pnpm --filter @mara/server dev    # server on :5050
pnpm --filter @mara/web dev       # Vite HMR on :5173, open http://localhost:5173
```

(Or **dev.bat** on Windows.)

### Desktop client (Tauri — needs the Rust toolchain)

```bash
pnpm --filter @mara/shell tauri:dev      # native window loading the server's UI
pnpm --filter @mara/shell tauri:build    # single portable .exe (no installer)
```

The desktop client is a thin shell that loads the server's hosted UI; it has an
in-app server picker and stores its settings next to the exe (portable). It's the
only piece that needs Rust. See [apps/shell/README.md](apps/shell/README.md) for
prerequisites and the `MARA_URL` seed, and
[apps/client-legacy/README.md](apps/client-legacy/README.md) for the Windows 7 build.

## Package distributables

Build for distribution into `dist/`:

```bash
pnpm package        # self-contained server + web build + desktop client (if Rust present)
pnpm package:legacy # Windows 7 client (Tauri 1; needs the WebView2 fixed runtime)
pnpm package:zip    # zip everything in dist/ into version-stamped archives
pnpm package:all    # package + package:legacy + zip, in one go
```

```
dist/
  server/          self-contained server — bundled node.exe + server + web build.
                   Copy the folder anywhere and run Mara3-Server.bat; nothing to install.
  web/             the raw web build, for hosting on your own server/CDN.
  desktop/         Mara3-Desktop.exe — portable client (no installer), if Rust is present.
  desktop-legacy/  Mara3-Legacy.exe + WebView2 runtime — the Windows 7 client.
  zips/            a version-stamped .zip per component, each with a BUILD-INFO
                   manifest, plus a top-level manifest.json and SHA256SUMS.txt.
```

On Windows, **package.bat** / **package-all.bat** wrap these. Flags:
`package.bat --skip-tests --skip-desktop`; the desktop step is skipped automatically
when Rust isn't present. The build produces a standalone `.exe` (the installer
bundler is disabled — no MSI/NSIS to sign or run).

## Tests

`pnpm test` runs the Vitest suites across the protocol, server, client-core,
chat-render, web, and plugin-api packages.

## Security

The communication and HTML-rendering paths have had a security pass: Zod validation
of every frame in both directions, HTML escaping of all user-controlled fields,
upload hardening, a WS session token required for `/upload`, and payload caps. Note
that the server speaks plaintext `ws://`/`http://` by default — traffic, including
private messages, is readable by a network observer unless you run it behind a
TLS-terminating reverse proxy. See [SECURITY-TODO.md](SECURITY-TODO.md) for the
threat model and open items.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together.
- [PROTOCOL.md](PROTOCOL.md) — the JSON-over-WebSocket wire format.
- [SECURITY-TODO.md](SECURITY-TODO.md) — threat model and security backlog.

## License

MIT — see [LICENSE](LICENSE).
