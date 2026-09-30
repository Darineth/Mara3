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
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
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
// The modern shell builds once per OS into a generic 'desktop' subdir; route it to an
// OS-specific folder so Windows and Linux builds don't overwrite each other and zip-dist
// can name each (Mara3-windows-x64 vs Mara3-linux-x64). Other subdirs (desktop-legacy)
// are literal — that client is Windows-only.
const subdir =
  distSubdir === 'desktop' && process.platform === 'linux' ? 'desktop-linux' : distSubdir;
const destDir = join(root, 'dist', subdir);
const dest = join(destDir, `${destBase}${ext}`);

// macOS ships the .app bundle (tauri.macos.conf.json turns the bundler on there), not the
// bare binary — without the bundle it runs iconless, outside the Dock, unsigned. Copy the
// whole bundle into dist/desktop-macos/, symlinks kept as-is, plus the drag-to-Applications
// DMG built beside it.
if (process.platform === 'darwin' && distSubdir === 'desktop') {
  const conf = JSON.parse(
    readFileSync(join(root, crateDir, 'src-tauri', 'tauri.conf.json'), 'utf8'),
  );
  const app = `${conf.productName}.app`;
  const bundle = join(releaseDir, 'bundle', 'macos', app);
  if (!existsSync(bundle)) {
    console.error(`copy-client: app bundle not found at ${bundle} — did "tauri build" run?`);
    process.exit(1);
  }
  const macDir = join(root, 'dist', 'desktop-macos');
  rmSync(macDir, { recursive: true, force: true });
  mkdirSync(macDir, { recursive: true });
  cpSync(bundle, join(macDir, app), { recursive: true, verbatimSymlinks: true });
  console.log(`copy-client: ${join(macDir, app)}`);
  const dmgDir = join(releaseDir, 'bundle', 'dmg');
  for (const f of existsSync(dmgDir) ? readdirSync(dmgDir) : []) {
    if (!f.endsWith('.dmg')) continue;
    copyFileSync(join(dmgDir, f), join(macDir, f));
    console.log(`copy-client: ${join(macDir, f)}`);
  }
  process.exit(0);
}

if (!existsSync(src)) {
  console.error(`copy-client: build output not found at ${src} — did "tauri build" run?`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
const mb = (statSync(dest).size / (1024 * 1024)).toFixed(1);
console.log(`copy-client: ${dest} (${mb} MB)`);
