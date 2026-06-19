# Security TODO

Backlog of security findings for Mara 3, focused on the communication
(WebSocket/HTTP) and HTML-rendering paths. From the review on **2026-06-19**.

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

## Open items

### M3 — No per-connection rate limiting / flood control · _Medium_

A client can send messages as fast as it likes; the server faithfully
re-broadcasts to all channel members, and each recipient renders with
backtracking markdown regexes — so one client can degrade every client.

- **Where:** `apps/server/src/hub.ts` (`onMessage`), `apps/server/src/connection.ts`
- **Fix:** token-bucket per connection (e.g. N msgs/sec with a small burst);
  on exceed, drop or send a throttling `error` and optionally disconnect repeat
  offenders. Consider a separate, tighter bucket for `/upload`.

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

### L4 — Identity is a chosen name; resume tokens unused · _Low (by design)_

Anyone can connect and pick any unused name; a name freed by a leaver can be
taken by anyone (impersonation). `resumeToken` is generated but never validated
on login, so there is no real session resume.

- **Where:** `apps/server/src/hub.ts` (`handleLogin` ignores `msg.resumeToken`)
- **Fix (if desired):** validate `resumeToken` to rebind a prior identity on
  reconnect; longer term, optional real authentication.

### L5 — Display names run through full markdown/linkify in system lines · _Low_

A name like `http://phish.com` or `/uploads/<id>.png` becomes a clickable link
or inline image inside everyone's "X joined / left / disconnected" notices.
Escaped (not XSS), but a spoofing/annoyance vector.

- **Where:** `packages/client-core/src/client.ts` (`systemLine`), rendered via
  `renderText` for `kind: 'system'` in `packages/chat-render/src/render.ts`
- **Fix:** render display names as escaped-text-only — e.g. compose system lines
  from a pre-escaped name with links/images/markdown disabled for that segment.

### L6 — Upload content-type trusted from the header · _Low (defense-in-depth)_

`/upload` keys off the `Content-Type` header, not the bytes. Mitigated by
`nosniff` + sandbox CSP + fixed served type, so it is not an XSS vector — the
image just won't render if the bytes lie.

- **Where:** `apps/server/src/uploads.ts` (`handleUpload`)
- **Fix:** sniff magic bytes and reject mismatches (e.g. PNG/JPEG/GIF/WebP/BMP
  signatures).

## Notes

- Client-side markdown regexes backtrack; input is capped at 8192 chars, but a
  flood of pathological text burns CPU on every rendering client — another
  reason to land **M3**.
- Unbounded channel creation per client is a minor memory vector
  (`getOrCreateChannel`); revisit if abuse is seen.
