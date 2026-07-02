# Changelog

All notable changes to Mara 3 are documented here.

## [3.0.5] - 2026-07-02

### Fixed

- Switching between channel/PM tabs now lands on the newest message of the conversation
  you switched to, instead of inheriting the previous tab's scroll position.

## [3.0.4] - 2026-07-02

### Added

- **Shared identity across clients** — your display name and colour now belong to your
  identity (stored with it on the server) rather than to one install, so signing in on
  another client — or a second window — shows the same you everywhere. A new **Identity
  options** panel (hidden by default on the connect screen, and in the in-session Options
  dialog) lets you **copy your identity key** and **import** it on another client to act
  as one shared identity. The key is a bearer secret — anyone who has it can appear as
  you — so it's masked by default with a plain reveal/copy and a password-style warning.
- **Private messages stay in sync across your windows** — a PM you send or receive now
  appears in every window or device you have open under one identity, and its tab opens
  in each, instead of the conversation only living in the window that sent it. Private
  messages remain live-only and are **never stored on the server** (a deliberate privacy
  choice), so a client that was offline when a PM was sent won't receive it after the fact.
- **Scroll-back history** — the server retains more messages per channel (default 1000)
  and sends only a recent chunk on join; scrolling to the top of a channel pages in
  older messages on demand, keeping your place. Tunable via `MARA_HISTORY_LIMIT`
  (retention) and `MARA_HISTORY_CHUNK` (page size). Messages now carry a stable
  server-assigned id used to order and de-duplicate history.
- **Restart after an OS update** (desktop) — the desktop client registers with the
  Windows Restart Manager, so if it was open when a Windows Update reboot occurs it
  relaunches after you log back in and reconnects to your last server automatically.
- **Taskbar alert for private messages** (desktop) — a private message that arrives
  while the window is in the background now flashes the taskbar button (Windows),
  bounces the dock (macOS), or marks the window urgent (Linux) until you focus it.

### Changed

- The message composer now shows what you type in your own display colour, matching
  how your messages appear in the log.
- The wire protocol was updated for the identity changes, so connecting to this server
  needs an up-to-date client; older clients are automatically prompted to reload/update
  on connect.

## [3.0.3] - 2026-06-30

### Fixed

- Clicking a link in chat now opens it in the system browser on the desktop clients.
  The modern (Tauri 2) client blocked the `target="_blank"` new window, so links did
  nothing there; the app now routes a link click through the native opener instead.

## [3.0.2] - 2026-06-30

### Changed

- Dark theme: the primary background is now solid black, with `#111` for secondary
  surfaces (panels, sidebar, dialogs, the message input, code blocks, and revealed
  spoilers).
- Monospace text (code) now uses the platform default (`ui-monospace, monospace`)
  instead of bundling Cascadia Code / Consolas.

### Fixed

- A soft-wrapped list item no longer splits its list: an indented continuation line
  now folds into its bullet/numbered item instead of ending the list and starting a
  new one at the next marker.

## [3.0.1] - 2026-06-30

### Added

- **`/roll` dice** — roll D&D-style dice with `/roll [p][-]NdM[±K]`: `p` keeps the
  result private, `-` shows each die, and an optional `±K` modifier adjusts the total.
  Public rolls emote the result to the channel.

### Changed

- Darkened the dark theme's background to a deeper near-black.

### Fixed

- Pasting an image and pressing Enter no longer discards it: a bare upload path
  (`/uploads/…`) is now sent as a message instead of being mistaken for an unknown
  slash command and swallowed.
- Your own outgoing private messages are now written to the desktop client's local
  chat log — previously only the other participant's lines were logged, because the
  server never echoes a sent PM back to its sender.
- The message-of-the-day no longer appears at the top of private-message threads; it
  stays a channel greeting.
- Clicking an inline image no longer also opens it in the system browser on the Win7
  desktop client — a plain click just opens the in-app lightbox. (The image link
  dropped `target="_blank"`, which that client's older WebView2 opened externally even
  though the click was handled in-app.)

## [3.0.0] - 2026-06-30

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
  marker. Legacy Mara 2 BBCode tags (`[img]`, `[spoiler]`, `[b]`, `[i]`, `[u]`, `[s]`)
  are also recognized for backwards compatibility.
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
- **Server configuration** — every setting (port, host, server name, MOTD, WebSocket
  path, upload caps, history limit, ...) is read from `MARA_*` environment variables,
  and the portable bundle also reads an optional `mara.config` file next to the
  launcher. Precedence is defaults < `mara.config` < environment; only `MARA_*` keys
  are honored. The bundle ships a commented `mara.config.example`.
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

[Unreleased]: https://github.com/Darineth/Mara3/compare/v3.0.4...HEAD
[3.0.4]: https://github.com/Darineth/Mara3/compare/v3.0.3...v3.0.4
[3.0.3]: https://github.com/Darineth/Mara3/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/Darineth/Mara3/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/Darineth/Mara3/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/Darineth/Mara3/releases/tag/v3.0.0
