// Regenerate every app/web icon + splash/logo asset from the master logo art in
// resources/, in one shot. The source of truth is resources/Mara3Logo1_<Color>_1000.png
// (1000x1000, transparent); per-target colour:
//
//   Blue   -> desktop shell icons + web favicon/connect/splash + shell picker logo
//   Purple -> Win7 legacy client icons + its picker logo
//   Green  -> server shortcut/tray .ico
//
// What it does:
//   1. Runs `tauri icon` (the shell's Tauri 2 CLI) on each colour into a temp dir,
//      producing a full platform icon set (desktop/Android/iOS/Windows-Store).
//   2. Overwrites only the files that ALREADY EXIST in each target icons/ dir, so the
//      committed file set is preserved exactly — contents refresh, nothing added/removed.
//   3. Copies the derived single-image assets (the 256px 128x128@2x.png becomes each
//      logo.png; the Green icon.ico becomes the server .ico).
//
// Usage:
//   node scripts/generate-icons.mjs           regenerate everything
//   node scripts/generate-icons.mjs --keep-temp   leave the temp icon sets for inspection
//   (or: pnpm icons:gen)
//
// Needs Node + the @tauri-apps/cli dev dep (no Rust/cargo). After running, review the
// image diff in git before committing.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const keepTemp = process.argv.includes('--keep-temp');

// Master art -> per-colour icon-set targets (the icons/ dir whose existing files get
// refreshed). `iconsDir: null` means the colour is only mined for a derived asset below.
const SETS = [
  { color: 'Blue', label: 'desktop shell', iconsDir: 'apps/shell/src-tauri/icons' },
  { color: 'Purple', label: 'Win7 legacy', iconsDir: 'apps/client-legacy/src-tauri/icons' },
  { color: 'Green', label: 'server', iconsDir: null },
];

// Single-image assets pulled from a generated set: [colour, file-in-set, destinations].
// The picker/web logos are exactly the 256px 128x128@2x.png; the server icon is the .ico.
const DERIVED = [
  {
    color: 'Blue',
    from: '128x128@2x.png',
    to: ['apps/shell/bootstrap/logo.png', 'apps/web/public/logo.png'],
  },
  { color: 'Purple', from: '128x128@2x.png', to: ['apps/client-legacy/bootstrap/logo.png'] },
  { color: 'Green', from: 'icon.ico', to: ['apps/server/Mara3-Server.ico'] },
];

const sourceFor = (color) => join(root, 'resources', `Mara3Logo1_${color}_1000.png`);

/** Recursively list files under dir, relative to it. */
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

// --- 1. generate each colour's full icon set into a temp dir ---------------------

const colors = [...new Set([...SETS.map((s) => s.color), ...DERIVED.map((d) => d.color)])];
const tempRoot = join(tmpdir(), 'mara-icons');
rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });
const tempFor = (color) => join(tempRoot, color);

for (const color of colors) {
  const src = sourceFor(color);
  if (!existsSync(src)) {
    console.error(`MISSING source: ${relative(root, src)}`);
    process.exit(1);
  }
  console.log(`> tauri icon  ${color}`);
  // The shell carries the Tauri 2 CLI; `tauri icon -o` writes a full set into the dir.
  execFileSync(
    'pnpm',
    ['--filter', '@mara/shell', 'exec', 'tauri', 'icon', src, '-o', tempFor(color)],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
  );
}

// --- 2. refresh existing files in each target icons/ dir -------------------------

let misses = 0;

function refresh(label, targetRel, srcDir) {
  const targetDir = join(root, targetRel);
  let updated = 0;
  for (const rel of listFiles(targetDir)) {
    const src = join(srcDir, rel);
    if (!existsSync(src)) {
      console.error(`  MISS  ${label}: no generated counterpart for ${rel}`);
      misses++;
      continue;
    }
    copyFileSync(src, join(targetDir, rel));
    updated++;
  }
  console.log(`  ${label.padEnd(14)} refreshed ${updated} file(s) in ${targetRel}`);
}

for (const s of SETS) {
  if (s.iconsDir) refresh(s.label, s.iconsDir, tempFor(s.color));
}

// --- 3. copy the derived single-image assets ------------------------------------

for (const d of DERIVED) {
  const src = join(tempFor(d.color), d.from);
  if (!existsSync(src)) {
    console.error(`  MISS: generated ${d.color}/${d.from} not found`);
    misses++;
    continue;
  }
  for (const dest of d.to) {
    copyFileSync(src, join(root, dest));
    console.log(`  ${d.color.padEnd(14)} ${d.from} -> ${dest}`);
  }
}

if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });

if (misses) {
  console.error(`\n${misses} miss(es) — investigate before committing.`);
  process.exit(1);
}
console.log(
  '\nAll icons + logos regenerated from resources/. Review the git diff before committing.',
);
