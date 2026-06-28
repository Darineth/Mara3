// Single-command version bump across Mara's polyglot manifests. The version lives in
// three ecosystems that don't share a source of truth — npm (every workspace
// package.json), Cargo (each Tauri client's Cargo.toml + Cargo.lock), and Tauri
// (each tauri.conf.json, which stamps the exe's Windows FileVersion) — so a release
// has to move all of them in lockstep. This keeps that one command, and fails loudly
// if any manifest has drifted out of lockstep so a stray version can't ship silently.
//
//   node scripts/bump-version.mjs 3.0.2     bump every manifest to 3.0.2
//   node scripts/bump-version.mjs --check    verify they all agree (CI/pre-flight); no writes
//   node scripts/bump-version.mjs 3.0.2 --force   bump even if currently drifted (re-aligns all)
//
// Wired as `pnpm bump <version>` / `pnpm bump --check` (see root package.json).
// The source of truth for "the current version" is the root package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// Each target declares how to read its version and how to rewrite it in place — string
// surgery, not a reserialize, so formatting/comments are preserved. A target whose
// pattern doesn't match is a hard error (loud miss), never a silent skip.
const JSON_PKGS = [
  'package.json',
  'packages/ui/package.json',
  'packages/protocol/package.json',
  'packages/chat-render/package.json',
  'packages/client-core/package.json',
  'packages/plugin-api/package.json',
  'apps/web/package.json',
  'apps/server/package.json',
  'apps/shell/package.json',
  'apps/client-legacy/package.json',
];

const targets = [
  // npm: the top-level "version" of each workspace package. The only "version" key in a
  // package.json is the package's own (deps are name->range), so first-match is safe.
  ...JSON_PKGS.map((file) => ({ file, kind: 'json', get: (o) => o.version })),
  // Tauri: shell config has a top-level version; legacy nests it under "package".
  { file: 'apps/shell/src-tauri/tauri.conf.json', kind: 'json', get: (o) => o.version },
  {
    file: 'apps/client-legacy/src-tauri/tauri.conf.json',
    kind: 'json',
    get: (o) => o.package.version,
  },
  // Cargo: the [package] version baked into the exe as CARGO_PKG_VERSION.
  { file: 'apps/shell/src-tauri/Cargo.toml', kind: 'cargo-toml' },
  { file: 'apps/client-legacy/src-tauri/Cargo.toml', kind: 'cargo-toml' },
  // Cargo.lock: the same crate's recorded version (or cargo rewrites it on next build).
  { file: 'apps/shell/src-tauri/Cargo.lock', kind: 'cargo-lock', crate: 'mara-shell' },
  {
    file: 'apps/client-legacy/src-tauri/Cargo.lock',
    kind: 'cargo-lock',
    crate: 'mara-client-legacy',
  },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Read a target's current version. Throws (loud) if the manifest shape is unexpected. */
function readVersion(src, t) {
  if (t.kind === 'json') {
    const v = t.get(JSON.parse(src));
    if (typeof v !== 'string') throw new Error(`no version field in ${t.file}`);
    return v;
  }
  if (t.kind === 'cargo-toml') {
    const m = src.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
    if (!m) throw new Error(`no [package] version in ${t.file}`);
    return m[1];
  }
  if (t.kind === 'cargo-lock') {
    const m = src.match(new RegExp(`name = "${t.crate}"\\nversion = "([^"]+)"`));
    if (!m) throw new Error(`crate "${t.crate}" not found in ${t.file}`);
    return m[1];
  }
  throw new Error(`unknown kind ${t.kind}`);
}

/** Rewrite a target's version from `from` to `to`, preserving everything else. */
function rewrite(src, t, from, to) {
  if (t.kind === 'json') {
    return src.replace(`"version": "${from}"`, `"version": "${to}"`);
  }
  if (t.kind === 'cargo-toml') {
    return src.replace(
      /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/,
      (_m, pre, post) => `${pre}${to}${post}`,
    );
  }
  // cargo-lock
  return src.replace(
    `name = "${t.crate}"\nversion = "${from}"`,
    `name = "${t.crate}"\nversion = "${to}"`,
  );
}

// --- run ------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes('--force');
const check = args.includes('--check');
const newVersion = args.find((a) => !a.startsWith('--'));

if (!check && !newVersion) {
  console.error('Usage: node scripts/bump-version.mjs <version> [--force]   |   --check');
  process.exit(2);
}
if (newVersion && !SEMVER.test(newVersion)) {
  console.error(`Not a valid semver version: "${newVersion}" (expected e.g. 3.0.2)`);
  process.exit(2);
}

// Load every target and read its current version up front.
const loaded = targets.map((t) => {
  const path = join(root, t.file);
  const src = readFileSync(path, 'utf8');
  return { t, path, src, version: readVersion(src, t) };
});

const current = loaded.find((l) => l.t.file === 'package.json').version;
const drift = loaded.filter((l) => l.version !== current);

if (drift.length) {
  console.error(`Version drift — these disagree with root package.json (${current}):`);
  for (const l of drift) console.error(`  ${l.version.padEnd(10)} ${l.t.file}`);
  if (check || !force) {
    console.error(
      check
        ? '\nManifests are NOT in lockstep.'
        : '\nRefusing to bump on drift. Re-run with --force to re-align everything to the new version.',
    );
    process.exit(1);
  }
}

if (check) {
  console.log(`All ${loaded.length} manifests in lockstep at ${current}.`);
  process.exit(0);
}

let changed = 0;
for (const l of loaded) {
  const out = rewrite(l.src, l.t, l.version, newVersion);
  if (out === l.src) {
    if (l.version === newVersion) {
      console.log(`  ==    ${l.t.file}  (already ${newVersion})`);
      continue;
    }
    console.error(`  MISS  ${l.t.file}  (pattern for ${l.version} did not match)`);
    process.exit(1);
  }
  writeFileSync(l.path, out);
  changed++;
  console.log(`  ok    ${l.t.file}  ${l.version} -> ${newVersion}`);
}

console.log(`\nBumped ${changed} manifest(s) ${current} -> ${newVersion}.`);
