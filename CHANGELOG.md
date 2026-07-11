# Changelog

All notable changes to Mara 3 are documented here.

## [3.0.25] - unreleased

### Added

- **Replies.** Hover a message and hit the reply arrow to answer it directly: your message
  goes out with a quote bar above it showing **@who** you replied to and a glimpse of what they
  said. Click that bar to jump to the original, which stays highlighted for a couple of seconds
  so you can spot it — and if it's scrolled out of your loaded history, Mara pages older messages
  in to find it (it gives up and says so rather than searching forever, if the message is older
  than the server keeps). Followed a reply chain up? A **Back to reply** button appears to walk
  you back down, one hop at a time — and quietly retires itself if you scroll back down there
  yourself. Clicking Reply puts the cursor straight in the composer,
  which shows a "Replying to @…" chip while one is pending — Escape (or its ×) backs out.
  `/me` replies too. Quotes survive a reload: they're stored with the message, so scrollback
  keeps them. Channel messages only — private messages aren't stored server-side, so there's
  nothing to reply to.

### Changed

- **Messages highlight faintly on hover.** The row under your cursor picks up a very subtle
  tint across the full width of the log, so it's clear which message the reply button belongs to.
- **The Connected notice names the server's version**, so it's obvious at a glance which build
  you're talking to.

## [3.0.24] - 2026-07-09

### Added

- **Very long messages fold up.** A message taller than ~60% of the screen is now collapsed
  with a little pill to expand it (and fold it back), so one giant wall of text can't swallow
  the whole view. The pill is tinted with the sender's colour and carries a flipping chevron —
  and yes, its label is a rotating quip rather than a plain "Show more".

### Changed

- **Longer messages.** The composer now accepts up to 10,000 characters (was 1,000).
- **Escape clears the composer.** Pressing Escape in the message box wipes your draft (it still
  dismisses an open emoji/mention autocomplete first, and does nothing on an empty box).

## [3.0.23] - 2026-07-05

### Added

- **Click an avatar to see it full-size.** Clicking a user's avatar in the message list opens
  it in the image lightbox, the same way inline images and custom emoji already do.
- **Paste anywhere in the chat to compose.** Ctrl/Cmd+V while focused on the chat area (not
  just the message box) now drops the pasted text into the composer and focuses it — or
  attaches a pasted image — so you don't have to click into the field first.

## [3.0.22] - 2026-07-05

### Added

- **Attach images straight from the message bar.** A new image button sits next to the emoji
  picker and opens a file picker to attach one or more images — the same pipeline as
  drag-and-drop or paste, now one click away.
- **Clear a channel's messages.** A "Clear messages" action in the ⋯ menu wipes the channel's
  backlog in your client and leaves a "History cleared — click to restore" marker; click it to
  pull the history back from the server. It's local only — nothing is deleted server-side and
  other people are unaffected.

### Changed

- **Animated images and emoji settle down.** Animated GIF/WebP/APNG images and emoji now play
  for about ten seconds and then freeze on their current frame; hover over one to replay it for
  another interval, so a channel full of animation stops looping forever.
- **Inline images hide the same way as spoilers.** An image's corner toggle now covers it in
  place — same size, no reflow, with an eye to reveal it again — matching the spoiler show/hide,
  instead of collapsing it to a separate "Show image" chip.

### Fixed

- **Animated WebP and APNG emoji stay animated after upload.** The client-side resize was
  flattening them to a single frame; animated formats are now uploaded as-is so they keep
  moving. (Downscaling animated uploads is on the roadmap.)
- **Blank lines around headings render sensibly.** A blank line still separates paragraphs, but
  an extra blank line right after a heading (or list/quote) is now absorbed instead of doubling
  the gap — the block's own spacing already sets it off.
- **The message composer is opaque.** Its background was partly transparent, so other elements
  showed through when it grew to fit a long message; it's now solid.
- **Transparent avatars display correctly.** Dropped the solid fill behind avatars, so an avatar
  image with transparency shows through instead of sitting on a grey box.

## [3.0.21] - 2026-07-05

### Fixed

- **The desktop client's update check works again.** It was silently failing — the version
  manifest was fetched from a URL that sends no CORS headers, so the browser blocked it and the
  "update available" banner never appeared. It now fetches from a CORS-enabled source. Because
  the check runs in the web UI the client loads from its server (not in the installed binary),
  updating your **server** delivers this fix to already-installed desktop clients — no reinstall
  — and they'll surface future client releases from then on.

## [3.0.20] - 2026-07-05

### Fixed

- **Avatars now load on a subpath deployment.** Avatar images used a root-absolute path, so a
  server hosted under a subpath (e.g. `https://host/mara/`) failed to show them; they now
  resolve against the page base like every other image.
- **Drag-and-drop and paste now work for custom emoji in the desktop app.** The desktop client
  was intercepting dropped image files before the page could handle them, and the emoji dialog
  didn't pick up a pasted image — both work now (this also restores drag-and-drop image
  uploads to the message composer on desktop).

### Changed

- Operators: user-contributed emoji are now fully self-contained in the `user-emoji/` folder
  (the images plus an `index.json`) instead of a loose `user-emoji.json` beside the app.
  Upgrading from 3.0.19: move `user-emoji.json` into `user-emoji/` and rename it `index.json`.

## [3.0.19] - 2026-07-05

### Added

- **User avatars.** Set a profile picture in Options — it's downscaled on upload and shown
  beside your name in the user list and on your messages, with a coloured-initial monogram as
  the fallback when you haven't set one. Avatars belong to your identity, so they follow you
  across devices and reconnects. A new "Show avatars" option hides them for a leaner view.
- **Custom emoji anyone can add.** A "Custom emoji" manager (in the menu) lets anyone upload
  an image — by file picker, drag & drop, or paste — and bind it to a `:shortcode:` that
  everyone can then use. The set updates live for all connected users, with no reconnect. Only
  the person who added an emoji can replace or remove it, and the picker shows who added each
  one. (Operators can moderate the shared library by editing its data file; edits apply live.)
- **Jumbo emoji.** A message that contains only emoji — custom or native — renders them large,
  à la Discord.

## [3.0.18] - 2026-07-05

### Added

- **Discord-style message layout.** A new "Message style" option (Mara or Discord) in
  Options. _Mara_ is the existing compact `[time] Name: text` line; _Discord_ is a cozy
  layout — a larger name plus a muted timestamp header, with the message text below — and it
  groups a run of messages from the same author (within 5 minutes) under a single header,
  with a little space between messages and a larger gap before each new group.
- **Slide-out user list on narrow screens** (and whenever the inline sidebar is hidden). A
  people button in the top bar opens the list as a drawer, so on a phone you can still see
  who's here and tap someone to start a PM — previously the list just disappeared below
  640px with no way back to it. The inline sidebar's Hide/Show toggle now only appears where
  it does something (on desktop).

### Fixed

- The active conversation tab now scrolls into view when you switch to or join it, so a tab
  sitting off-screen in the overflow strip is no longer left hidden.

## [3.0.17] - 2026-07-04

### Added

- **Android client** — the Tauri 2 desktop shell now also targets Android, producing an
  installable APK. The desktop-only native pieces (window geometry, taskbar attention,
  native pop-out windows) are compiled out on mobile, where the web app falls back
  gracefully (pop-outs become tabs). The chosen server and recents are persisted in the
  app's config dir. The client track moves to 3.0.17 alongside this change.
- `pnpm package:all` builds a **signed release APK** (arm64) when the Android toolchain
  (JDK 17+, SDK, NDK) is present, and skips with a warning otherwise. `zip-dist` folds it
  into the release as `Mara3-android-arm64-v<version>.apk` plus a stable `-latest.apk`.

### Fixed

- **Mobile layout fit.** The chat now fits the screen: the header clears the top system
  bar / display cutout (safe-area insets), and the composer stays visible above the soft
  keyboard — the native WebView is resized to the IME inset, since edge-to-edge otherwise
  hides the keyboard from the web layer. Desktop is unaffected (insets are zero there).
- The message composer no longer auto-focuses on touch devices, so opening or switching a
  conversation doesn't force the on-screen keyboard up. Explicit taps still focus it.
- The native library is aligned to 16 KB pages (Android 15+ compatibility).
- The Android launcher icon has proper safe-zone padding on a brand-dark background, so
  the circular mask no longer crops the logo.
- Folding/unfolding (any display-density change) no longer recreates the WebView and drops
  the connection and in-progress state — the activity now handles the density config change.
- Disk logging is off by default on mobile (the per-channel chat logs aren't useful on a
  phone and only consume storage); desktop is unchanged.

## [3.0.16] - 2026-07-03

### Changed

- A client that connects and finds it's running an out-of-date web build now
  auto-refreshes once to pick up the version the server is serving, instead of
  only showing the "Outdated — reload" button. It reloads at most once per window
  (so a cache that keeps serving the old bundle can't loop it — the manual button
  remains as a fallback), and never in the dev server, where a build-id mismatch
  is expected and HMR already keeps the page current. On by default; toggle it
  with the new "Auto-refresh when out of date" option.

## [3.0.15] - 2026-07-03

### Fixed

- Spoilers now actually hide a link or image inside them. Three separate problems:
  a URL pressed against the closing `||` (or `[/spoiler]`) swallowed the delimiter
  into its own address, breaking the link and leaving the spoiler unterminated
  (URLs now stop at `|` and at a `[/…]` closing tag); the spoiler only blanked its
  own text via `color: transparent`, so a link kept its own colour and an image
  (which ignores `color`) showed straight through — the whole spoiler's contents
  are now hidden until revealed (and a covered link isn't clickable — clicking a
  spoiler reveals it rather than opening the hidden link); and `|| spaced ||` with
  whitespace around the content is now recognised as a spoiler too, matching Discord.
  A revealed spoiler keeps its contents independently clickable (a link or image
  inside works normally), and each spoiler carries a persistent show/hide toggle so
  it can be collapsed again without a content click re-hiding it.

## [3.0.14] - 2026-07-03

### Added

- @Mentions of known users render bold in the mentioned user's colour, with a
  soft glow in that colour (matching is case-insensitive and whole-name, same
  rules as the mention notification; mentions inside code spans stay literal).
- @Mention autocomplete in the composer: typing `@` offers the connected users
  (a bare `@` lists everyone; typing narrows, including names with spaces), with
  the same Up/Down + Enter/Tab + Esc interaction as the emoji autocomplete.
  Email-style `name@host` never triggers it.

### Fixed

- The unread `* ` title star now also fires for activity in the conversation you're
  currently viewing when the window itself is in the background — being parked on a
  channel no longer hides that things happened there while you were off the tab.
  Coming back to the window clears it.

- Message-history persistence is now crash-safe. History saves are atomic
  (temp file + rename), so a crash mid-write can no longer truncate the file;
  an unparseable history file is moved aside to `history.json.corrupt` for
  recovery instead of being silently replaced; a single invalid entry on load
  now drops only that entry rather than discarding everything after it; and a
  failed save retries on its own schedule instead of waiting for the next
  message.

## [3.0.13] - 2026-07-03

### Fixed

- The Options dialog now stays on screen and scrolls internally when the window is
  short, matching the other dialogs, so the Save button is always reachable.

## [3.0.12] - 2026-07-03

### Added

- @Mentions: a channel message containing `@YourName` now requests attention like
  a PM — on the desktop clients the taskbar button flashes when the window is in
  the background. Matching is case-insensitive and whole-name (`@Rosa` doesn't
  fire for Rosalind, `mail@host` fires for no one); your own messages never page
  you, and a pop-out window only reacts to mentions in its own conversation.
- `/join <channel>` and `/leave [channel]` slash commands. `/join` accepts an optional
  leading `#` and switches to the channel if you're already in it; `/leave` with no
  argument leaves the channel you're looking at, or a named one from anywhere.
- The browser tab title gains a leading `* ` while any channel or PM has unread
  messages, so a backgrounded Mara tab shows pending activity at a glance.
- Conversations can be popped out into their own browser windows: shift-click a
  channel or PM tab. A popped-out PM *moves* — its tab leaves the main window and
  new messages go only to the pop-out until that window closes (then the tab comes
  back; a pop-out that dies without saying goodbye forfeits the conversation back
  automatically). Channel pop-outs are extra views: the channel tab stays in the
  main window, and the pop-out closes itself when you leave the channel. PM
  pop-outs restore the conversation from the device-local history, and popping
  the same conversation out twice refocuses the existing window. Direct URLs work
  too: `?view=channel:<name>` / `?view=pm:<user token>`.
- Pop-out windows work in the desktop clients too (both the modern shell and the
  Windows 7 client, now versioned in step with the server at 3.0.12): pop-outs are
  real native windows created
  over shell IPC. The page only ever passes the conversation descriptor — the shell
  builds the URL from its own saved server address — and pop-out windows can close
  and raise themselves natively (webview `window.close()`/`focus()` are no-ops). A
  PM pop-out flashes its own taskbar button on new messages. On an older desktop
  client, pop-out requests gracefully fall back to tabs.
- The Windows 7 client now honours attention requests: it never had the
  `request_attention` command, so PM (and now @mention) taskbar flashes silently
  did nothing there. Requires the rebuilt Win7 client.
- New option: "Open private messages in their own windows" — with it on, PM
  conversations skip the tab bar entirely: opening one (user list, `/msg`) and
  new incoming conversations go straight to pop-out windows, and closing a PM
  window closes the conversation (a later message opens a fresh one) instead of
  returning a tab. If the browser blocks the popup, it falls back to a normal
  tab. Auto-opening on an incoming message requires device-local PM history
  (the window restores the triggering message from it). Pop-out windows also
  open quiet — no connect notice, MOTD, or session-boundary rule, all of which
  belong to the main window.
- Private-message conversations now survive a refresh: open PM tabs and their
  recent lines are kept on this device (localStorage, capped, bound to your
  identity) and restored on the next session. The server still never stores
  PMs — delivery remains live-only, and other devices are unaffected. Closing
  a PM tab forgets that conversation; an Options toggle ("Keep private-message
  history on this device") turns the feature off and wipes what was stored.

## [3.0.11] - 2026-07-03

### Changed

- Channel tabs with unread messages now get the same strong highlight private-message
  tabs already had (bold, accent colour, leading dot) instead of a subtle semibold.
  Only real chat and emote lines count: join/leave/away and other system notices never
  badge a tab, and neither does your own message echoed back or mirrored from another
  window/device on the same identity.

## [3.0.10] - 2026-07-02

### Changed

- A client that keeps joining and leaving without ever sending a message is now flagged
  "unreliable" after two such cycles, and its join/disconnect notices are muted until it
  next interacts (then it's revealed and the count resets). This tames the presence spam
  from flap-y mobile connections whose reconnects are spaced too far apart for the existing
  flap window to catch. Tunable via `MARA_UNRELIABLE_DROPS` (default 2; 0 disables).

## [3.0.9] - 2026-07-02

### Changed

- The Windows 7 client download no longer bundles the WebView2 fixed runtime — it ships an
  empty `webview2-runtime/` folder with a README on how to obtain and place it (Windows 7
  needs Microsoft's Fixed Version runtime, which is provided separately). This keeps the
  download small; build a self-contained bundle with `MARA_WEBVIEW2_BUNDLE=1`.

## [3.0.8] - 2026-07-02

### Fixed

- The desktop "update available" download link now points at the stable `*-latest` archive
  instead of a version-stamped one, so a banner shown before a newer release still links to
  the current download rather than going stale.

### Changed

- Desktop client update checks and downloads now default to **GitHub Releases** hosting
  (`releases/latest/download`), so publishing a release there is picked up automatically;
  `MARA_UPDATE_BASE_URL` still overrides it for self-hosting.

## [3.0.7] - 2026-07-02

### Fixed

- Emoji autocomplete now waits for two characters after the `:`, so text emoticons like
  `:D` and `:P` no longer pop the emoji menu.
- Emoji images in the picker and autocomplete now load correctly when the server is hosted
  under a subdirectory (they use page-relative paths, matching how chat messages render).

## [3.0.6] - 2026-07-02

### Added

- **Custom (server) emoji** — the operator drops image files into an emoji folder
  (`MARA_EMOJI_DIR`; `blobwave.png` → `:blobwave:`) and they become inline image emoji.
  Type `:name:` (with autocomplete that filters as you type, including a second emoji typed
  flush against the first), pick from the composer's emoji button, or click an emoji in chat
  to zoom it full-size. Animated GIFs work too, and new files are picked up within seconds
  without a restart. These are custom image emoji (Discord-style), not Unicode.

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
