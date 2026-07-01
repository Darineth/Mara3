# Client Security Info — Desktop → Native IPC surface

What a **connected server** can reach on the desktop clients. This complements
[SECURITY-TODO.md](SECURITY-TODO.md), which covers the server-facing surface
(WebSocket/HTTP, HTML render, uploads) but says nothing about the native IPC the
desktop shells expose. Records the **current** surface and the **open** items —
resolved findings are dropped once fixed.

## Trust boundary

The desktop clients — `apps/shell` (Tauri 2) and `apps/client-legacy` (Tauri 1,
Win7) — are thin native wrappers that **load the server's hosted URL into the OS
webview**. The server therefore serves _all_ the JS/HTML that runs in the client;
the entire web UI is server-controlled code. So the real surface is: connecting
to a server hands that server's page whatever native IPC the shell grants its
origin.

The grant is origin-scoped — only the **exact** origin the user connected to gets
IPC, never a wildcard (`grant_remote_ipc`, `apps/shell/src-tauri/src/lib.rs`). A
malicious server means running its code with the native capabilities below.

## Modern shell (Tauri 2) — current reachable surface

Granted to the remote origin by `grant_remote_ipc`
(`apps/shell/src-tauri/src/lib.rs`):

| Surface                   | Reach                                                   | Notes                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mara_log(channel, line)` | Append `line` to `<logDir>/<channel>/Mara3_YYYY-MM.log` | Bounded: per-line 8 KB clamp, per-file 32 MB ceiling, channel label clamped to 128 chars; `channel` is path-traversal-safe (`sanitize_segment`). See the residual under Open items. |
| `open_external(url)`      | Open an **http/https** URL in the system browser        | Scheme validated in Rust; opener's file-path / `with`-program forms are unreachable.                                                                                                |
| `switch_server()`         | Navigate the window back to the picker                  | Nuisance only.                                                                                                                                                                      |
| `core:default`            | events, window/webview/path/app defaults                | Page can manipulate its own window, emit/listen events, read app/path info. No `fs`/`shell` plugin is registered → **no arbitrary file read/write or command exec** through core.   |

**Not** granted to the remote origin (local picker capability only): `get_settings`,
`set_server_url`, `set_auto_connect`, `open_app` — a server can't read/rewrite the
settings file or force a redirect. The opener and updater plugins are **not** granted
to the remote origin either.

Injected globals: only `__MARA_UPDATE__` (this build's version + the public manifest
URL — non-sensitive, needed by the hosted update banner) reaches the remote page. The
sensitive `__MARA_SETTINGS__` (recent-servers list, `logDir`, `serverUrl`) and
`__MARA_LOG__` (an absolute local path, often the OS username) are gated to the local
picker page.

## Open items

### Legacy Win7 client (Tauri 1) — residual

Tauri 1 has **no per-command ACL**: the legacy grant uses `enable_tauri_api()` on the
remote scope (`apps/client-legacy/src-tauri/src/main.rs`), and that same call is what
injects the remote page's invoke bridge — so once a server is connected, its page can in
principle reach every registered command. Instead of a true ACL (unavailable in Tauri 1),
the picker-only commands (`get_settings`, `set_server_url`, `set_auto_connect`,
`open_app`) now **origin-gate** themselves via `is_local_window()` — they refuse unless
invoked from the local picker page (`tauri.localhost` / `tauri:`). Safe because the picker
only calls them before navigating and there's no switch-back flow. So a loaded server can
no longer read settings / the recent-servers list or rewrite the saved server URL; the
commands it can still reach are effectively just `mara_log` (bounded) and the built-in
`shell.open`.

Also fixed to match the modern shell: the injected globals are gated to the local picker
page (`__MARA_SETTINGS__` / `__MARA_LOG__` no longer leak), and `mara_log` is capped.
`shell.open` is now limited to `^https?://` — note it was never an arbitrary-program/path
hole: `open: true` already applied Tauri 1's default validator (`http(s)`/`mailto`/`tel`);
this just drops `mailto`/`tel`. `dangerousUseHttpScheme: true` stays (Win7/WebView2 compat).

**Not viable — dropping `enable_tauri_api()`** (to remove the built-in API from the remote
page): it's what injects the remote page's invoke bridge in Tauri 1, so removing it breaks
`mara_log` — [native.ts](apps/web/src/lib/native.ts) reaches the legacy client via
`__TAURI__.tauri.invoke` and has no low-level `__TAURI_IPC__` fallback. The origin-gating
above achieves the practical goal without it.

### `mara_log` total-disk residual (accepted)

Per-file is capped at 32 MB, but a server can spray many _distinct_ channel names,
each getting its own 32 MB-capped file, so total disk isn't hard-bounded. Accepted:
real logs are ~5 MB and each new channel creates a visibly-named folder. Revisit with
a session running-total cap only if abuse is seen.

### `csp: null` in the Tauri configs (both clients)

Not a control against the threat this doc is about: a page's CSP comes from the origin
serving it, and Tauri can't inject one into a remote-navigated page — so it can never
constrain a hostile server. The web app's own CSP (an honest server protecting users
from malicious _chat content_) is a separate, server-side concern and is now sent by
`apps/server` — see the CSP entry in [SECURITY-TODO.md](SECURITY-TODO.md).

The residual here is only the Tauri `security.csp: null` on the **local picker** assets
(`tauri.conf.json`). Low value (the picker is trusted local content), but it could be
tightened to `script-src 'self'` as cheap hardening if desired.
