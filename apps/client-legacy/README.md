# @mara/client-legacy — Windows 7 desktop client (Tauri 1)

A separate build target for **Windows 7** (also runs on 8/8.1/10/11). The modern
[`@mara/shell`](../shell/README.md) is Tauri 2, which requires Windows 10+ and the
evergreen WebView2 runtime — neither available on Win7. This client uses **Tauri 1.x**,
the tier-3 **`x86_64-win7-windows-msvc`** Rust target, and a **bundled fixed-version
WebView2 runtime** so it can render the same hosted web UI on legacy machines. The
deliverable is a **portable** `Mara3-Legacy.exe` + the runtime folder + a launcher.

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
#   -> src-tauri/target/x86_64-win7-windows-msvc/release/Mara3-Legacy.exe
#      (also copied to dist/desktop-legacy/Mara3-Legacy.exe)
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

### 2. Add the fixed-version WebView2 runtime + launcher

Win7 has no evergreen WebView2, so ship a **Fixed Version** runtime beside the exe.
Download it from Microsoft's WebView2 distribution page (last Win7-capable ≈ Chromium 109) and extract it into a `webview2-runtime` folder next to `Mara3-Legacy.exe`. Then
launch via [`Run-Mara3-Legacy.bat`](Run-Mara3-Legacy.bat) (ship it too), which points
`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` at that folder so WebView2 uses the fixed runtime.

So a Win7 deployment folder is:

```
Mara3-Legacy.exe
Run-Mara3-Legacy.bat      <- run this
webview2-runtime\         <- the extracted fixed runtime (msedgewebview2.exe, ~120 MB)
settings.json             <- created on first run (portable, next to the exe)
```

## Status

The crate **compiles and links for `x86_64-win7-windows-msvc`**, and its **import
table is verified Win7-clean** (no `EventSetInformation`/ETW, no UCRT, nothing Win8+) —
an earlier build failed on Win7 at load with the `EventSetInformation` error, which the
shims above fix. Remaining to confirm an actual launch + render on Win7: drop in the
fixed WebView2 runtime (step 2) and run it on a real Win7 machine.
