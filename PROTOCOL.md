# Mara 3 Wire Protocol

Transport: **WebSocket** at the `/ws` endpoint, one **JSON text frame** per message.
The same Node server also serves the web client over HTTP on the same port, so the
client connects to `ws(s)://<same-origin>/ws`. The schema lives in `@mara/protocol`
(Zod) and is imported by both the server and every client, so a message shape changes
in exactly one place and is validated identically on both ends.

## Frame shape

Flat, discriminated on `type`:

```json
{ "type": "chat", "channelToken": 12345, "text": "hello" }
```

Messages are split by direction into two unions. Each side validates only what it
can legitimately receive, which also lets a `chat` the client _sends_ (no author)
and a `chat` the server _broadcasts_ (with an author `from`) reuse the same `type`
with direction-appropriate shapes.

## Primitives

| Type       | JSON                           | Notes                                      |
| ---------- | ------------------------------ | ------------------------------------------ |
| `Token`    | positive integer               | server-assigned user/channel id (non-zero) |
| `Color`    | `"#rrggbb"`                    | the only per-user styling                  |
| `UserInfo` | `{ token, name, color, away }` | `away` is the away note; `""` = present    |

## Client → Server

| Message          | Fields                                | Purpose                                  |
| ---------------- | ------------------------------------- | ---------------------------------------- |
| `login`          | `protocol, name, color, identityKey?` | First frame on a new socket (see below). |
| `joinChannel`    | `channel`                             | Join (or create) a channel by name.      |
| `leaveChannel`   | `channelToken`                        | Leave a channel.                         |
| `chat`           | `channelToken, text, replyTo?`        | Send to a channel (see Replies).         |
| `emote`          | `channelToken, text, replyTo?`        | `/me`-style action to a channel.         |
| `privateMessage` | `to, text`                            | Direct message to a user token.          |
| `away`           | `text`                                | Set away note; `""` clears it.           |
| `ping`           | `id`                                  | Heartbeat; echoed in `pong`.             |

## Server → Client

| Message             | Fields                                  | Purpose                                       |
| ------------------- | --------------------------------------- | --------------------------------------------- |
| `welcome`           | `self, sessionToken, motd, server?, limits?` | Login accepted; `self` is your `UserInfo`. |
| `loginDenied`       | `reason`                                | Login rejected (terminal; no auto-reconnect). |
| `userConnect`       | `user`                                  | Someone logged in.                            |
| `userDisconnect`    | `token`                                 | Someone disconnected.                         |
| `channelJoined`     | `channelToken, channel, users, history` | You joined; carries the roster + backlog.     |
| `channelLeft`       | `channelToken`                          | You left a channel.                           |
| `userJoinedChannel` | `token, channelToken`                   | Someone joined a channel you're in.           |
| `userLeftChannel`   | `token, channelToken`                   | Someone left a channel you're in.             |
| `chat`              | `id, from, channelToken, text, at, replyTo?` | A channel message (`at` = server send time). |
| `emote`             | `id, from, channelToken, text, at, replyTo?` | A channel action.                        |
| `away`              | `token, text`                           | A user's away status changed.                 |
| `privateMessage`    | `from, to, text`                        | A direct message; `to` keys the sender's copy.|
| `pong`              | `id`                                    | Reply to `ping`.                              |
| `error`             | `message`                               | A request failed, or a frame was invalid.     |

## Handshake

The client speaks first — there is no separate version/hello round-trip.

1. Client opens the socket and sends `login { protocol, name, color, identityKey? }`.
2. Server replies `welcome { self, sessionToken, motd, server?, limits? }` **or**
   `loginDenied { reason }` (and closes).
3. Steady state: join/leave channels, chat/emote/away, private messages, ping/pong.

`self.token` is the public id others see; `sessionToken` is a per-session secret
(the bearer credential for authenticated HTTP calls such as image upload — it is
never broadcast). The server de-duplicates display names, so `self.name` may differ
from the requested name.

`server` carries `{ version, protocol, webBuild? }` so a client can display the
running versions and detect when it is itself stale: `webBuild` is the build id
of the web assets the server is serving, and a client whose own compiled build id
differs knows its page is running cached old code and prompts a reload. It is
optional (absent for a headless/dev server, or one too old to send it).

`limits` carries the operator-tunable bounds a client must know to behave correctly —
currently `{ maxMessageChars }`, the longest chat/emote/private message this server
accepts (`MARA_MAX_MESSAGE_CHARS`, default 10000). A client sizes its composer to it
rather than assuming a number. It is optional: a server too old to send it enforces
the default, which is what a client assumes when the field is absent. Independently of
the setting, the wire format caps message text at 32768 characters — past that a frame
is malformed and never parses — so a server can lower or raise its limit within that
ceiling but never beyond it. Over-limit text sent anyway is **rejected** with `error`,
never silently truncated.

## Identity & presence

`identityKey` is a stable secret the client generates once and persists. The
server maps it (by hash) to a stable user `token`, so a client keeps the **same
token across reconnects and even server restarts** — which is what lets PMs and
channel membership survive a drop without per-message reconciliation. The map is
persisted to disk (`MARA_IDENTITY_FILE`; only the hash is stored, never the raw
key). Omitting `identityKey` yields a fresh one-off token each login.

The **others-visible profile — display name and colour — belongs to the identity**,
not the client: the server persists it alongside the token and, on login, a stored
profile overrides the `name`/`color` the client sent (so `welcome.self` reflects the
identity's canonical values). This is what makes a single identity look identical
across clients that share its key; a fresh identity seeds its profile from its first
login, and `setProfile` updates the stored copy. Client-only settings (theme, macros,
which channels to rejoin) are **not** server-side — they stay per-device.

Because two browser tabs share the same persisted `identityKey`, opening a second
window logs in as the **same user** rather than a duplicate: the new socket
multiplexes onto the live session (it receives a `welcome` and a `channelJoined`
for each channel the user is already in, to bring it in sync). Channel and PM
traffic fan out to every open window, and `userDisconnect` is broadcast only once
the user's **last** window closes. Each window still gets its own `sessionToken`
(upload bearer). Outgoing PMs converge too: the server mirrors a sent PM to the
sender's other windows (skipping the one that sent it, which shows the line
locally), so every window/device sees both sides of a conversation.

There are still no accounts — a chosen name is a display label, not proof of
identity. Presence is per-channel: clients learn who is present from each
`channelJoined` roster and the `userJoinedChannel`/`userLeftChannel`/
`userDisconnect` notices. There is no global user list.

## Message backlog

The server retains the most recent messages per channel (capped, default 100;
`MARA_HISTORY_LIMIT`) and replays them in `channelJoined.history` — an array of
`{ id, from, name, color, kind, text, at, replyTo? }`, oldest first — so a joiner (or a
client that reloaded/reconnected) sees recent scrollback. Each entry snapshots the
author's name/colour so it renders even if that author is no longer present.
Backlog is persisted to disk (`MARA_HISTORY_FILE`, on by default; set empty to
disable), so it survives a restart. **Private messages are never retained** — the
server keeps no PM history, on disk or in memory, as a deliberate privacy decision
(see [SECURITY-TODO.md](SECURITY-TODO.md)); a PM reaches only the devices connected
when it was sent.

## Attachments (images and files)

Attachments are **not** a wire concept — nothing in the message set carries file metadata.
An upload happens over HTTP first, and the URL it returns is appended to the message text,
so an attachment survives history, quoting, and editing exactly like any other text.

| Kind  | POST      | Served at    | Returned URL                                |
| ----- | --------- | ------------ | ------------------------------------------- |
| Image | `/upload` | `/uploads/…` | `/uploads/<32hex>.<ext>`                    |
| File  | `/file`   | `/files/…`   | `/files/<32hex>.<ext>/<bytes>/<name>`       |

Both require the session bearer from `welcome.sessionToken`; both return `{ url }`; both
are left **relative** so each client resolves them against the origin it connected to.

A file URL carries two extra segments — the byte size and the percent-encoded original
filename — purely so a client can render a download card (name + size) from the message
text alone, with no extra request and no attachment metadata on the wire. Neither is
trusted when serving: only the id segment selects a file, the size sent is the real
file's, and the name is re-sanitized. The original filename travels up in the
`x-mara-filename` header (percent-encoded), since the request body is the raw bytes.

Images are hosted for inline display. **Files of any type are accepted and always served
back as `application/octet-stream` with `Content-Disposition: attachment`** — a shared
file downloads, never renders, whatever its extension claims (see
[SECURITY-TODO.md](SECURITY-TODO.md)). Each store rolls independently:
`MARA_MAX_UPLOAD_MB`/`MARA_MAX_CACHE_MB` for images, `MARA_MAX_FILE_MB`/`MARA_MAX_FILES_MB`
for files. Both evict oldest-first, so a link in old scrollback eventually 404s — for a
well-formed file URL that 404 carries a "no longer available" body, and clients check with
a `HEAD` before starting a download so they can mark the card instead of navigating to an
error page.

## Replies

A `chat`/`emote` may carry `replyTo`, quoting an earlier message in the same channel. The
two directions are deliberately asymmetric:

- **Client → server**: `replyTo` is just the **message id** being replied to.
- **Server → client**: `replyTo` is the resolved snapshot
  `{ id, from, name, color, kind, excerpt }` — and it is retained on the history entry, so
  the backlog replays replies with their quotes intact.

The server builds that snapshot from its own copy of the parent, which is what makes the
quote trustworthy: a client can't dictate who it is quoting or what they said. Resolution is
scoped to the replier's channel, so an id belonging to a channel they aren't in resolves to
nothing (message ids are global, and a reply must not become a way to read a message you
can't see). `excerpt` is the parent's text with whitespace collapsed to single spaces and
truncated to 200 chars, so a quote bar is always one line; clients render it as **plain
text** — no markdown, links, or inline images.

An id the server no longer retains (the parent aged out of the channel's backlog) resolves
to nothing too. The reply is then delivered as an ordinary message rather than rejected —
losing the quote is better than losing what someone typed.

Private messages cannot be replied to: the server assigns them no ids and stores nothing
for them.

## Keepalive

App-level `ping { id }` / `pong { id }` gives liveness and a round-trip-time
measurement; WebSocket ping/pong frames cover liveness at the transport layer.

## Errors

Request failures (not in that channel, recipient offline, malformed frame, …) come
back as `error { message }`. A failed `login` is the exception — it returns the
terminal `loginDenied { reason }`.

## Versioning

`PROTOCOL_VERSION` (currently `5`) bumps on any breaking change to the message set.
The client sends it in `login`; the server denies a mismatch with `loginDenied`.
Purely **additive optional** fields (such as `replyTo`) don't bump it: an older server
ignores one it doesn't know, and an older client ignores one it isn't looking for.

## Limits

Chat/PM text is capped at 8192 characters (a server abuse guard). A single inbound
WebSocket frame is capped at 256 KB. See [SECURITY-TODO.md](SECURITY-TODO.md) for
the broader threat model and open items.
