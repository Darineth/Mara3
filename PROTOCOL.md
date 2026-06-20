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

| Message          | Fields                  | Purpose                                  |
| ---------------- | ----------------------- | ---------------------------------------- |
| `login`          | `protocol, name, color` | First frame on a new socket (see below). |
| `joinChannel`    | `channel`               | Join (or create) a channel by name.      |
| `leaveChannel`   | `channelToken`          | Leave a channel.                         |
| `chat`           | `channelToken, text`    | Send to a channel.                       |
| `emote`          | `channelToken, text`    | `/me`-style action to a channel.         |
| `privateMessage` | `to, text`              | Direct message to a user token.          |
| `away`           | `text`                  | Set away note; `""` clears it.           |
| `ping`           | `id`                    | Heartbeat; echoed in `pong`.             |

## Server → Client

| Message             | Fields                                  | Purpose                                       |
| ------------------- | --------------------------------------- | --------------------------------------------- |
| `welcome`           | `self, sessionToken, motd`              | Login accepted; `self` is your `UserInfo`.    |
| `loginDenied`       | `reason`                                | Login rejected (terminal; no auto-reconnect). |
| `userConnect`       | `user`                                  | Someone logged in.                            |
| `userDisconnect`    | `token`                                 | Someone disconnected.                         |
| `channelJoined`     | `channelToken, channel, users, history` | You joined; carries the roster + backlog.     |
| `channelLeft`       | `channelToken`                          | You left a channel.                           |
| `userJoinedChannel` | `token, channelToken`                   | Someone joined a channel you're in.           |
| `userLeftChannel`   | `token, channelToken`                   | Someone left a channel you're in.             |
| `chat`              | `from, channelToken, text, at`          | A channel message (`at` = server send time).  |
| `emote`             | `from, channelToken, text, at`          | A channel action.                             |
| `away`              | `token, text`                           | A user's away status changed.                 |
| `privateMessage`    | `from, text`                            | A direct message to you.                      |
| `pong`              | `id`                                    | Reply to `ping`.                              |
| `error`             | `message`                               | A request failed, or a frame was invalid.     |

## Handshake

The client speaks first — there is no separate version/hello round-trip.

1. Client opens the socket and sends `login { protocol, name, color }`.
2. Server replies `welcome { self, sessionToken, motd }` **or**
   `loginDenied { reason }` (and closes).
3. Steady state: join/leave channels, chat/emote/away, private messages, ping/pong.

`self.token` is the public id others see; `sessionToken` is a per-session secret
(the bearer credential for authenticated HTTP calls such as image upload — it is
never broadcast). The server de-duplicates display names, so `self.name` may differ
from the requested name.

## Identity & presence

There are no accounts: identity is the chosen `name`. Presence is per-channel —
clients learn who is present from each `channelJoined` roster and the
`userJoinedChannel`/`userLeftChannel`/`userDisconnect` notices. There is no global
user list.

## Message backlog

The server retains the most recent messages per channel (capped, default 100;
`MARA_HISTORY_LIMIT`) and replays them in `channelJoined.history` — an array of
`{ from, name, color, kind, text, at }`, oldest first — so a joiner (or a client
that reloaded/reconnected) sees recent scrollback. Each entry snapshots the
author's name/colour so it renders even if that author is no longer present.
Backlog is in-memory only; it does not survive a server restart. Private messages
are not retained.

## Keepalive

App-level `ping { id }` / `pong { id }` gives liveness and a round-trip-time
measurement; WebSocket ping/pong frames cover liveness at the transport layer.

## Errors

Request failures (not in that channel, recipient offline, malformed frame, …) come
back as `error { message }`. A failed `login` is the exception — it returns the
terminal `loginDenied { reason }`.

## Versioning

`PROTOCOL_VERSION` (currently `1`) bumps on any breaking change to the message set.
The client sends it in `login`; the server denies a mismatch with `loginDenied`.

## Limits

Chat/PM text is capped at 8192 characters (a server abuse guard). A single inbound
WebSocket frame is capped at 256 KB. See [SECURITY-TODO.md](SECURITY-TODO.md) for
the broader threat model and open items.
