// Post-build step: copy a freshly-built desktop client exe into apps/client/ under
// a predictable, friendly name. Wired into each client's `tauri:build` script.
//
//   node scripts/copy-client.mjs <crateDir> <srcBase> <destBase>
//   e.g. node scripts/copy-client.mjs apps/shell         mara-shell    Mara3-Desktop
//        node scripts/copy-client.mjs apps/client-legacy Mara3-Legacy  Mara3-Legacy
//
// <srcBase> is the built binary's base name (Tauri 2 names it after the Cargo bin;
// Tauri 1 after productName). The platform exe extension is appended automatically.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [crateDir, srcBase, destBase] = process.argv.slice(2);
if (!crateDir || !srcBase || !destBase) {
  console.error('usage: copy-client.mjs <crateDir> <srcBase> <destBase>');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const src = join(root, crateDir, 'src-tauri', 'target', 'release', `${srcBase}${ext}`);
const destDir = join(root, 'apps', 'client');
const dest = join(destDir, `${destBase}${ext}`);

if (!existsSync(src)) {
  console.error(`copy-client: build output not found at ${src} — did "tauri build" run?`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log(`copy-client: ${dest} (${mb} MB)`);
