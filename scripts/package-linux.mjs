// pnpm package:linux — build the Linux desktop client in WSL and stage its .tar.gz for
// the release. The shell is plain Tauri 2 (cross-platform), but Tauri can't cross-compile
// the native webview, so the binary has to be built on Linux. This drives a WSL distro:
// it mirrors the working tree into a Linux-side build dir, builds the shell there, and
// tars the binary ON Linux (so its executable bit survives — Windows can't author that)
// into dist/prebuilt/. A later `pnpm package:zip` folds that staged tarball into the
// release verbatim (zip-dist.mjs's "prebuilt" intake). The same staging seam is what a
// CI ubuntu runner would feed later.
//
//   pnpm package:linux              build + stage the Linux client via WSL
//   pnpm package:linux --dry-run    print the plan + the WSL build script, run nothing
//   then: pnpm package:zip          (or pnpm package:all) assembles dist/zips/
//
// Requires WSL2 with the Linux toolchain already installed (Rust + webkit2gtk-4.1 +
// librsvg + patchelf + rsync; see apps/shell/README.md). Config via env:
//   MARA_WSL_DISTRO       distro name (default: WSL's default distro)
//   MARA_WSL_DIR          Linux-side build dir (default: $HOME/mara-linux-build; if you
//                         override it, use $HOME or an absolute path, not a ~)
//   MARA_UPDATE_BASE_URL  update-nudge host (default below); MARA_UPDATE_URL= to disable

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const prebuiltDir = join(dist, 'prebuilt');
const stagedName = 'Mara3-linux-x64.tar.gz';
const dryRun = process.argv.includes('--dry-run');

// Keep in sync with package.mjs / zip-dist.mjs. The Linux client polls its own manifest.
const UPDATE_BASE_URL = 'https://mara.pretoast.com/mara3-updates';
const updateBase = (process.env.MARA_UPDATE_BASE_URL || UPDATE_BASE_URL).replace(/\/+$/, '');
const updateUrl = process.env.MARA_UPDATE_URL ?? `${updateBase}/latest-linux-x64.json`;

const distro = process.env.MARA_WSL_DISTRO || '';
const distroArg = distro ? `-d ${distro}` : '';
// $HOME stays literal so bash expands it inside the script (a ~ from a variable wouldn't).
const wslDir = process.env.MARA_WSL_DIR || '$HOME/mara-linux-build';

/** Map a Windows path to its WSL /mnt path. Done here (not via `wslpath`) because the
 *  shell mangles the backslashes before wslpath sees them; this is exact and dependency-free. */
function toMnt(winPath) {
  const m = /^([A-Za-z]):(.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}${m[2].replace(/\\/g, '/')}`;
}

function wsl(cmd, opts = {}) {
  return execSync(`wsl ${distroArg} ${cmd}`, { stdio: 'pipe', ...opts })
    .toString()
    .trim();
}

const winMnt = toMnt(root);
const prebuiltMnt = toMnt(join(prebuiltDir, stagedName));

// The build script that runs inside WSL. Uses only `$VAR` (no `${...}`) so it doesn't
// collide with this JS template literal — the only interpolations here are ours.
const script = `#!/usr/bin/env bash
set -euo pipefail

# Pick up the user's toolchain PATH (rustup / pnpm) however their shell sets it up.
for f in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.cargo/env"; do [ -f "$f" ] && . "$f" || true; done
export PATH="$HOME/.cargo/bin:$HOME/.local/share/pnpm:$PATH"

SRC="${winMnt}"
DIR="${wslDir}"
OUT="${prebuiltMnt}"

echo ">> syncing working tree -> $DIR"
mkdir -p "$DIR"
rsync -a --delete --exclude node_modules --exclude target --exclude dist --exclude .git "$SRC/" "$DIR/"

cd "$DIR"
echo ">> pnpm install"
pnpm install
echo ">> building @mara/shell (Tauri 2, Linux x64)"
MARA_UPDATE_URL="${updateUrl}" pnpm --filter @mara/shell tauri:build

echo ">> staging tarball -> $OUT"
[ -f dist/desktop-linux/Mara3 ] || { echo "ERROR: build produced no dist/desktop-linux/Mara3"; exit 1; }
mkdir -p "$(dirname "$OUT")"
tar -a -c -f "$OUT" -C dist/desktop-linux Mara3
echo ">> staged $(du -h "$OUT" | cut -f1)"
`;

console.log('package:linux — build the Linux desktop client via WSL\n');
console.log(`  distro:     ${distro || '(default)'}`);
console.log(`  build dir:  ${wslDir}`);
console.log(`  source:     ${winMnt}`);
console.log(`  staging:    dist/prebuilt/${stagedName}`);
console.log(`  update URL: ${updateUrl || '(disabled)'}\n`);

if (dryRun) {
  console.log('--- WSL build script (--dry-run; nothing executed) ---\n');
  console.log(script);
  process.exit(0);
}

// Preflight: WSL reachable + rsync present (the one non-obvious dependency; cargo/pnpm
// errors surface from the build itself, which sources the user's profile for PATH).
try {
  wsl('bash -lc "command -v rsync >/dev/null"');
} catch {
  console.error(
    'package:linux: WSL not reachable, or rsync is missing in the distro.\n' +
      '  - Install WSL2 (https://aka.ms/wsl) and a distro, then inside it: sudo apt install rsync\n' +
      '  - Set MARA_WSL_DISTRO if it is not your default distro.',
  );
  process.exit(1);
}

mkdirSync(prebuiltDir, { recursive: true });
const scriptPath = join(prebuiltDir, '_build-linux.sh');
writeFileSync(scriptPath, script.replace(/\r\n/g, '\n')); // LF for bash
const scriptMnt = toMnt(scriptPath);

try {
  execSync(`wsl ${distroArg} bash "${scriptMnt}"`, { stdio: 'inherit' });
} catch {
  console.error('\npackage:linux: the WSL build failed (see output above).');
  process.exit(1);
} finally {
  rmSync(scriptPath, { force: true });
}

const staged = join(prebuiltDir, stagedName);
if (!existsSync(staged)) {
  console.error(`\npackage:linux: expected staged tarball missing: ${staged}`);
  process.exit(1);
}

console.log('\n============================================================');
console.log(` Done. Staged Linux client: dist/prebuilt/${stagedName}`);
console.log('   Next: pnpm package:zip (or pnpm package:all) folds it into dist/zips/');
console.log('         as Mara3-linux-x64-*.tar.gz + latest-linux-x64.json.');
console.log('============================================================');
