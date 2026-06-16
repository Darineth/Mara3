# Mara 2 → Mara 3 Parity Checklist

Maps the original Qt4/C++ application's capabilities onto the TypeScript rewrite.

## Architecture

| Mara 2 (C++/Qt4)                     | Mara 3 (TypeScript)                    | Status                          |
| ------------------------------------ | -------------------------------------- | ------------------------------- |
| MaraLib (packets, models, settings)  | `@mara/protocol` + `@mara/client-core` | ✅                              |
| `QDataStream` binary wire format     | JSON over WebSocket (Zod-validated)    | ✅ (redesigned)                 |
| MaraClient (QThread networking)      | `@mara/client-core` (async WebSocket)  | ✅                              |
| MaraServer (Qt single-thread server) | `apps/server` (Node event loop)        | ✅                              |
| Mara (Qt Widgets GUI)                | `apps/web` (Svelte 5)                  | ✅                              |
| MChatBrowser (QtWebKit)              | DOM rendering via `@mara/chat-render`  | ✅ (no embedded webview)        |
| MaraPlugin (native C++ DLLs)         | `@mara/plugin-api` (TS modules)        | ✅                              |
| MaraUpdater (custom HTTP/MD5)        | Tauri signed updater + app stores      | ✅ (desktop); mobile via stores |
| Desktop only (Win/Lin/macOS)         | Desktop **+ web + mobile** (Tauri 2)   | ✅ expanded                     |

## Protocol messages (18 original packet types)

All represented in `@mara/protocol` and exercised by round-trip tests:
version handshake, login, user connect/disconnect/update, join/leave channel,
chat, emote, away, private message, ping/pong, kick, server command, query user,
plugin data, response/error. ✅

## Client features

| Feature                              | Status | Notes                                                          |
| ------------------------------------ | ------ | -------------------------------------------------------------- |
| Connect / disconnect                 | ✅     | with persisted server + profile settings                       |
| Auto-reconnect + heartbeat           | ✅     | exponential backoff, channel rejoin                            |
| Channels (join/leave, tabs, roster)  | ✅     |                                                                |
| Channel chat + emote (`/me`)         | ✅     |                                                                |
| Private messages                     | ✅     | per-peer conversations                                         |
| Away status (`/away`)                | ✅     |                                                                |
| User list with colors + away         | ✅     | click to open PM                                               |
| Per-user fonts + colors              | ✅     | font family/size/color in settings                             |
| Timestamps (toggle)                  | ✅     |                                                                |
| Emoticons                            | ✅     | `:) ❤️` etc. in `@mara/chat-render`                            |
| URL linkification                    | ✅     | safe anchors, HTML-escaped                                     |
| Chat input history (↑/↓)             | ✅     | + autosize, max length                                         |
| Auto-scroll with freeze-on-scroll-up | ✅     |                                                                |
| Plugins (3 text hooks)               | ✅     | shrug + censor samples                                         |
| Macros (F1–F12)                      | ⬜     | settings model exists in plan; not yet in UI                   |
| Custom HTML templates                | ◻      | superseded by `@mara/chat-render` (configurable emoticons)     |
| Server admin window                  | ⬜     | server is headless; optional Svelte dashboard is a future item |

✅ done · ◻ intentionally replaced · ⬜ not yet ported

## Platforms

| Target                | Status                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Web (browser)         | ✅ built + smoke-tested (login → join → chat)                                 |
| Desktop Windows       | ✅ `tauri build` → exe + MSI + NSIS installers                                |
| Desktop macOS / Linux | ◻ scaffolded; build needs those hosts (Linux: verify WebKitGTK rendering)     |
| iOS / Android         | ◻ scaffolded (lib target, icons, mobile entry point); needs Xcode/Android SDK |

## Known gaps / follow-ups

- Macros (F1–F12) UI and a richer settings dialog (fonts/templates tabs).
- A newly connected client only learns already-online users via channel rosters
  (matches Mara 2); a presence snapshot on login would be a nice enhancement.
- macOS/Linux desktop and iOS/Android builds need their respective toolchains/hosts.
- Updater endpoints in `tauri.conf.json` are placeholders pending a release host.
