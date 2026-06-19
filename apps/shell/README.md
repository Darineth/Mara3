# @mara/shell — thin Tauri 2 desktop client

A **thin native shell**: instead of bundling the web UI, it opens a native window
pointed at the Mara server's **hosted** web UI, and exposes a small set of native
client functions to that page (currently: local file logging). Because the window
navigates to the server's own URL, the web app is same-origin again and connects
to `/ws` with no configuration.

```
┌─────────────── Tauri window ───────────────┐
│  loads  http://<your-server>:5050  (remote) │
│  page calls  invoke('mara_log', …)  ───────┐│
└────────────────────────────────────────────┘│
                          native command writes ▼  app log dir / mara.log
```

## Prerequisites

- **Rust** toolchain (`rustup`, stable ≥ 1.77) — <https://rustup.rs>
- Windows: MS C++ Build Tools + WebView2 (preinstalled on Win 11)
- macOS: Xcode CLT · Linux: `webkit2gtk-4.1`, `librsvg`, `patchelf`
- Mobile: Xcode (iOS) / Android Studio + NDK

> The JS/TS packages and the web client build and test **without** Rust. This
> shell is the only piece that needs it.

## Which server it loads

Set with the `MARA_URL` environment variable; defaults to `http://localhost:5050`.

```bash
# point the desktop client at a specific server
set MARA_URL=http://chat.example.com:5050   # Windows
export MARA_URL=http://chat.example.com:5050 # macOS/Linux
pnpm --filter @mara/shell tauri:dev
```

## Run / build

```bash
# dev (a Mara server must be reachable at MARA_URL)
pnpm --filter @mara/shell tauri:dev
# packaged installers in src-tauri/target
pnpm --filter @mara/shell tauri:build
```

There is **no `beforeBuildCommand`** — the shell no longer bundles the web app, so
it builds independently of `@mara/web`.

## Native logging

`mara_log(line)` (in `src-tauri/src/lib.rs`) appends to `mara.log` in the OS app
log directory. The hosted web UI calls it via `apps/web/src/lib/native.ts`
(`nativeLog`), but only when running inside this shell — in a plain browser it is a
no-op, so the same web build works everywhere. Add further native functions the
same way: a `#[tauri::command]` in `lib.rs` + a wrapper in `native.ts`.

## Security — important

A thin client that loads **remote** content and grants it **native** capabilities
trusts that server. IPC access for the remote page is gated by
`src-tauri/capabilities/default.json` → `remote.urls`, which defaults to
**localhost only**. To use a remote/LAN server, add its origin there (e.g.
`"http://chat.example.com:5050"`) and rebuild. Keep this list to servers you trust;
do not widen it to `http://*`.

## Status

Compiles against Tauri 2. The remote-page → native-command (IPC + capabilities)
path is configured per Tauri 2 docs but has **not** been runtime-verified in this
environment — confirm it on a real machine on first run, adjusting `remote.urls`
to your server's origin. Mobile (iOS/Android) remains scaffolded; needs the mobile
SDKs.
