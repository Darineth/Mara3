# @mara/shell — Tauri 2 native shell

Wraps the `@mara/web` build into native apps for **desktop (Windows/macOS/Linux)**
and **mobile (iOS/Android)**. The same web UI runs in all of them; this package is
the only native piece.

## Prerequisites (not required for the rest of the monorepo)

- **Rust** toolchain (`rustup`, stable ≥ 1.77) — <https://rustup.rs>
- Platform build tools:
  - Windows: Microsoft C++ Build Tools + WebView2 (preinstalled on Win 11)
  - macOS: Xcode Command Line Tools
  - Linux: `webkit2gtk-4.1`, `libappindicator`, `librsvg`, `patchelf` (see Tauri docs)
- Mobile: Xcode (iOS) / Android Studio + NDK (Android)

> The JS/TS packages and the web client build and test **without** Rust. Rust is
> only needed to compile this shell — which is why `@mara/shell` is intentionally
> excluded from the Turborepo `build`/`test`/`typecheck` pipeline.

## Desktop

```bash
pnpm --filter @mara/shell tauri:dev     # runs the web dev server + native window
pnpm --filter @mara/shell tauri:build   # produces installers in src-tauri/target
```

## Mobile (Tauri 2)

```bash
pnpm --filter @mara/shell tauri android init
pnpm --filter @mara/shell tauri android dev
pnpm --filter @mara/shell tauri ios init
pnpm --filter @mara/shell tauri ios dev
```

## Icons

`src-tauri/icons/icon.png` is the source icon (carried over from Mara 2). Generate
the full platform set with:

```bash
pnpm --filter @mara/shell icons
```

## Status — Spike A pending

The migration plan's **Spike A** (prove a Tauri 2 app boots on a desktop window
plus an iOS simulator and Android emulator) requires the Rust + mobile toolchains
above and has **not** been executed in this environment (no `cargo` installed).
The project is scaffolded to Tauri 2 conventions and ready to `init`/`dev` once the
toolchain is present.
