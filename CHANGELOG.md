# Changelog

All notable changes to Mara 3 are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- On release, rename [Unreleased] to [3.0.0] - YYYY-MM-DD and start a fresh
     [Unreleased] section above it. -->

## [Unreleased]

First release of Mara 3 — a self-hosted, account-less chat app. A single Node server
hosts the web UI and the WebSocket on one port; a portable desktop client and a
separate Windows 7 client load the same server-hosted UI. The wire protocol is clean
JSON-over-WebSocket and is deliberately not compatible with the old Qt-era Mara 2.

### Added

- **Channels** — auto-joined "Main", join more with `+`, collapsible sidebar, unread
  highlighting (private messages stronger), and join/leave/disconnect system lines.
- **Private messages** — a closable tab per peer; a thread migrates to the peer's new
  token by name so the conversation survives a reconnect.
- **Rich text** — Discord-style markdown (bold, italic, underline, strikethrough,
  spoiler), code blocks, and optional emoticons. Inline images from URLs render as a
  tile below the message (click to lightbox, hide/restore), detected by file
  extension, a query-declared format (`?format=jpg`, `&fm=png`), or a `!<url>` sender
  marker.
- **Image uploads** — server temp-stores images with per-file and rolling-cache size
  caps; `/upload` requires a WebSocket session token; SVG is rejected; files are
  served with `nosniff` and a sandbox CSP.
- **Persistent identity and history** — a client-chosen identity key maps to a stable
  server token, so identity survives reconnects and restarts; message history is
  persisted and replayed on join; the same user is multiplexed across windows.
- **Reconnect UX** — auto-connect on load, drops and recoveries noted in chat,
  always-on timestamps, component version display, and stale-client detection.
- **Theme** — System / Dark / Light toggle.
- **Desktop client** (Tauri 2) — a single portable `.exe` with an in-app server
  picker, settings stored next to the executable (portable), and opt-in auto-connect.
- **Windows 7 client** (Tauri 1) — a separate legacy target built with a static CRT
  and a bundled WebView2 fixed runtime.
- **Distribution** — `pnpm package`, `package:legacy`, `package:zip`, and
  `package:all` build self-contained server, web, and desktop artifacts into `dist/`,
  and zip each into version-stamped archives carrying a BUILD-INFO manifest, plus a
  top-level manifest and `SHA256SUMS.txt`. The packaged server uses a flat (hoisted)
  `node_modules` so the bundle is portable once extracted.

### Security

- Zod validation of every protocol frame in both directions; malformed frames are
  rejected without dropping the socket.
- The HTML render pipeline escapes all user-controlled fields; URLs are limited to
  `http(s)` and relative `/uploads/` paths, with a documented single-pass restore.
- Upload hardening: SVG rejected, strict filename handling, `nosniff` + sandbox CSP,
  and size caps; `/upload` requires a WS session token; WebSocket payloads are capped.

[Unreleased]: https://github.com/Darineth/Mara3
