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

On launch the shell shows a small **server picker** (the bootstrap page): an address
field — prefilled with the last server used and suggesting recent ones — an
**Auto-connect on launch** checkbox, and a Connect button. Auto-connect is **off by
default**, so a fresh install asks you to pick a server first. Tick the box (it
persists) once you've settled on a server you want to stick: then future launches
connect to it automatically when reachable (retrying until it is), and start typing
to choose a different one.

**Switching servers while connected:** the in-app `⋯` menu has a desktop-only
**Switch server…** item that returns you to the picker without quitting.

### Settings file (portable — next to the executable)

The choice is persisted to `settings.json` **in the same folder as the
executable**, so copying the exe's folder carries its configuration along:

```jsonc
// <exe folder>/settings.json
{
  "serverUrl": "http://chat.example.com:5050",
  "recent": ["http://chat.example.com:5050", "http://localhost:5050"],
  "autoConnect": true, // default false; true here = the box was ticked
}
```

Keep the exe somewhere writable (not a read-only install dir) so it can save. The
`MARA_URL` environment variable only **seeds** the default the first time (before any
settings file exists); after that the saved choice wins:

```bash
set MARA_URL=http://chat.example.com:5050     # Windows (first run / no settings yet)
export MARA_URL=http://chat.example.com:5050  # macOS/Linux
pnpm --filter @mara/shell tauri:dev
```

The picker (`bootstrap/index.html`) talks to native commands in `src-tauri/src/lib.rs`:
`get_settings`, `set_server_url`, `set_auto_connect`, `open_app`, and `switch_server`.

> Note: the **Switch server…** menu item invokes a native command from the _loaded
> server's_ page, so it only works for origins the client grants IPC to —
> `localhost`/`127.0.0.1` by default (see `capabilities/default.json` → `remote.urls`).
> For other servers, switch via the launch picker (turn auto-connect off so it always
> appears) or by editing `settings.json`.

## Run / build

```bash
# dev (launches the picker; have a Mara server running to connect to)
pnpm --filter @mara/shell tauri:dev
# build a single portable .exe (no installer)
pnpm --filter @mara/shell tauri:build
```

The bundler is disabled (`bundle.active: false` in `tauri.conf.json`), so the build
produces **one standalone executable** — no MSI/NSIS installer. Find it at:

```
src-tauri/target/release/mara-shell.exe
```

It's self-contained: the icon and the bootstrap page are compiled into the exe, so
you can copy that single file anywhere and double-click it. (It still needs the
system **WebView2** runtime, preinstalled on Windows 11.) `pnpm package` builds the
same exe and copies it out as `dist/desktop/Mara3-Desktop.exe`.

On launch it shows the server picker (above), then connects to the chosen server —
so a Mara server must be reachable at that address.

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
