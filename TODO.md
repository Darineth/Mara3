# Mara 3 — TODO

Working list of things to do. See [ROADMAP.md](ROADMAP.md) for the forward-looking
feature plan (and explicit non-goals), [PARITY.md](PARITY.md) for the Mara 2 → 3
feature checklist, and [SECURITY-TODO.md](SECURITY-TODO.md) for the security
backlog.

## Before the first release (3.0.0)

The remaining blockers before tagging **v3.0.0** and publishing the first build:

- [x] **Rejoin the channels you were in.** On reconnect (and on relaunch) automatically
      re-join the set of channels the user had open, instead of resetting to just the
      default channel. Persist the joined-channel set client-side and replay the joins once
      the session is active; restore the active tab where possible.
      _(Done — persisted `channels` in `MaraSettings`, seeded into the client as
      `initialChannels` and (re)joined on every `welcome` (idempotent with the server's
      default-channel auto-join). Leaving drops a channel from the set. The active tab
      lands on the default/main channel after connect — silently-rejoined channels stay
      background tabs — while a deliberate join via `+` still focuses it.)_

- [x] **Formatting help screen.** A dialog listing the message-formatting syntax — markdown
      (`**bold**`, `*italic*`, `__underline__`, `~~strike~~`, `` `code` ``, `||spoiler||`),
      the legacy `[b]`/`[i]`/`[u]`/`[s]`/`[img]`/`[spoiler]` tags, emoticons, and the `!<url>`
      inline-image marker — reachable from the composer or the overflow menu.
      _(Done — `FormattingHelp.svelte` dialog from the overflow menu (⋯ → Formatting help…):
      text markdown, links/images incl. `![alt](url)`/`!url`/`[img]`, and the legacy
      `[b]/[i]/[u]/[s]/[spoiler]` tags. Emoticons omitted — they render off by default.)_

- [x] **Options menu (name / color / preferences).** An in-session settings dialog to change
      display name, color, theme, and other preferences without disconnecting (today name and
      color are only settable on the connect screen). The overflow menu already has Theme; grow
      it into a proper options panel. A mid-session name/color change likely needs a
      roster-update broadcast — check protocol support.
      _(Done — `OptionsDialog.svelte` (⋯ → Options…) with name/colour/theme; Theme moved out of
      the inline menu. Name/colour changes broadcast via a new protocol `setProfile`→`userProfile`
      (PROTOCOL_VERSION → 2): the server dedupes the name (excluding self) and tells everyone, and
      the changer's own self/roster update from the same broadcast.)_

- [x] **Inline-URL images stay in place.** Images attached by pasting (uploads) work as-is;
      but an image inlined from a URL should render **in place** — at the URL's position in the
      message text — rather than being moved or collected elsewhere. (Render-position behavior
      in `@mara/chat-render`.)
      _(Done — `renderText` restores image placeholders in place instead of hoisting them into
      a `mara-imgs` block at the end (wrapper removed). The image box is top-aligned with the
      inline text (`vertical-align: top`).)_

- [x] **Full Markdown image syntax `![alt](url)`.** Support standard Markdown image syntax in
      addition to the existing simplified handling (bare-URL auto-detect, the `!<url>` force
      marker, and the legacy `[img]` tag). Honor the same http(s)/upload scheme allowlist and
      the images toggle. (`@mara/chat-render`.)
      _(Done — `IMG_MD_RE` pass: `![alt](url)` forces the URL inline as an image (any extension)
      with escaped alt text, same http(s)/upload allowlist, honoring the images/links toggles.)_

- [x] **Security review and fixes.** A focused pre-release security pass over the server and
      clients, fixing what it finds. Cross-check [SECURITY-TODO.md](SECURITY-TODO.md) (TLS / M4,
      upload handling, HTML/URL escaping, rate limits, identity-token handling, and the desktop
      shells' remote-IPC capability surface).
      _(Done 2026-06-28 — focused pass: added per-connection flood control (M3), escaped-text
      system notices (L5), and upload magic-byte sniff (L6); reviewed the new update-nudge /
      `setProfile` / Markdown-image surfaces (clean). Deferred in [SECURITY-TODO.md](SECURITY-TODO.md):
      built-in TLS (M4 — reverse proxy covers v1), WS Origin allowlist (L3 — low, no ambient
      auth), real accounts (L4 — by design).)_

## Bugs

- [x] Private messages breaking when a client disconnects — a PM peer's token is
      re-minted on reconnect, so the conversation stranded on the dead token. The
      client now migrates the thread (and the tab/active view) to the new token
      by name when the peer reconnects.

## Features

- [x] **MOTD (Message of the Day).** Let the server operator configure a message that is
      sent to every client on connect, displayed as a system line (or a distinct notice
      banner) at the top of the main channel backlog. Configured via a field in the server
      config (e.g. `MARA_MOTD` env var or a `motd` key in a config file); empty/absent
      means no MOTD. Needs a new protocol frame (e.g. `motd`) so clients can render it
      distinctly from chat messages and it doesn't pollute history. Should also be included
      in the admin page (see ROADMAP §7) as a runtime-editable field.
      _(Done — server `motd` config: `MARA_MOTD` env or a `MOTD.md` file next to the
      launcher (markdown, capped at `MOTD_MAX_LEN`), sent to clients on connect and
      rendered once as a markdown `notice` line after the join so it doesn't pollute
      history. Runtime editing via the admin page is still pending — see ROADMAP §7.)_

- [x] **Legacy `[img]`, `[spoiler]`, `[b]`, `[i]`, `[u]`, `[s]` tags (Mara 2 compatibility).**
      Support the old Mara BBCode-style tags so messages copied from / shared with the
      old client render the same: `[img]url[/img]` forces that URL inline as an image
      (regardless of extension — composes with the existing extension/query auto-detect
      and the `!<url>` marker), `[spoiler]text[/spoiler]` renders a spoiler (the same
      hidden-until-clicked treatment as `||spoiler||`), and `[b]`/`[i]`/`[u]`/`[s]` map to
      bold/italic/underline/strikethrough like `**`/`*`/`__`/`~~`.
      _(Done 2026-06-27 in `@mara/chat-render`: `IMG_TAG_RE`/`IMG_URL_RE` in the URL
      pass; `[b]`/`[i]`/`[u]`/`[s]`/`[spoiler]` rules in `applyMarkdown`. `[img]` honors
      only clean http(s)/upload URLs — same scheme allowlist as auto-links — and respects
      the images/links toggles; the bracket tags ride the markdown toggle like `||…||` and
      are case-insensitive. Stopped here; no `[url]`/`[color]` etc.)_

- [ ] **Inline images for extension-less / opaque URLs.** Today inline images are
      detected purely by the URL's file extension (a client-side regex in
      `@mara/chat-render`), so a real image URL with no extension — e.g. a Google
      thumbnail `https://encrypted-tbn0.gstatic.com/images?q=tbn:…&s=10` — renders as
      a plain link, not inline. Decided context: **no full media proxy** (external
      images load directly from the host, as they always have; the direct-fetch
      privacy/tracking tradeoff is accepted). Undecided which approach to take — the
      server-side probe is appealing, ideally with the "send now, upgrade later" flow;
      options:

  - [x] **Query-format heuristic** — also treat a URL as an image when it _declares_ a
    format in the query (`?format=jpg`, `&fm=png`, `?ext=webp`). Cheap, no fetching,
    catches Twitter/CDN URLs; does **not** help truly opaque URLs (the gstatic one).
    _(Done 2026-06-26: `IMAGE_QUERY_RE` in `@mara/chat-render`.)_
  - [x] **Sender explicit marker** `!<url>` — a bang prefix forces that URL inline
    regardless of extension/type; the `!` is consumed from the rendered text. Per-URL
    opt-in by whoever posts it, no fetching/SSRF. Covers the truly opaque URLs the
    query heuristic can't. _(Done 2026-06-26: `MARKED_URL_RE` in `@mara/chat-render`.)_
  - [ ] **Server-side Content-Type probe** — _deferred until stable message ids exist
    (see ROADMAP), so we get the "send now, upgrade-later" flavor for free rather than
    paying probe latency before every broadcast and taking on SSRF hardening now._ On
    an incoming chat/emote, the server does a
    `HEAD` (or `GET` with `Range: bytes=0-0`) on the posted URLs, reads `Content-Type`,
    and flags the image ones in the broadcast + stored history; clients render those
    inline (still loading the bytes **directly** from the host — no proxying). Solves
    opaque detection. ⚠️ Big caveat: this makes the server fetch user-supplied URLs →
    **SSRF risk** — must block private/loopback/link-local/cloud-metadata IPs (re-check
    across redirects / disable redirects), http(s)-only, tight timeout, per-user rate
    limit, and a per-URL result cache. Needs a small `images: string[]` field on the
    chat/emote/history messages and a renderer tweak to honor it.
    - **Send-now-upgrade-later (preferred flavor)** — broadcast the message
      immediately as a link, probe async, then push a follow-up that upgrades the URL
      to inline so there's no message-delivery latency. Requires per-message ids / an
      edit-or-update mechanism we don't have yet (see ROADMAP "stable message ids").
      Without it, the probe has to run _before_ broadcast (adds up to the timeout's
      delay on a novel link; cached/repeat links are instant).
  - **Client speculative load** — render any URL as `<img>`, fall back to a link on
    `onerror`. Fully automatic incl. opaque URLs, but speculatively GETs **every**
    posted link from every viewer (privacy/perf/GET-side-effect cost). Not preferred.
  - **Viewer opt-in toggle** — a per-client "auto-show inline images" setting (default
    could be off → links). Privacy-friendly gating, but on its own doesn't solve opaque
    detection. Could pair with any of the above.

## Updates / distribution

- [x] **Desktop client update nudge.** Because the shell is a thin Tauri wrapper that
      loads the server's hosted web UI, the bulk of every release (web UI, features, bug
      fixes) already reaches clients on the next load with no client rebuild — only the
      native shell binary (Rust commands, picker page, Tauri/webview version bumps) needs
      a real push, and that's rare. Chose a lightweight, portable-preserving nudge over
      Tauri's silent self-installer: the client stays a portable single exe. Build it with
      `MARA_UPDATE_BASE_URL=https://<host>/<path>` (self-hosted); `package.mjs` bakes
      `MARA_UPDATE_URL=<base>/latest.json` (default base
      `https://mara.pretoast.com/mara3-updates`) into the binary and `zip-dist.mjs`
      writes a ready-to-host `latest.json` pointing at the desktop zip. `lib.rs` injects
      `window.__MARA_UPDATE__` on every page, so the nudge shows in **two** places:
      the launch picker (`bootstrap/index.html`) and the live web UI itself
      (`apps/web` `UpdateBanner.svelte` / `lib/update.ts`), the latter persisting after
      auto-connect navigates past the picker. Both fetch the manifest, semver-compare,
      and show a dismissible "update available" banner with a Download link (opens in the
      system browser; web-UI dismissal remembered per version). The update host must send
      `Access-Control-Allow-Origin: *` (cross-origin fetch). Build with `MARA_UPDATE_URL=`
      empty to disable. The **Win7 legacy client** (Tauri 1) has the same nudge on its
      picker (opening the download via `shell.open`), but polls its **own**
      `latest-win7.json` since it's a separate download. _(Done 2026-06-28 in
      `apps/shell/src-tauri/src/lib.rs`, `apps/shell/bootstrap/index.html`,
      `apps/client-legacy/src-tauri/{src/main.rs,Cargo.toml,build.rs,tauri.conf.json}`,
      `apps/client-legacy/bootstrap/index.html`, `apps/web/src/{App.svelte,
      UpdateBanner.svelte,lib/update.ts,lib/native.ts}`, `scripts/package.mjs`,
      `scripts/package-legacy.mjs`, `scripts/zip-dist.mjs`.)_

- [ ] **Full Tauri auto-update (deferred).** Graduate the nudge to silent
      download-verify-install when wanted: flip `bundle.active`/`createUpdaterArtifacts`
      in `tauri.conf.json`, switch to NSIS installer output, point `plugins.updater.endpoints`
      at the host, and produce signed update artifacts. The signing keypair
      (`apps/shell/.tauri/mara-update.key` + `.pub`), embedded pubkey, and key-passthrough
      in `package.mjs` are already in place; the tradeoff is giving up the portable single-exe
      model and taking on CI signing.

## Polish

- [ ] **Mobile / small-display layout pass.** The web UI has not been tested on small
      screens; verify layout, touch targets, and scrolling behaviour in a mobile browser
      (Chrome for Android / Safari on iOS) at common breakpoints (360 px, 390 px, 768 px).
      Pay attention to: the channel sidebar (collapsed state and the toggle), the message
      input bar, the user roster, and the lightbox. Fix any overflow, wrapping, or
      tap-target issues found. No native mobile app is planned — the goal is a usable
      browser experience on a phone when the desktop client isn't available.

- [ ] **Linux standalone desktop client.** The Tauri 2 shell (`apps/shell`) already
      targets Linux via `cargo`; add a `package:linux` script (parallel to `package:legacy`)
      that produces an AppImage or `.deb` portable bundle on a Linux host (or CI runner).
      Verify the portable-settings path (next to the executable) works on Linux the same
      way it does on Windows, and add the resulting archive to `package:all` / `zip-dist.mjs`.

- [ ] **Android app.** Tauri 2 supports Android targets (`tauri android build`); once the
      mobile layout pass (above) is solid, package the Tauri 2 shell as an `.apk` / `.aab`.
      Requires the Android SDK + NDK and a connected device or emulator for testing. The
      portable-settings path will need a platform-appropriate data directory on Android
      (Tauri exposes this via `appDataDir`). Sideloading the APK is fine for personal use;
      Play Store distribution requires a developer account and signing setup.

- [ ] **macOS standalone desktop client.** Same as Linux above, but produces a `.dmg` /
      `.app` bundle. **Requires an Apple-hosted build machine** — Tauri cannot cross-compile
      to Apple targets from Windows or Linux; use a real Mac or a `macos-latest` GitHub
      Actions runner (costs more CI minutes). Code-signing and notarization are optional for
      personal use but required to distribute without Gatekeeper warnings.

- [x] **New app icon / logo.** Master logos live in `resources/`
      (`Mara3Logo1_<Color>_1000.png`). Per-target colour: **Blue** = desktop shell +
      web favicon/splash, **Green** = server (its `.ico` + Create-Shortcut), **Purple** =
      Win7 legacy. _(Done 2026-06-27: regenerated the full icon sets for both Tauri
      shells via `pnpm tauri icon resources/…` , green server `.ico`, web favicon, and
      startup/splash logos on the shell/Win7 pickers and the web connect + "Connecting…"
      screens.)_

## Deferred / post-release

- [ ] **Native HTTPS / WSS support.** Today the server speaks plaintext `ws://`/`http://`
      only, so traffic — including private messages — is readable by any network observer
      (the client already derives `wss` from an `https` origin, so it works behind a
      TLS-terminating reverse proxy). Add optional built-in TLS: serve `https`/`wss` when
      a cert+key are supplied (e.g. `MARA_TLS_CERT` / `MARA_TLS_KEY` or a config block),
      falling back to plaintext when not. Until then, document the reverse-proxy setup and
      state plainly that PMs aren't confidential on an untrusted network. _(Tracked as
      **M4** in [SECURITY-TODO.md](SECURITY-TODO.md); server entry point is
      `apps/server/src/server.ts`, currently `node:http`. Deferred: the reverse-proxy path
      covers TLS for the first release; built-in TLS is a post-release convenience.)_
