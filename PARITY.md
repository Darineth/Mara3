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
| Connect / disconnect                 | ✅     | persisted profile; auto-connects on load for returning users   |
| Auto-reconnect + heartbeat           | ✅     | exponential backoff, channel rejoin                            |
| Channels (join/leave, tabs, roster)  | ✅     | tabs hidden when only in the default channel                   |
| Channel chat + emote (`/me`)         | ✅     |                                                                |
| Private messages                     | ✅     | per-peer conversations                                         |
| Away status (`/away`)                | ✅     |                                                                |
| User list with colors + away         | ✅     | click to open PM; names persist after a user leaves            |
| Per-user color                       | ✅     | set on the connect screen (per-user fonts dropped in revamp)   |
| Timestamps (toggle)                  | ✅     | server-stamped, so consistent across clients                   |
| Message history / backlog            | ✅     | server replays recent channel messages on join (in-memory)     |
| Discord-style markdown               | ✅     | bold/italic/underline/strike/spoiler/code                      |
| Emoticons                            | ◻      | implemented but off by default (opt-in via render option)      |
| URL linkification                    | ✅     | safe anchors, HTML-escaped                                     |
| Inline images (by URL)               | ✅     | image URLs render as a clickable thumbnail                     |
| Image upload (drag-drop / paste)     | ✅     | hosted by the server; rolling cache, per-file + total size cap |
| Chat input history (↑/↓)             | ✅     | + autosize, max length                                         |
| Auto-scroll with freeze-on-scroll-up | ✅     |                                                                |
| Macros (F1–F12)                      | ✅     | editor dialog; F-keys insert into the message box              |
| Unread tab indicators                | ✅     | channels semibold; DMs bolder + dot                            |
| Join/leave/disconnect notices        | ✅     | inline system lines                                            |
| Connection drop/recover notices      | ✅     | inline system lines                                            |
| Plugins (3 text hooks)               | ✅     | shrug + censor samples                                         |
| Custom HTML templates                | ◻      | superseded by `@mara/chat-render`                              |
| Server admin window                  | ⬜     | server is headless; optional Svelte dashboard is a future item |

✅ done · ◻ intentionally replaced / optional · ⬜ not yet ported

## Platforms

| Target                | Status                                                                        |
| --------------------- | ----------------------------------------------------------------------------- |
| Web (browser)         | ✅ server-hosted on one port; smoke-tested (login → join → chat)              |
| Desktop Windows       | ✅ thin Tauri shell loads the hosted UI; `tauri build` → exe + MSI + NSIS     |
| Desktop macOS / Linux | ◻ scaffolded; build needs those hosts (Linux: verify WebKitGTK rendering)     |
| iOS / Android         | ◻ scaffolded (lib target, icons, mobile entry point); needs Xcode/Android SDK |

## Known gaps / follow-ups

- File transfers — send/receive arbitrary (non-image) files between users.
  Images now upload via drag-drop/paste to `/upload` (hosted, size-capped,
  rolling cache); generalising this to any file type is the remaining piece.
- Remember joined channels across sessions (rejoin them automatically on login).
- Persist message history across server restarts. Recent per-channel backlog is
  now replayed on join, but it is in-memory only — a restart loses it. (Durable
  storage, and optionally PM history, remain.)
- In-session profile editing (change name / colour without reconnecting); today
  those are set on the connect screen only. (Per-user fonts were dropped.)
- Server admin UI (currently headless) and macOS/Linux + iOS/Android builds
  (need their respective toolchains/hosts).
- Updater endpoints in `tauri.conf.json` are placeholders pending a release host.

## Decided (not gaps)

- Presence is per-channel by design: clients learn users from channel rosters
  (matches Mara 2). A global presence snapshot on login was intentionally skipped.
