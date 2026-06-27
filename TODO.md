# Mara 3 — TODO

Working list of things to do. See [ROADMAP.md](ROADMAP.md) for the forward-looking
feature plan (and explicit non-goals), [PARITY.md](PARITY.md) for the Mara 2 → 3
feature checklist, and [SECURITY-TODO.md](SECURITY-TODO.md) for the security
backlog.

## Bugs

- [x] Private messages breaking when a client disconnects — a PM peer's token is
      re-minted on reconnect, so the conversation stranded on the dead token. The
      client now migrates the thread (and the tab/active view) to the new token
      by name when the peer reconnects.

## Features

- [ ] **Legacy `[img]…[/img]` and `[spoiler]…[/spoiler]` tags (Mara 2 compatibility).**
      Support the old Mara BBCode-style tags so messages copied from / shared with the
      old client render the same: `[img]url[/img]` forces that URL inline as an image
      (regardless of extension — composes with the existing extension/query auto-detect
      and the `!<url>` marker), and `[spoiler]text[/spoiler]` renders a spoiler (the
      same hidden-until-clicked treatment as the current `||spoiler||` markdown). Add to
      the `@mara/chat-render` pipeline; escape contents as usual and keep the single-pass
      restore invariant. Consider whether to also accept other old tags (e.g. `[b]`/`[i]`)
      or stop at these two.

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
