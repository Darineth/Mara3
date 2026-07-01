# Security TODO

Backlog of security findings for Mara 3, focused on the communication
(WebSocket/HTTP) and HTML-rendering paths. From the review on **2026-06-19**;
release-prep pass **2026-06-28** (resolved M3/L5/L6; reviewed the new
update-nudge / `setProfile` / Markdown-image surfaces).

## Threat model (context)

Mara 3 is a self-hosted chat server, originally a LAN tool but reachable by any
host that can open the port. Identity is a chosen display name — there is **no
account system**. By default the server speaks plaintext `ws://`/`http://`.
Findings are rated against "a malicious but unprivileged client/host that can
reach the server."

## Already addressed

- Strict Zod validation of every frame in both directions; malformed frames
  rejected without killing the socket. (`packages/protocol`, `hub.ts`, `client.ts`)
- HTML render pipeline escapes all user-controlled fields; URLs limited to
  `http(s)`/relative `/uploads/`; single-pass restore documented as load-bearing.
  (`packages/chat-render/src/text.ts`)
- Uploads: SVG rejected; served with `nosniff` + sandbox CSP + fixed type; strict
  filename regex blocks path traversal; per-file + rolling-cache size caps.
  (`apps/server/src/uploads.ts`)
- `POST /upload` requires a valid WS session token (`Authorization: Bearer`). _(commit 84b907e)_
- WebSocket `maxPayload` 256 KB; `pluginData` capped at 16 KB. _(commit 84b907e)_
- **Per-connection flood control** (was M3): a token bucket per socket
  (`MARA_MSG_RATE`/`MARA_MSG_BURST`, default 15/s, burst 30); over-limit frames are
  dropped, the user is notified once per run, and a persistent flooder is closed
  (`MARA_MSG_FLOOD_KICK`). `MARA_MSG_RATE=0` disables it. (`connection.ts`, `hub.ts`) _(2026-06-28)_
- **System notices render as escaped text** (was L5): join/leave/disconnect/connection
  lines disable markdown/links/images, so a display name like `http://evil.com` or
  `![](/uploads/x)` can't become a link/image in everyone's notices. (`render.ts`) _(2026-06-28)_
- **Upload magic-byte sniff** (was L6): the body's leading bytes must match the declared
  image type, so a lying `Content-Type` can't cache arbitrary bytes. (`uploads.ts`) _(2026-06-28)_
- **Web app CSP** (defense-in-depth for the chat-render XSS boundary): document responses
  carry a `Content-Security-Policy` whose load-bearing directive is `script-src 'self'`
  (the Vite build emits only external, same-origin scripts — no inline/eval), plus
  `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`, and `nosniff`.
  `img-src`/`connect-src` are intentionally broad (arbitrary inline chat images; the
  cross-origin desktop update-manifest fetch), so it hardens script **execution**, not
  exfiltration. Note this only helps against malicious _content_ on an honest server — a
  hostile server sends its own headers. (`apps/server/src/server.ts`) _(2026-06-30)_

## Reviewed 2026-06-28 (release-prep pass) — clean

- Mid-session `setProfile` (name/colour): name is escaped wherever rendered (and only
  shown as plain text in system lines per L5); colour is re-validated against
  `#rrggbb` at render; the name is deduped server-side. No injection path.
- Markdown `![alt](url)` images: alt text is HTML-escaped into the `alt` attribute;
  the URL goes through the same `http(s)`/`/uploads/` scheme allowlist as `[img]`.
- Desktop update nudge: manifest fetched read-only; the Download link only opens
  `http(s)` URLs in the system browser. Update host is operator-controlled.

## Open items

### M4 — Plaintext transport · _Medium (deployment)_

All traffic, including "private" messages, is readable by any network observer;
no `wss`/TLS.

- **Where:** `apps/server/src/server.ts` (uses `node:http`). Client already
  derives `wss` for an `https` origin.
- **Fix:** document/support running behind a TLS-terminating reverse proxy, or
  add optional `https`/`wss` to the server. State plainly that PMs are not
  confidential on an untrusted network until then.

### L3 — No Origin allowlist on the WebSocket upgrade · _Low_

Any web origin can open a WS to the server (CSWSH). Low impact today because
there is no cookie/ambient auth to ride on — but a trap if session auth is ever
added.

- **Where:** `apps/server/src/server.ts` (`WebSocketServer` / upgrade handling)
- **Fix:** if/when ambient auth is introduced, enforce an `Origin` allowlist on
  upgrade.

### L4 — No real authentication (names are display labels) · _Low (by design)_

Clients now hold a persistent `identityKey` that the server maps to a stable
token (so reconnects/restarts preserve identity — see PROTOCOL.md). But it is
trust-on-first-use: the key is whatever the client sends, there are still no
accounts, and a chosen **name** isn't verified — anyone can pick any unused name,
so visual impersonation by name remains possible.

- **Where:** `apps/server/src/hub.ts` (`resolveToken` / `uniqueName`)
- **Fix (if desired):** real authentication (accounts, or signed identity keys)
  if the deployment needs verified identities.

## Notes

- Client-side markdown regexes backtrack; input is capped at 8192 chars. The
  per-connection flood control (above) bounds how fast one client can make every
  other client re-render, which was the main amplification concern.
- Unbounded channel creation per client is a minor memory vector
  (`getOrCreateChannel`); revisit if abuse is seen.
- `/upload` is gated by a live WS session + per-file/cache caps + magic-byte sniff,
  but has no separate per-connection rate bucket; the cache cap bounds the blast
  radius. Add a tighter upload bucket if abuse is seen.
