# apps/client — built desktop client

This folder holds the **portable desktop client** produced by the build:

```
Mara3-Desktop.exe   (Windows; "Mara3-Desktop" on macOS/Linux)
```

It is written here automatically by `pnpm --filter @mara/shell tauri:build` (via
`scripts/copy-client.mjs`) after the Tauri build compiles the standalone executable
at `apps/shell/src-tauri/target/release/`. It's a single self-contained file — copy
it anywhere and double-click; it needs only the system WebView2 runtime (preinstalled
on Windows 11).

The binary itself is git-ignored (only this README is tracked) — it's a build
artifact, not source. Rebuild it any time with `tauri:build`, or get it alongside the
self-contained server via `pnpm package` (which also writes `dist/desktop/`).

On launch the client opens a window pointed at `MARA_URL` (default
`http://localhost:5050`), so a Mara server must be reachable there. See
[../shell/README.md](../shell/README.md).
