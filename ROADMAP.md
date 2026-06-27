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
the existing WebSocket model, no accounts or new infrastructure required. Each
needs a stable per-message id (today messages aren't individually addressable),
so introducing a server-assigned message id is the shared prerequisite.

- [ ] **Stable message ids** — server-assigned id on every chat/emote, carried in
      history. Prerequisite for everything else in this section.
- [ ] **Reactions** — emoji reactions on a message; add/remove broadcast to the
      channel, tallied per emoji.
- [ ] **Replies / threads** — reply to a specific message id; start with inline
      "replying to…" quoting, optionally grow into threaded views later.
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
- [ ] **Syntax-highlighted code blocks** — code blocks render today, but
      monochrome; add language detection/highlighting in `@mara/chat-render`.
- [ ] **Rich link unfurling** — OpenGraph cards for non-image links (Mara inlines
      image URLs/uploads but not regular-link previews).
- [ ] **Pinned messages** — pin/unpin per channel, with a pinned view.
- [ ] **Typing indicators** — transient "X is typing…" per conversation.
- [ ] **Custom emoji / emoji + GIF pickers** — beyond the current opt-in text
      emoticons.

## 4. Identity & social (lightweight)

Profile polish that does **not** require real accounts — still display-name +
identity-key based.

- [ ] **Avatars** — per-user image (uploaded like attachments), shown in roster
      and message lines.
- [ ] **Richer profile / custom status** — bio and a free-form status beyond the
      current away note.
- [ ] **Group DMs** — multi-party private conversations; today `privateMessage`
      targets exactly one user token (1:1 only).
- [ ] **Block a user** — client-side hide, optionally enforced server-side.

## 5. Search & history

- [ ] **Message search** — search channel (and eventually PM) history. Likely
      needs a real index/DB if history outgrows the current JSON-file store.
- [ ] **Scroll to older history** — backlog is capped (~100/channel) with no way
      to page further back; add server-side history paging.
- [ ] **Persisted PM history** — private messages are intentionally not retained
      across sessions today; make it opt-in.
- [ ] **Remember joined channels** — auto-rejoin a user's channels on login
      (carried over from PARITY's follow-ups).

## 6. In-session profile editing

- [ ] **Change name / colour / avatar without reconnecting** — today appearance is
      set on the connect screen only.

## 7. Server administration (operator-facing, long term)

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
