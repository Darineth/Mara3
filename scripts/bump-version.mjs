// Version bump across Mara's manifests, split into two independently-released TRACKS:
//
//   app     server + web + the product (root) version — bumped on server/web releases.
//   client  both desktop shells — bumped ONLY on native client changes. This is what
//           the update nudge + the titlebar/picker key off; an app release must NOT
//           move it, or installed clients would be told to re-download an identical
//           client.
//
// Each track spans the three manifest ecosystems it touches (npm package.json, Cargo
// Cargo.toml/Cargo.lock, Tauri tauri.conf.json) and is bumped in lockstep within the
// track. The private packages/* are intentionally NOT managed here — they're
// workspace-linked, their versions are never read, so they stay frozen.
//
//   node scripts/bump-version.mjs app 3.1.0        bump the app track to 3.1.0
//   node scripts/bump-version.mjs client 3.0.2     bump the client track to 3.0.2
//   node scripts/bump-version.mjs --check          verify every track is internally in lockstep
//   node scripts/bump-version.mjs client --check    ...just the client track
//   node scripts/bump-version.mjs app 3.1.0 --force  bump even if the track is currently drifted
//
// Wired as `pnpm bump <track> <version>` / `pnpm version:check` (root package.json).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// Each target declares how to read its version and how to rewrite it in place — string
// surgery, not a reserialize, so formatting/comments are preserved. `canonical` is the
// track's reference file (drift = a target disagreeing with it).
const TRACKS = {
  app: {
    desc: 'server + web + product (root)',
    canonical: 'package.json',
    targets: [
      { file: 'package.json', kind: 'json', get: (o) => o.version },
      { file: 'apps/server/package.json', kind: 'json', get: (o) => o.version },
      { file: 'apps/web/package.json', kind: 'json', get: (o) => o.version },
    ],
  },
  client: {
    desc: 'both desktop shells (drives the update nudge)',
    canonical: 'apps/shell/src-tauri/Cargo.toml',
    targets: [
      { file: 'apps/shell/package.json', kind: 'json', get: (o) => o.version },
      { file: 'apps/client-legacy/package.json', kind: 'json', get: (o) => o.version },
      { file: 'apps/shell/src-tauri/tauri.conf.json', kind: 'json', get: (o) => o.version },
      {
        file: 'apps/client-legacy/src-tauri/tauri.conf.json',
        kind: 'json',
        get: (o) => o.package.version,
      },
      { file: 'apps/shell/src-tauri/Cargo.toml', kind: 'cargo-toml' },
      { file: 'apps/client-legacy/src-tauri/Cargo.toml', kind: 'cargo-toml' },
      { file: 'apps/shell/src-tauri/Cargo.lock', kind: 'cargo-lock', crate: 'mara-shell' },
      {
        file: 'apps/client-legacy/src-tauri/Cargo.lock',
        kind: 'cargo-lock',
        crate: 'mara-client-legacy',
      },
    ],
  },
};

const TRACK_NAMES = Object.keys(TRACKS);
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

/** Load a track's targets and read each current version. */
function loadTrack(track) {
  return TRACKS[track].targets.map((t) => {
    const path = join(root, t.file);
    const src = readFileSync(path, 'utf8');
    return { t, path, src, version: readVersion(src, t) };
  });
}

/** {current, drift[]} for a track relative to its canonical file. */
function inspect(track) {
  const loaded = loadTrack(track);
  const current = loaded.find((l) => l.t.file === TRACKS[track].canonical).version;
  return { loaded, current, drift: loaded.filter((l) => l.version !== current) };
}

function reportDrift(track, current, drift) {
  console.error(
    `[${track}] version drift — these disagree with ${TRACKS[track].canonical} (${current}):`,
  );
  for (const l of drift) console.error(`  ${l.version.padEnd(12)} ${l.t.file}`);
}

// --- run ------------------------------------------------------------------------

const args = process.argv.slice(2);
const force = args.includes('--force');
const check = args.includes('--check');
const positional = args.filter((a) => !a.startsWith('--'));
const track = positional[0];
const newVersion = positional[1];

function usage(code) {
  console.error('Usage: node scripts/bump-version.mjs <app|client> <version> [--force]');
  console.error('       node scripts/bump-version.mjs [<app|client>] --check');
  for (const t of TRACK_NAMES) console.error(`  ${t.padEnd(7)} ${TRACKS[t].desc}`);
  process.exit(code);
}

// --check with no track: verify every track is internally in lockstep.
if (check && !track) {
  let bad = false;
  for (const t of TRACK_NAMES) {
    const { current, drift } = inspect(t);
    if (drift.length) {
      bad = true;
      reportDrift(t, current, drift);
    } else {
      console.log(`[${t}] lockstep at ${current}  (${TRACKS[t].targets.length} files)`);
    }
  }
  process.exit(bad ? 1 : 0);
}

if (!track || !TRACK_NAMES.includes(track)) usage(2);

if (check) {
  const { current, drift } = inspect(track);
  if (drift.length) {
    reportDrift(track, current, drift);
    process.exit(1);
  }
  console.log(`[${track}] lockstep at ${current}  (${TRACKS[track].targets.length} files)`);
  process.exit(0);
}

if (!newVersion) usage(2);
if (!SEMVER.test(newVersion)) {
  console.error(`Not a valid semver version: "${newVersion}" (expected e.g. 3.0.2)`);
  process.exit(2);
}

const { loaded, current, drift } = inspect(track);
if (drift.length && !force) {
  reportDrift(track, current, drift);
  console.error('\nRefusing to bump on drift. Re-run with --force to re-align the whole track.');
  process.exit(1);
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

console.log(`\n[${track}] bumped ${changed} file(s) ${current} -> ${newVersion}.`);
