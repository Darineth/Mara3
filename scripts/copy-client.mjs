// Post-build step: copy a freshly-built desktop client exe into dist/<subdir>/ under
// a predictable, friendly name. Wired into each client's `tauri:build` script so a
// build deploys straight into the dist/ tree alongside the other distributables.
//
//   node scripts/copy-client.mjs <crateDir> <srcBase> <destBase> <distSubdir> [target]
//   e.g. node scripts/copy-client.mjs apps/shell mara-shell Mara3 desktop
//        node scripts/copy-client.mjs apps/client-legacy mara-client-legacy Mara3 desktop-legacy x86_64-win7-windows-msvc
//
// <srcBase> is the built binary's base name (Tauri 2 names it after the Cargo bin;
// Tauri 1 after productName). The platform exe extension is appended automatically.
// <distSubdir> is the folder under dist/ to copy into (e.g. desktop, desktop-legacy).
// [target] (optional) is the Rust target triple — when cross/tier-3 building, the
// binary lands in target/<triple>/release/ instead of target/release/.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [crateDir, srcBase, destBase, distSubdir, target] = process.argv.slice(2);
if (!crateDir || !srcBase || !destBase || !distSubdir) {
  console.error('usage: copy-client.mjs <crateDir> <srcBase> <destBase> <distSubdir> [target]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const releaseDir = target
  ? join(root, crateDir, 'src-tauri', 'target', target, 'release')
  : join(root, crateDir, 'src-tauri', 'target', 'release');
const src = join(releaseDir, `${srcBase}${ext}`);
const destDir = join(root, 'dist', distSubdir);
const dest = join(destDir, `${destBase}${ext}`);

if (!existsSync(src)) {
  console.error(`copy-client: build output not found at ${src} — did "tauri build" run?`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log(`copy-client: ${dest} (${mb} MB)`);
