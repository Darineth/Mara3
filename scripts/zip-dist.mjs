// Zip the built Mara 3 distributables in dist/ into version-stamped archives under
// dist/zips/. Each component folder gets a BUILD-INFO.json / BUILD-INFO.txt manifest
// dropped in before zipping (product + protocol versions, web build id, embedded exe
// FileVersion, git commit, build time, bundled Node version), and the run emits a
// dist/zips/SHA256SUMS.txt plus a dist/zips/manifest.json summarising every archive.
//
//   pnpm package:zip            zip whatever is currently in dist/
//   node scripts/zip-dist.mjs   (same)
//
// Only the dist subfolders that actually exist are zipped, so this works whether or
// not the desktop (needs Rust) and Win7 legacy builds were produced. Run a packaging
// step first — pnpm package / pnpm package:legacy — or pnpm package:all to build
// everything and then zip in one go.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const outDir = join(dist, 'zips');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const PRODUCT_VERSION = pkg.version;

// Components we know how to ship, in build order. `exe` (when set) is read for its
// embedded Windows FileVersion. `hasWebBuild` folders carry a web version.json.
// `flatten` zips the folder's CONTENTS at the archive root (no wrapping folder) — used
// for the portable desktop clients, which extract straight to where they're unzipped.
// `latest` also writes a stable-named copy (<name>-latest.<ext>) so an operator can link
// the *current* client from a permanent URL (e.g. in a server MOTD) without the
// version-stamped filename breaking the link each release.
// `archive: 'tar.gz'` ships a gzipped tar instead of a zip — used for the Linux client
// so the binary keeps its Unix executable bit (a .zip strips it). Build + zip it on
// Linux so the mode survives. Components without it default to a .zip.
// `versionFrom` makes a component version itself off the CLIENT track (read from its
// tauri.conf.json) rather than the app/product version — so its zip name + update
// manifest reflect the client's own version, and an app-only release never bumps it or
// false-fires the update nudge. Components without it use the product version.
const COMPONENTS = [
  {
    dir: 'server',
    name: 'Mara3-Server',
    desc: 'Self-contained Node server (bundled node.exe + server + web UI)',
    exe: null,
    hasWebBuild: true,
    bundlesNode: true,
  },
  {
    dir: 'desktop',
    name: 'Mara3-windows-x64',
    desc: 'Portable desktop client, Windows 10/11 x64 (Tauri 2)',
    exe: 'Mara3.exe',
    hasWebBuild: false,
    bundlesNode: false,
    flatten: true,
    latest: true,
    versionFrom: { file: 'apps/shell/src-tauri/tauri.conf.json', path: ['version'] },
  },
  {
    dir: 'desktop-linux',
    name: 'Mara3-linux-x64',
    desc: 'Portable desktop client, Linux x64 (Tauri 2; needs system webkit2gtk-4.1)',
    exe: null, // no embedded Windows FileVersion to read
    hasWebBuild: false,
    bundlesNode: false,
    flatten: true,
    latest: true,
    archive: 'tar.gz', // preserve the binary's executable bit
    // Same shell crate as the Windows desktop client → same client version track.
    versionFrom: { file: 'apps/shell/src-tauri/tauri.conf.json', path: ['version'] },
  },
  {
    dir: 'desktop-legacy',
    name: 'Mara3-windows7-x64',
    desc: 'Windows 7+ legacy client, x64 (Tauri 1)',
    exe: 'Mara3.exe',
    hasWebBuild: false,
    bundlesNode: false,
    flatten: true,
    latest: true,
    versionFrom: {
      file: 'apps/client-legacy/src-tauri/tauri.conf.json',
      path: ['package', 'version'],
    },
  },
  {
    dir: 'web',
    name: 'Mara3-Web',
    desc: 'Raw web build for custom hosting',
    exe: null,
    hasWebBuild: true,
    bundlesNode: false,
  },
];

/** Run a command for its trimmed stdout; return null instead of throwing on failure. */
function tryExec(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function has(cmd) {
  return tryExec(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`) != null;
}

/** PROTOCOL_VERSION is the source of truth in protocol/src; read it without importing TS. */
function readProtocolVersion() {
  try {
    const src = readFileSync(join(root, 'packages', 'protocol', 'src', 'index.ts'), 'utf8');
    const m = src.match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** The web build writes version.json; it sits at the folder root (web) or under web/ (server). */
function readWebBuildId(componentDir) {
  for (const rel of ['version.json', join('web', 'version.json')]) {
    try {
      const v = JSON.parse(readFileSync(join(componentDir, rel), 'utf8'));
      if (v && typeof v.buildId === 'string') return v.buildId;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

/** The exe's embedded Windows FileVersion resource (Tauri stamps it from its config). */
function readFileVersion(exePath) {
  if (process.platform !== 'win32' || !existsSync(exePath)) return null;
  return tryExec(
    `powershell -NoProfile -Command "(Get-Item '${exePath}').VersionInfo.FileVersion"`,
  );
}

/** A component's own version: the client track (its tauri.conf, via `versionFrom`)
 *  for the desktop clients, else the app/product version. Falls back to the product
 *  version if the file is missing/unreadable. */
function componentVersion(comp) {
  if (!comp.versionFrom) return PRODUCT_VERSION;
  try {
    const o = JSON.parse(readFileSync(join(root, comp.versionFrom.file), 'utf8'));
    const v = comp.versionFrom.path.reduce((acc, k) => (acc == null ? acc : acc[k]), o);
    return typeof v === 'string' && v ? v : PRODUCT_VERSION;
  } catch {
    return PRODUCT_VERSION;
  }
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Synchronous sleep (no async machinery in this top-to-bottom script).
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// copyFileSync of a large archive can return BYTE-CORRUPT — same size, wrong bytes —
// when an on-access AV scanner (Windows Defender) is mid-scan of the just-written
// source (these zips bundle .exe/.dll, which trigger a scan). So verify each copy
// against the known-good source hash and retry, backing off to let the scan finish.
function copyVerified(src, dst, expectedHash) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    copyFileSync(src, dst);
    if (sha256(dst) === expectedHash) return;
    console.warn(`    (copy verification failed — retry ${attempt}/4)`);
    sleep(750 * attempt); // give an in-flight AV scan of the source time to complete
  }
  throw new Error(`copy verification failed after retries: ${dst}`);
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const tarVersion = tryExec('tar --version') || '';
const hasTar = has('tar');
const isBsdTar = /bsdtar|libarchive/i.test(tarVersion); // bsdtar authors zips; GNU tar can't
const hasZipCli = has('zip');

/** Archive dist/<dirName> into outPath. `format` is 'zip' (default) or 'tar.gz' (the
 *  Linux client — keeps the binary's Unix executable bit, which a .zip strips). With
 *  flatten=true the folder's CONTENTS sit at the archive root (no wrapping folder), so
 *  a portable client extracts straight where it lands; otherwise the wrapping <dirName>/
 *  is kept. Top-level entries are listed BY NAME (not "." — that stores a leading "./"
 *  the file explorer surfaces as a stray "." folder). Bundles are plain real files
 *  (the server uses node-linker=hoisted, no pnpm symlink junctions), so no -h needed. */
function archive(dirName, outPath, { flatten = false, format = 'zip' } = {}) {
  rmSync(outPath, { force: true });
  const srcDir = join(dist, dirName);
  const base = flatten ? srcDir : dist;
  const entries = flatten ? readdirSync(srcDir) : [dirName];
  const quoted = entries.map((p) => `"${p}"`).join(' ');
  // -a makes tar pick the format/compression from the suffix (.zip via bsdtar, .tar.gz
  // via any tar); -C sets the base so stored paths are relative.
  const tarCmd = `tar -a -c -f "${outPath}" -C "${base}" ${quoted}`;

  if (format === 'tar.gz') {
    if (!hasTar) throw new Error('tar not found — required to build a .tar.gz');
    execSync(tarCmd, { cwd: root, stdio: 'inherit' });
    return;
  }
  // format === 'zip'
  if (isBsdTar) {
    execSync(tarCmd, { cwd: root, stdio: 'inherit' });
  } else if (hasZipCli) {
    // GNU tar can't create zips; the zip CLI can. Run from `base` so stored paths match.
    execSync(`zip -r -q -X "${outPath}" ${quoted}`, { cwd: base, stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    // No bsdtar: PowerShell. A "\*" glob flattens; a folder path keeps the wrapper.
    const srcPath = flatten ? join(srcDir, '*') : srcDir;
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${srcPath}' -DestinationPath '${outPath}' -Force"`,
      { cwd: root, stdio: 'inherit' },
    );
  } else {
    throw new Error('no zip tool found — install bsdtar (libarchive) or the zip CLI');
  }
}

// --- gather build-wide identity -------------------------------------------------

const gitCommit = tryExec('git rev-parse --short HEAD');
const porcelain = tryExec('git status --porcelain');
const gitDirty = porcelain == null ? null : porcelain.length > 0;
const protocolVersion = readProtocolVersion();
const nodeVersion = process.version;
const builtAt = new Date().toISOString();
// Compact UTC filename stamp, e.g. 20260626-2253, from the ISO timestamp.
const stamp = builtAt.replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
// <version>-<utc stamp>-<commit[-dirty]>. Per-component: client zips carry the client
// version, others the product version (see componentVersion). verTag is the release-wide
// (product) tag, used for the top-level manifest summary + the log line.
const verTagFor = (v) =>
  [v, stamp, gitCommit && `${gitCommit}${gitDirty ? '-dirty' : ''}`].filter(Boolean).join('-');
const verTag = verTagFor(PRODUCT_VERSION);

if (!existsSync(dist)) {
  console.error(`zip-dist: ${dist} does not exist — run pnpm package / package:legacy first.`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Zipping Mara 3 distributables  (version tag: ${verTag})`);
if (!isBsdTar) console.log('  (no bsdtar — zips via the zip CLI / PowerShell Compress-Archive)');

const archives = [];
const failures = [];
const latestAliases = [];

for (const comp of COMPONENTS) {
  const compDir = join(dist, comp.dir);
  if (!existsSync(compDir)) {
    console.log(`  - ${comp.dir}/ — absent, skipping (${comp.name})`);
    continue;
  }

  const fileVersion = comp.exe ? readFileVersion(join(compDir, comp.exe)) : null;
  const info = {
    component: comp.name,
    description: comp.desc,
    productVersion: PRODUCT_VERSION,
    ...(protocolVersion != null ? { protocolVersion } : {}),
    ...(fileVersion ? { exeFileVersion: fileVersion } : {}),
    ...(comp.hasWebBuild ? { webBuildId: readWebBuildId(compDir) } : {}),
    ...(comp.bundlesNode ? { bundledNode: nodeVersion } : {}),
    gitCommit,
    gitDirty,
    builtAt,
  };

  // Drop the manifest into the folder so the archive is self-describing.
  writeFileSync(join(compDir, 'BUILD-INFO.json'), `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(
    join(compDir, 'BUILD-INFO.txt'),
    Object.entries(info)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') + '\n',
  );

  const ext = comp.archive === 'tar.gz' ? '.tar.gz' : '.zip';
  const zipName = `${comp.name}-v${verTagFor(componentVersion(comp))}${ext}`;
  const zipPath = join(outDir, zipName);
  try {
    archive(comp.dir, zipPath, { flatten: comp.flatten, format: comp.archive });
  } catch (err) {
    rmSync(zipPath, { force: true });
    failures.push(comp.name);
    console.error(`  ! ${comp.name} — zip failed: ${String(err.message).split('\n')[0]}`);
    console.error(
      '    A relocated or stale build leaves dangling node_modules junctions; rebuild with pnpm package.',
    );
    continue;
  }

  const size = statSync(zipPath).size;
  const hash = sha256(zipPath);
  archives.push({ file: zipName, ...info, bytes: size, sha256: hash });
  console.log(`  + ${zipName}  (${fmtSize(size)})`);

  // Stable-named copy for a permanent download link (e.g. a server MOTD). Tracked
  // separately from the canonical versioned archive above (not in manifest/SHA256SUMS).
  if (comp.latest) {
    const latestName = `${comp.name}-latest${ext}`;
    copyVerified(zipPath, join(outDir, latestName), hash);
    latestAliases.push({ from: zipName, to: latestName });
    console.log(`    ↳ ${latestName}  (stable link to the current ${comp.name})`);
  }
}

if (archives.length === 0) {
  console.error('\nzip-dist: nothing to zip — dist/ had no known component folders.');
  process.exit(1);
}

// Top-level manifest + checksums for the whole release.
writeFileSync(
  join(outDir, 'manifest.json'),
  `${JSON.stringify({ productVersion: PRODUCT_VERSION, versionTag: verTag, builtAt, gitCommit, gitDirty, archives }, null, 2)}\n`,
);
writeFileSync(
  join(outDir, 'SHA256SUMS.txt'),
  archives.map((a) => `${a.sha256}  ${a.file}`).join('\n') + '\n',
);

// "Update available" nudge manifests: each portable client polls its OWN latest*.json
// (separate downloads), comparing the manifest `version` to its build's and showing a
// Download banner when this is newer. Host these alongside the matching zip at
// MARA_UPDATE_BASE_URL. Keep UPDATE_BASE_URL in sync with package.mjs / package-legacy.mjs
// (which bake <base>/<manifest> into each client). Override per-build with
// MARA_UPDATE_BASE_URL. Each is emitted only when its archive was built this run.
const UPDATE_BASE_URL = 'https://mara.pretoast.com/mara3-updates';
const updateBase = (process.env.MARA_UPDATE_BASE_URL || UPDATE_BASE_URL).replace(/\/+$/, '');
for (const { component, manifest, label } of [
  { component: 'Mara3-windows-x64', manifest: 'latest-windows-x64.json', label: 'windows-x64' },
  { component: 'Mara3-windows7-x64', manifest: 'latest-windows7-x64.json', label: 'windows7-x64' },
  { component: 'Mara3-linux-x64', manifest: 'latest-linux-x64.json', label: 'linux-x64' },
]) {
  const built = archives.find((a) => a.component === component);
  if (!built) continue;
  // The manifest version is the CLIENT version (not the product version), so the nudge
  // compares like-for-like against the installed shell's baked version — an app-only
  // release never makes installed clients think a new client exists.
  const latest = {
    version: componentVersion(COMPONENTS.find((c) => c.name === component)),
    url: `${updateBase}/${built.file}`,
    notes: '',
    pub_date: builtAt,
    sha256: built.sha256,
  };
  writeFileSync(join(outDir, manifest), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`   ${manifest.padEnd(25)} ${label} update manifest -> ${latest.url}`);
}

console.log('\n============================================================');
console.log(` Done. ${archives.length} archive(s) in: ${outDir}`);
console.log('   manifest.json    per-archive versions + checksums');
console.log('   SHA256SUMS.txt   sha256  filename  (verify with sha256sum -c)');
if (latestAliases.length) {
  console.log('   *-latest.*       stable-named copies for permanent download links:');
  for (const a of latestAliases) console.log(`                      ${a.to}  (= ${a.from})`);
  console.log('     Upload these next to the versioned archives; link them from a MOTD, e.g.');
  console.log('     [Mara 3 for Windows](https://<host>/<path>/Mara3-windows-x64-latest.zip)');
}
if (failures.length) console.log(` WARNING: ${failures.length} failed: ${failures.join(', ')}`);
console.log('============================================================');

if (failures.length) process.exit(1);
