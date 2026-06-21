# @mara/client-legacy — Windows 7 desktop client (Tauri 1)

A separate build target for **Windows 7** (also runs on 8/8.1/10/11). The modern
[`@mara/shell`](../shell/README.md) is Tauri 2, which requires Windows 10+ and the
evergreen WebView2 runtime — neither available on Win7. This client uses **Tauri
1.x** plus a **pinned, Win7-compatible WebView2 runtime** so it can render the same
hosted web UI on legacy machines.

It behaves like the modern shell: a server **picker** (address + recent + an
**Auto-connect on launch** checkbox, off by default) that persists to
`settings.json` **next to the executable**, then loads the chosen server's UI.

> ⚠️ Differences from the modern shell, by necessity:
>
> - **No in-app "Switch server"** (Tauri 1 lacks the runtime navigation the v2
>   version uses). Change servers from the launch picker — leave auto-connect off so
>   it always appears — or by editing `settings.json`.
> - **No native logging** on the remote page (the web app's `nativeLog` simply
>   no-ops there).
> - Everything here depends on **end-of-life** components (Win7, an EOL WebView2
>   runtime). Use only where Win7 support is genuinely required.

## What this environment can and can't produce

This repo can **compile and link** the client into a normal x64 exe (validating the
code/config). It can **not** produce or verify a true Win7 artifact on its own —
that needs the two pieces below and, for runtime confirmation, an actual Win7 box.

## Building for Windows 7

### 1. A Win7-capable Rust build

Modern stable Rust dropped Win7 from the default `x86_64-pc-windows-msvc` target.
Two options:

- **Simplest:** build with an **older stable toolchain** that still ran on Win7
  (≤ 1.77): `rustup toolchain install 1.77 && rustup override set 1.77` in
  `src-tauri/`, then build.
- **Modern toolchain:** use the tier-3 `x86_64-win7-windows-msvc` target on
  **nightly** with `-Z build-std`:
  `cargo +nightly build --release -Z build-std --target x86_64-win7-windows-msvc`.

### 2. A pinned WebView2 runtime (fixed version)

Win7 needs a bundled fixed-version runtime (the last line that supported Win7 is
~Chromium 109). Download the **fixed version** runtime from Microsoft's WebView2
distribution page, extract it, and place it at:

```
apps/client-legacy/src-tauri/webview2-runtime/
```

(This folder is git-ignored — it's ~120 MB.) Then point the bundler at it by adding
this to `tauri.conf.json` under `tauri.bundle` (it's left out of the committed config
so the project compiles without the 120 MB download — `tauri-build` validates the
path at compile time):

```jsonc
"windows": {
  "webviewInstallMode": { "type": "fixedRuntime", "path": "./webview2-runtime/" }
}
```

### 3. Build

```bash
# installer (NSIS) that bundles the fixed runtime — the reliable Win7 deliverable
pnpm --filter @mara/client-legacy tauri:build
```

`bundle.active` is `false` by default so the project compiles **without** the
runtime present (for validation). For the real Win7 build, set `bundle.active: true`
(targets `nsis`) with the runtime in place; the installer ships the runtime and the
exe. Output lands under `src-tauri/target/release/` (exe) and
`src-tauri/target/release/bundle/nsis/` (installer).

> A portable bare exe is possible too, but then the `webview2-runtime` folder must
> travel next to the exe (or `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` must point at it).
> The NSIS installer is the less error-prone route on Win7.

## Status

**Unverified on Windows 7 from this repo's CI/dev box.** The code compiles against
Tauri 1; the runtime + toolchain steps above and a real Win7 machine are required to
confirm it actually launches and renders there.
