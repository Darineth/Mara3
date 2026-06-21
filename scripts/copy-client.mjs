// Post-build step for @mara/shell: copy the freshly-built portable desktop client
// into apps/client/ as a predictable, friendly-named distributable. Wired into the
// shell's `tauri:build` script, so it runs after every desktop build.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
// Tauri names the binary after the Cargo bin (mara-shell); .exe on Windows only.
const ext = process.platform === 'win32' ? '.exe' : '';
const src = join(root, 'apps', 'shell', 'src-tauri', 'target', 'release', `mara-shell${ext}`);
const destDir = join(root, 'apps', 'client');
const dest = join(destDir, `Mara3-Desktop${ext}`);

if (!existsSync(src)) {
  console.error(`copy-client: build output not found at ${src} — did "tauri build" run?`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log(`copy-client: ${dest} (${mb} MB)`);
