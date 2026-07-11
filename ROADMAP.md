# Mara 3 — Roadmap

Forward-looking feature plan, framed against what a modern chat client (Discord/
Slack) offers. For the Mara 2 → 3 parity checklist see [PARITY.md](PARITY.md); for
the active working list see [TODO.md](TODO.md); for security work see
[SECURITY-TODO.md](SECURITY-TODO.md).

Mara is a **single-server, account-less, text-first** chat app. That framing is
deliberate — it's what keeps the protocol and deployment simple — and it's why the
"Not planned" section at the bottom is as long as the roadmap itself. Items here
are roughly ordered by value-for-effort on the current architecture (JSON-over-
WebSocket, one server, a Tauri shell for desktop).

**No guarantees.** This is a sketch of possibilities, not a commitment — nothing
here is promised, ordered firmly, or scheduled. What actually gets built (and in
what order) will be shaped by our community: the people who use Mara help decide
what we really want.

## 1. Modern messaging core (next up)

The highest value-for-effort cluster: all additive `@mara/protocol` messages over
the existing WebSocket model, no accounts or new infrastructure required. Each needs
a stable per-message id; that shared prerequisite is now in place, so the rest build
on it.

- [x] **Stable message ids** — server-assigned id on every chat/emote, carried in
      history (used to order and de-duplicate the backlog). The prerequisite for the
      rest of this section.
- [ ] **Reactions** — emoji reactions on a message; add/remove broadcast to the
      channel, tallied per emoji.
- [x] **Replies / threads** — reply to a specific message id, rendered as an inline
      "replying to…" quote bar above the message (click it to jump to the original).
      The client sends only the parent's id; the server resolves it against that channel's
      backlog and broadcasts the quoted snapshot (author + a one-line excerpt), which is
      retained in history so backlog replays keep their quotes. Channels only — PMs carry
      no message ids. Threaded views remain a possible follow-up.
- [ ] **Edit & delete** — author edits/removes their own message; broadcast an
      update so every client (and the backlog) reflects it.
- [ ] **@mentions** — `@name` parsing with highlight, plus the notification hooks
      below. Foundation for "only ping me when mentioned."

## 2. Notifications & presence

Plays directly to the existing Tauri desktop shell, which can raise native
notifications today.

- [ ] **Desktop notifications** — native ping on mention / DM / (optionally) any
      message, via the Tauri shell; nothing alerts you when unfocused today.
- [ ] **Per-conversation mute + notification level** — all / mentions-only / none,
      per channel and DM.
- [ ] **Keyword alerts** — notify on configurable words even without an @mention.
- [ ] **Unread/mention badges** — extend the existing unread indicators with
      mention counts and an app-level (taskbar/tray) badge.

## 3. Messaging richness

- [ ] **Arbitrary file attachments** — generalize the image upload pipeline
      (`/upload`, rolling cache, size caps) to any file type. Already flagged in
      PARITY as the remaining piece next to inline images.
- [ ] **Rich link unfurling** — OpenGraph cards for non-image links (Mara inlines
      image URLs/uploads but not regular-link previews).
- [ ] **Pinned messages** — pin/unpin per channel, with a pinned view.
- [ ] **Typing indicators** — transient "X is typing…" per conversation.
- [x] **Custom emoji** — server-hosted `:shortcode:` image emoji (operators drop files in an
      emoji folder; users can also add their own in-app), with a composer picker and
      `:`-autocomplete; animated GIF/WebP/APNG render. Follow-ups: a GIF _picker_ (Giphy-style
      search), and **downscaling animated uploads** — animated files are stored at full size
      today because the client-side resize can't preserve animation; a proper animated
      re-encoder (likely server-side) would keep them light.

## 4. Identity & social (lightweight)

Profile polish that does **not** require real accounts — still display-name +
identity-key based.

- [x] **Portable shared identity** — your display name + colour belong to your identity
      (persisted server-side) and follow it across clients; export/import your identity key
      to act as one identity on several devices.
- [ ] **Avatars** — per-user image (uploaded like attachments), shown in roster
      and message lines.
- [ ] **Richer profile / custom status** — bio and a free-form status beyond the
      current away note.

## 5. Search & history

- [ ] **Message search** — search channel (and eventually PM) history. Likely
      needs a real index/DB if history outgrows the current JSON-file store.
- [x] **Scroll to older history** — the server retains more per channel (default 1000,
      `MARA_HISTORY_LIMIT`) and pages older messages in on scroll-up.
- [x] **Remember joined channels** — the client persists the channels you're in and
      rejoins them on login.

## 6. In-session profile editing

- [x] **Change name / colour without reconnecting** — edit them in-session via the options
      dialog; changes broadcast live and follow your identity. Avatar follows the Avatars item.

## 7. Appearance & personalization (client-side)

Local display preferences — purely how *this* client renders chat for you, stored
per-install like the existing theme toggle. No protocol or server changes needed;
the palette is already CSS-variable driven (`--mara-*`).

- [ ] **Message display style** — let the user choose how messages are laid out: the
      current compact single-line style, a roomier Discord-like style (avatar +
      grouped author headers + more spacing), and room for others (e.g. IRC-style).
      A per-client setting; the renderer (`@mara/chat-render` + `ChatView`) switches
      layout from it.
- [ ] **Detailed theme / colour choices** — go beyond the System / Dark / Light
      toggle: pick an accent colour, choose from preset themes, and (longer term)
      tweak individual palette tokens (background, text, link, …). Mostly a settings
      UI over the existing `--mara-*` custom properties.

## 8. Server administration (operator-facing, long term)

Tools for whoever **runs** the server, gated by an operator secret rather than an
in-app role model — distinct from the "Moderation/admin platform" under *Not planned*
below, which would mean per-user roles + accounts the app intentionally lacks. This
is operator-scoped management of one's own server, not in-app moderation powers.

- [ ] **Admin page** — a server-operator console on a separate route, gated by an
      operator token/secret (never exposed to ordinary clients), to see live state and
      manage the running server: connected sessions and channels, recent activity /
      logs, upload-cache usage, and basic actions (drop a connection, clear an upload,
      prune history), plus runtime config (port, payload/size caps, history retention).
      Operator-only — it introduces no per-user roles or in-app moderation.

## Open questions — Mara 2 behaviours (community input)

Things Mara 2 did that Mara 3 deliberately changed or dropped. Whether to bring
them back is genuinely undecided — raised here for the community to weigh in on,
rather than promised or ruled out.

- **User-selectable fonts** — Mara 2 let users choose a font for their messages;
  Mara 3 renders everyone in one consistent UI font. Bring back a per-user (or
  per-client) font choice?
- **Message text in the author's colour** — Mara 2 coloured the whole message body
  in the author's colour; Mara 3 colours only the author's name and keeps body text
  in the default foreground (more legible, less noisy). Offer the old behaviour as an
  option?
- **Inline colour tags** — Mara 2 supported colour tags in message text (e.g.
  `[color=…]…[/color]`) so users could colour parts of a message; Mara 3's renderer
  drops them by design. Add them back, perhaps behind a setting? (Would extend the
  legacy-tag work already in `@mara/chat-render`.)

---

## Not planned (nope)

Deliberately out of scope. These would turn Mara from a lightweight single-server
chat into a platform, and most require an identity/permission model the app
intentionally doesn't have. Revisit only if the project's goals change.

- **Real accounts & authentication** — names are display labels, not owned
  identities (see [SECURITY-TODO.md](SECURITY-TODO.md)). No login, passwords, or
  SSO. The identity key gives a stable token, not proof of who you are.
- **Roles & permissions** — no admin/mod/member tiers or per-channel access
  control; every channel is public and joinable by name.
- **Moderation/admin platform** — kick/ban, audit logs, reporting. These depend on
  the accounts + roles model above. (Basic anti-abuse — text-length caps, frame
  caps — already exists and stays.)
- **Multiple servers / workspaces** — Mara is one server; no guild/workspace
  switching.
- **Voice / video / screen-share** — no real-time media stack.
- **Bots / webhooks / public API / server-side slash commands** — extensibility is
  client-side text plugins only (`@mara/plugin-api`); the ad-hoc `/me`, `/away`,
  `/shrug` are not a general command framework.

### Settled by design (not gaps)

- **Global presence** — presence is per-channel on purpose (matches Mara 2):
  clients learn who's around from channel rosters, not a server-wide online list.
- **Private messages are live-only** — PMs are never stored on the server (a deliberate
  privacy decision — see [SECURITY-TODO.md](SECURITY-TODO.md)); they reach only the devices
  connected when sent, and converge across a user's open windows. Not a gap.
