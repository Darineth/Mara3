# apps/client — built desktop clients

This folder holds the **built desktop client exes**, copied here by each client's
`tauri:build` (via `scripts/copy-client.mjs`):

```
Mara3-Desktop.exe   modern client  — Tauri 2 (Windows 10/11), from apps/shell
Mara3-Legacy.exe    legacy client  — Tauri 1 (Windows 7+),    from apps/client-legacy
```

(On macOS/Linux the names have no `.exe`.) The binaries are git-ignored (only this
README is tracked) — they're build artifacts, not source. Rebuild any time:

```bash
pnpm --filter @mara/shell tauri:build          # -> Mara3-Desktop.exe
pnpm --filter @mara/client-legacy tauri:build  # -> Mara3-Legacy.exe
```

`pnpm package` also writes the modern client to `dist/desktop/`.

Both open a window pointed at a Mara server (via the in-app picker / `MARA_URL`), so a
server must be reachable. The modern client needs the system WebView2 runtime
(preinstalled on Win 11); the legacy client targets Win7 and needs its bundled fixed
WebView2 runtime — see [../shell/README.md](../shell/README.md) and
[../client-legacy/README.md](../client-legacy/README.md).
