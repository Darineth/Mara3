# @mara/client-legacy — Windows 7 desktop client (Tauri 1)

A separate build target for **Windows 7** (also runs on 8/8.1/10/11). The modern
[`@mara/shell`](../shell/README.md) is Tauri 2, which requires Windows 10+ and the
evergreen WebView2 runtime — neither available on Win7. This client uses **Tauri 1.x**,
the tier-3 **`x86_64-win7-windows-msvc`** Rust target, and a **bundled fixed-version
WebView2 runtime** so it can render the same hosted web UI on legacy machines. The
deliverable is a **portable** `Mara3.exe` + the runtime folder + a launcher.

It behaves like the modern shell: a server **picker** (address + recent + an
**Auto-connect on launch** checkbox, off by default) that persists to
`settings.json` **next to the executable**, then loads the chosen server's UI.

> ⚠️ Differences from the modern shell, by necessity:
>
> - **No in-app "Switch server"** (Tauri 1 lacks the runtime navigation the v2
>   version uses). Change servers from the launch picker — leave auto-connect off so
>   it always appears — or by editing `settings.json`.
> - Everything here depends on **end-of-life** components (Win7, an EOL WebView2
>   runtime). Use only where Win7 support is genuinely required.

## Native logging

Like the modern shell, the loaded web UI can write a local log via `mara_log`
(`src-tauri/src/main.rs`), split per channel into a monthly file:
`<logDir>/<channel>/Mara3_YYYY-MM.log` (the month comes from Win32 `GetLocalTime` —
no date crate, since `chrono`'s Windows path needs WinRT, absent on Win7). `logDir`
defaults to `logs/` relative to the **current working directory** (the directory the
client is launched from). A missing or `null` `logDir` keeps that default — **only an
explicit `"logDir": ""` disables disk logging.** Otherwise set `"logDir"` to redirect it
(absolute as-is, relative to the working directory). The launch picker shows the resolved
absolute log directory (or "Logging disabled") on a faint line under the form.

Because the UI is loaded from a **remote** origin, it can only reach `mara_log` for
servers the client grants IPC to. Rather than hardcoding hosts, the client grants
access **at runtime to exactly the server you connect to** (`grant_remote_ipc` in
`src-tauri/src/main.rs`, via `ipc_scope().configure_remote_access(...)`) — Tauri 1
forbids config wildcards, so this runtime scope is the supported escape hatch. Only
connect to servers you trust, since that page can then call the native command.

> ⚠️ **Bare IP-address servers won't get the native bridge** (e.g.
> `http://192.168.1.5:5050`): Tauri 1's remote-IPC matching can't match IP hosts
> ([tauri#7009](https://github.com/tauri-apps/tauri/issues/7009)). Use a DNS hostname.
>
> This costs more than logging. With no bridge the page can't reach `shell.open`
> either, so **external links and file downloads fall back to `window.open`** — which
> the webview services by opening an **internal window** rather than your browser (and
> for a download, that window is blank, since an attachment has nothing to render).
> Connected by hostname, both open in the default browser as intended. Confirmed
> behaviour, 2026-07-25.

## Updates (portable "update available" nudge)

Mirrors the modern shell — the exe stays portable, and the picker's **"update available"**
banner offers **Update now** (download, checksum, swap the exe, restart — shared with the
modern client via `crates/mara-swap`) beside the **Download** link that opens the system
browser via Tauri 1's `shell.open`. Because
this is a **separate download** from the modern desktop client, it polls its **own**
manifest: `MARA_UPDATE_BASE_URL/latest-windows7-x64.json` (default base the repo's GitHub
Releases `latest` download endpoint, baked in by `scripts/package-legacy.mjs`),
which `scripts/zip-dist.mjs` writes pointing at the `Mara3-windows7-x64-latest.zip`. To publish a
Win7 update: attach the new zip **and** `latest-windows7-x64.json` to the release (see
`scripts/release-github.mjs`); the host must serve the JSON with
`Access-Control-Allow-Origin: *` (cross-origin fetch). Build with
`MARA_UPDATE_URL=` empty to disable. See [`../shell/README.md`](../shell/README.md#updates-portable-update-available-nudge)
for the shared design.

## Building for Windows 7

### 1. Build the exe (toolchain handled for you)

Modern stable Rust dropped Win7 from the default `x86_64-pc-windows-msvc` target, and
Tauri 1.8's transitive deps now need newer Rust than the last Win7-capable stable
(≤ 1.77) can build. So this crate targets the tier-3 **`x86_64-win7-windows-msvc`**
target and compiles `std` from source (`build-std`). [`rust-toolchain.toml`](src-tauri/rust-toolchain.toml)
pins a specific **nightly** + the `rust-src` component (rustup auto-installs both); the
build script passes `--target` and `-Z build-std`. You only need `rustup` installed:

```bash
pnpm --filter @mara/client-legacy tauri:build
#   -> src-tauri/target/x86_64-win7-windows-msvc/release/mara-client-legacy.exe
#      (copied to dist/desktop-legacy/Mara3.exe)
```

This builds a real Win7-target exe via raw `cargo` (not the Tauri CLI, which won't
drive a build-std target). The icon and the bootstrap picker are embedded into it.

Several in-tree workarounds make the binary build and actually run on Win7:

- `Cargo.toml` forces `indexmap`'s `std` feature (which `build-std` otherwise drops,
  breaking `kuchikiki`).
- `build.rs` adds the `windows.lib` search path the old `windows 0.39` crate skips for
  the `win7` triple (otherwise `LNK1181`).
- [`src/win7_compat.rs`](src-tauri/src/win7_compat.rs) stubs the MSVC CRT's ETW imports
  (`EventSetInformation` is Win8+; `build-std` fixes Rust `std` but not the CRT — without
  this the EXE fails to load on Win7 with _"entry point EventSetInformation could not be
  located in ADVAPI32.dll"_).
- [`.cargo/config.toml`](src-tauri/.cargo/config.toml) statically links the CRT for the
  win7 target, so the exe doesn't need `VCRUNTIME140.dll` / the UCRT (absent on a clean
  Win7 SP1). Target-scoped, so it doesn't affect `tauri:dev`.

The built exe's import table is verified to reference **only Win7-available DLLs/APIs**
(`dumpbin /imports` — no ETW, no UCRT, nothing Win8+).

### 2. Add the fixed-version WebView2 runtime

Win7 has no evergreen WebView2, so ship a **Fixed Version** runtime beside the exe.
Download it from Microsoft's WebView2 distribution page (last Win7-capable ≈ Chromium 109)
and extract it into a `webview2-runtime` folder next to `Mara3.exe`. That's all: at startup
`use_bundled_webview2` (`src-tauri/src/main.rs`) points `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER`
at that folder before the first window is built, which is when WebView2's loader reads it —
so double-clicking `Mara3.exe` works, and the self-update's relaunch doesn't depend on
inheriting the variable from whatever started the app. An explicit value in the environment
always wins, so [`Run-Mara3.bat`](Run-Mara3.bat) (which sets it, then launches the exe) still
works and is still shipped for anyone whose shortcut points at it, or who keeps the runtime
elsewhere. The folder is only adopted when it really holds `msedgewebview2.exe`, so testing
this build on a modern Windows still uses the evergreen runtime.

So a Win7 deployment folder is:

```
Mara3.exe                 <- run this
webview2-runtime\         <- the extracted fixed runtime (msedgewebview2.exe, ~120 MB)
Run-Mara3.bat             <- optional launcher / override
settings.json             <- created on first run (portable, next to the exe)
```

## Status

The crate **compiles and links for `x86_64-win7-windows-msvc`**, and its **import
table is verified Win7-clean** (no `EventSetInformation`/ETW, no UCRT, nothing Win8+) —
an earlier build failed on Win7 at load with the `EventSetInformation` error, which the
shims above fix. Remaining to confirm an actual launch + render on Win7: drop in the
fixed WebView2 runtime (step 2) and run it on a real Win7 machine.
