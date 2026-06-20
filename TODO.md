# Mara 3 — TODO

Working list of things to do. See [PARITY.md](PARITY.md) for the Mara 2 → 3
feature checklist and [SECURITY-TODO.md](SECURITY-TODO.md) for the security
backlog.

## Bugs

- [x] Private messages breaking when a client disconnects — a PM peer's token is
      re-minted on reconnect, so the conversation stranded on the dead token. The
      client now migrates the thread (and the tab/active view) to the new token
      by name when the peer reconnects.

## Features

- [ ] _(add items here)_
