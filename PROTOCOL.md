# Mara 3 Wire Protocol

Transport: **WebSocket**, one **JSON text frame** per message. The schema lives in
`@mara/protocol` (Zod) and is imported by both the server and every client, so a
message shape changes in exactly one place and is validated identically on both ends.

## Frame shape

Flat, discriminated on `type`:

```json
{ "type": "chat", "channelToken": 12345, "text": "hello" }
```

Messages are split by direction into two unions. Each side validates only what it
can legitimately receive, which also lets a `chat` the client _sends_ (no author)
and a `chat` the server _broadcasts_ (with an author `from`) differ cleanly.

## Primitives

| Type        | JSON                                             | Replaces (Mara 2)            |
| ----------- | ------------------------------------------------ | ---------------------------- |
| `Token`     | uint32 number (0 … 4294967295)                   | `quint32` user/channel token |
| `Color`     | `"#rrggbb"`                                      | serialized `QColor`          |
| `Font`      | `{ family, pointSize, bold, italic, underline }` | serialized `QFont`           |
| `UserStyle` | `{ font, color }`                                | `MTextStyle`                 |
| `UserInfo`  | `{ token, name, style, away }`                   | `MUser`                      |

## Client → Server

`clientVersion` · `login` · `joinChannel` · `leaveChannel` · `chat` · `emote` ·
`away` · `privateMessage` · `userUpdate` · `ping` · `serverCommand` · `queryUser` ·
`disconnect` · `pluginData`

## Server → Client

`serverHello` · `response` · `loginAccepted` · `loginDenied` · `userConnect` ·
`userDisconnect` · `userUpdate` · `channelJoined` · `channelLeft` ·
`userJoinedChannel` · `userLeftChannel` · `chat` · `emote` · `away` ·
`privateMessage` · `pong` · `kicked` · `serverMessage` · `userInfo` · `pluginData` ·
`error`

## Handshake

1. Server → `serverHello { maraVersion, serverName }` on connect.
2. Client → `clientVersion { maraVersion, clientVersion, appVersion }`.
3. Client → `login { name, resumeToken?, style }`.
4. Server → `loginAccepted { token, name, resumeToken, motd }` **or**
   `loginDenied { reason, updateRequired }`.
5. Steady state: join/leave channels, chat/emote/away, private messages, ping/pong.

## Keepalive

App-level `ping`/`pong` carries `pingId` + timestamps for latency display; WebSocket
ping/pong frames handle liveness at the transport layer.

## Versioning

`PROTOCOL_VERSION` (currently `1`) bumps on any breaking change and is negotiated
during the handshake via the `clientVersion` exchange.
