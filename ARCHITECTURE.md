# Mara 3 — Architecture & Build Guide

A high-level map of every major component: what it is, where it runs, its primary
dependencies, and how to build it. For a quickstart see [README.md](README.md);
for the wire format see [PROTOCOL.md](PROTOCOL.md); for open security work see
[SECURITY-TODO.md](SECURITY-TODO.md).

Mara 3 is a pnpm + Turborepo monorepo. Everything is TypeScript end-to-end, with
one shared protocol package as the single source of truth for the wire format.

## Big picture

```
                     ┌──────────────────────────────────────────────┐
   Web browser ──────┤                                              │
                     │   apps/server  (Node + ws + sirv)            │
   Tauri desktop ────┤   ┌───────────────┐   ┌──────────────────┐   │
   (apps/shell)      │   │ HTTP (sirv)   │   │ WebSocket  /ws    │   │
   loads hosted URL  │   │ • web UI      │   │ • JSON + Zod      │   │
                     │   │ • /upload     │   │ • channels / PMs  │   │
   Mobile (Tauri) ───┤   │ • /uploads/*  │   │ • presence        │   │
                     │   └───────────────┘   └──────────────────┘   │
                     │            one process, one port (5050)       │
                     └──────────────────────────────────────────────┘
```

All clients (web, desktop, mobile) run the **same** Svelte web UI. The server
hosts that built UI over HTTP **and** speaks the WebSocket protocol on the same
port. The Tauri shell is a thin native wrapper that loads the hosted URL and adds
native hooks (e.g. local logging).

## Repository layout

```
packages/
  protocol/      @mara/protocol      wire format (Zod schemas + codec)
  client-core/   @mara/client-core   WebSocket client, session, Svelte stores
  chat-render/   @mara/chat-render   message text → safe HTML
  plugin-api/    @mara/plugin-api    text-pipeline plugin interface + samples
  ui/            @mara/ui            shared Svelte 5 components
apps/
  server/        @mara/server        Node WebSocket + HTTP server
  web/           @mara/web           Svelte 5 + Vite browser app (also the Tauri frontend)
  shell/         @mara/shell         Tauri 2 native shell (desktop + mobile)
scripts/
  package.mjs                        builds the distributables into dist/
*.bat                                Windows convenience launchers
```

## Toolchain / prerequisites

| Tool                    | Version                                  | Needed for                | Install                                                                                              |
| ----------------------- | ---------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| Node.js                 | **≥ 20** (developed on 24)               | everything                | <https://nodejs.org>                                                                                 |
| pnpm                    | **9.15.9** (pinned via `packageManager`) | everything                | `corepack enable` (ships with Node)                                                                  |
| Rust toolchain          | **≥ 1.77**                               | desktop/mobile shell only | <https://rustup.rs>                                                                                  |
| Tauri OS deps           | —                                        | desktop shell             | Windows: MSVC Build Tools + WebView2 runtime · macOS: Xcode CLT · Linux: WebKitGTK + build-essential |
| Xcode / Android SDK+NDK | —                                        | iOS / Android builds      | platform vendors (scaffolded; not yet shipped)                                                       |

TypeScript, Vite, Turborepo, Vitest, Svelte, the Tauri CLI, etc. are all
dev-dependencies installed by `pnpm install` — only Node, pnpm, and (for the
native shell) Rust are external prerequisites.

```bash
corepack enable          # makes the pinned pnpm available
pnpm install             # install all workspace dependencies   (install.bat)
```

## Components

Build order matters: the leaf libraries compile to `dist/`, and the apps consume
those builds. `pnpm build` (Turborepo) runs everything topologically, so you
rarely build a single piece by hand — but each is documented below.

### `@mara/protocol` — wire format · `packages/protocol`

- **Runtime:** runtime-agnostic TypeScript library (used by server in Node and by clients in the browser).
- **Purpose:** the single source of truth for the JSON-over-WebSocket protocol — Zod schemas (`clientMessageSchema` / `serverMessageSchema` discriminated unions), value primitives, and the `encode`/`parse` codec.
- **Primary deps:** `zod`.
- **Build:** `pnpm --filter @mara/protocol build` → `tsc` emits `dist/*.js` + `*.d.ts`.

### `@mara/client-core` — client engine · `packages/client-core`

- **Runtime:** TypeScript library; runs in the browser (global `WebSocket`) and in Node tests (inject `ws`).
- **Purpose:** owns the socket, the login handshake, auto-reconnect/heartbeat, and live Svelte stores (`users`, `channels`, `channelMessages`, `privateMessages`, …).
- **Primary deps:** `@mara/protocol`, `@mara/plugin-api`; **peer** `svelte` (stores); dev: `ws`, `@mara/server` (for integration tests).
- **Build:** `pnpm --filter @mara/client-core build` → `tsc` → `dist/`.

### `@mara/chat-render` — text → HTML · `packages/chat-render`

- **Runtime:** runtime-agnostic TypeScript library.
- **Purpose:** turns raw message text into safe display HTML — escaping, Discord-style markdown, link/inline-image handling. The XSS boundary for chat content.
- **Primary deps:** `@mara/protocol`.
- **Build:** `pnpm --filter @mara/chat-render build` → `tsc` → `dist/`.

### `@mara/plugin-api` — plugin interface · `packages/plugin-api`

- **Runtime:** runtime-agnostic TypeScript library.
- **Purpose:** the text-pipeline plugin contract (pre/post-process hooks) plus sample plugins (shrug, censor). Consumed by `client-core`.
- **Primary deps:** none.
- **Build:** `pnpm --filter @mara/plugin-api build` → `tsc` → `dist/`.

### `@mara/ui` — shared components · `packages/ui`

- **Runtime:** Svelte 5 components.
- **Purpose:** the reusable UI pieces (`ChatView`, `ChatInput`, `UserList`, `Lightbox`).
- **Primary deps:** `@mara/chat-render`, `@mara/client-core`; **peer** `svelte`.
- **Build:** **none** — consumed as Svelte source directly by Vite; its `build` script is a no-op. Type-check with `pnpm --filter @mara/ui typecheck` (`svelte-check`).

### `@mara/server` — the server · `apps/server`

- **Platform/runtime:** Node.js ≥ 20.
- **Purpose:** one process that (a) serves the built web client over HTTP via `sirv`, (b) handles image upload/serve (`/upload`, `/uploads/*`), and (c) runs the WebSocket hub on `/ws` — channels, private messages, presence, all validated by `@mara/protocol`.
- **Primary deps:** `@mara/protocol`, `ws` (WebSocket), `sirv` (static hosting), `pino` (logging); dev: `tsx` (run TS directly), `pino-pretty`.
- **Build / run:**
  - Dev: `pnpm --filter @mara/server dev` (tsx, watch) or `serve` (tsx, once) — **server.bat**.
  - Prod: `pnpm --filter @mara/server build` (`tsc` → `dist/`), then `node dist/main.js`.
- **Config (env):** `MARA_PORT` (5050), `MARA_HOST`, `MARA_WEB_ROOT`, `MARA_WS_PATH` (`/ws`), `MARA_DEFAULT_CHANNEL` (`Main`), `MARA_UPLOAD_DIR` (defaults to `apps/server/uploads`), `MARA_MAX_UPLOAD_MB` (10), `MARA_MAX_CACHE_MB` (512), `MARA_HISTORY_LIMIT` (100), `MARA_HISTORY_FILE` (defaults to `apps/server/data/history.json`; empty disables), `MARA_IDENTITY_FILE` (defaults to `apps/server/data/identity.json`; empty disables — the persistent client-identity → token map).

### `@mara/web` — the UI app · `apps/web`

- **Platform/runtime:** browser (also the frontend the Tauri shell loads).
- **Purpose:** the actual chat application — wires the `@mara/ui` components to a `@mara/client-core` client, connecting to `/ws` on its own origin (no config). Same-origin uploads via `/upload`.
- **Primary deps:** `@mara/{protocol,client-core,plugin-api,ui}`, `svelte`; dev: `vite`, `@sveltejs/vite-plugin-svelte`, `svelte-check`.
- **Build / run:**
  - Dev (HMR, `:5173`, proxies `/ws`): `pnpm --filter @mara/web dev` — **web.bat**.
  - Prod build: `pnpm --filter @mara/web build` (`vite build`) → static `apps/web/dist/` (hashed assets), which the server then hosts.

### `@mara/shell` — native shell · `apps/shell`

- **Platform/runtime:** Tauri 2 — a Rust host wrapping the OS webview (desktop: Windows/macOS/Linux; mobile: iOS/Android, scaffolded).
- **Purpose:** a thin native client that loads a Mara server's hosted URL (`MARA_URL`) and exposes native functions (local logging, an update nudge). It is **not** a second UI — it renders the same web app, so server-side web changes reach every client on the next load with no client rebuild.
- **Primary deps:** JS: `@tauri-apps/api`, `@tauri-apps/plugin-updater`, dev `@tauri-apps/cli`. Rust: `tauri` 2, `tauri-plugin-opener`, `tauri-plugin-updater` (desktop), `serde`/`serde_json`.
- **Update nudge (portable, opt-in):** the client stays a portable single exe and never self-installs. `scripts/package.mjs` bakes `MARA_UPDATE_URL` into the build (derived from one folder URL — `MARA_UPDATE_BASE_URL`, default `https://mara.pretoast.com/mara3-updates`), and `lib.rs` injects `window.__MARA_UPDATE__ = { current, manifestUrl }` on **every** page it loads. Two surfaces read it: the bootstrap picker (`bootstrap/index.html`) shows a banner at launch, and the hosted web UI (`apps/web` `UpdateBanner.svelte` via `lib/update.ts`) shows a persistent one once the shell has navigated past the picker — both fetch the self-hosted `latest.json`, semver-compare `version` to this build's, and on a newer one show a dismissible banner whose Download link opens the host in the system browser (opener plugin, with a new-tab fallback). The web UI dismissal is remembered per version (localStorage); a plain browser has no `__MARA_UPDATE__` so the banner never shows there. The manifest is emitted by `scripts/zip-dist.mjs` (`{ version, url, notes, pub_date, sha256 }`); build with `MARA_UPDATE_URL=` (empty) to disable the check. **The update host must serve the manifest with `Access-Control-Allow-Origin: *`** — both surfaces fetch it cross-origin. The **Win7 legacy client** (`apps/client-legacy`, Tauri 1) has the same nudge, but as a separate download it polls its own manifest — `latest-win7.json` → the `Mara3-Win7` zip (baked by `scripts/package-legacy.mjs`); its picker opens the download via Tauri 1's `shell.open` instead of the opener plugin. Future step (deferred): graduate to Tauri's signed silent installer (keys already in place; see `TODO.md`).
- **Build / run (needs Rust + Tauri OS deps):**
  - Dev: `pnpm --filter @mara/shell tauri:dev` — **desktop.bat** (starts a local server first if none is on `:5050`).
  - Build: `pnpm --filter @mara/shell tauri:build` → a single portable `mara-shell.exe` under `apps/shell/src-tauri/target/release/` (the installer bundler is disabled via `bundle.active: false`; no MSI/NSIS).

## Building everything

```bash
pnpm build        # all packages + apps, in dependency order (Turborepo)   build.bat
pnpm test         # full test suite (Vitest across packages)               test.bat
pnpm typecheck    # type-check every workspace
pnpm lint         # lint/type every workspace
```

### Run it (single port — recommended)

```bash
pnpm start        # builds the web client, then runs the server that hosts it
# → open http://localhost:5050        (start.bat)
```

### Develop with hot reload (two ports)

```bash
pnpm dev          # server (:5050) + Vite dev server (:5173, HMR)            dev.bat
# → open http://localhost:5173
```

## Packaging for distribution

`pnpm package` (or **package.bat**) runs `scripts/package.mjs`, which produces:

```
dist/
  server/    self-contained Node server: a bundled node.exe + the compiled
             server + the web build + Mara3-Server.bat. Needs nothing installed.
  web/       the raw static web build, for hosting elsewhere.
  desktop/   portable Mara3-Desktop.exe — only if the Rust toolchain is present.
```

Flags: `node scripts/package.mjs --skip-tests --skip-desktop`. The server bundle
is created with `pnpm deploy --prod` and ships its own Node runtime, so the
target machine needs nothing pre-installed.

## Versioning & build identity

Every component carries a version so a misbehaving or un-refreshed deployment is
identifiable:

- The **web client** is stamped at build time with `{ version, buildId }` (its
  package version plus a per-build timestamp), injected into the bundle and also
  written to `dist/version.json`. It logs the build to the console on load and
  shows it on the connect screen and in the ⋯ menu.
- The **server** reads its own package version and the `version.json` of the web
  build it serves, logs both on startup, and reports `{ version, protocol, webBuild }`
  to every client in the `welcome` message (see [PROTOCOL.md](PROTOCOL.md)).
- The client compares the server's `webBuild` against its own `buildId`; a
  mismatch means the page is running **stale cached code**, so it shows an
  "Outdated — reload" prompt. This is the common "the client didn't refresh after
  a deploy" case made visible. `protocol` is the wire version (`PROTOCOL_VERSION`).

## At a glance

| Component         | Path                 | Runtime                 | Build command               | Output                        |
| ----------------- | -------------------- | ----------------------- | --------------------------- | ----------------------------- |
| @mara/protocol    | packages/protocol    | TS lib                  | `tsc`                       | `dist/`                       |
| @mara/client-core | packages/client-core | TS lib (browser + Node) | `tsc`                       | `dist/`                       |
| @mara/chat-render | packages/chat-render | TS lib                  | `tsc`                       | `dist/`                       |
| @mara/plugin-api  | packages/plugin-api  | TS lib                  | `tsc`                       | `dist/`                       |
| @mara/ui          | packages/ui          | Svelte 5 source         | _(none — consumed by Vite)_ | —                             |
| @mara/server      | apps/server          | Node ≥ 20               | `tsc`                       | `dist/` + `node dist/main.js` |
| @mara/web         | apps/web             | Browser                 | `vite build`                | static `dist/`                |
| @mara/shell       | apps/shell           | Tauri 2 / Rust          | `tauri build`               | portable .exe (no installer)  |
