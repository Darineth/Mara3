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
    name: 'Mara3-Desktop',
    desc: 'Portable desktop client (Tauri 2)',
    exe: 'Mara3-Desktop.exe',
    hasWebBuild: false,
    bundlesNode: false,
  },
  {
    dir: 'desktop-legacy',
    name: 'Mara3-Win7',
    desc: 'Windows 7 legacy client (Tauri 1)',
    exe: 'Mara3-Legacy.exe',
    hasWebBuild: false,
    bundlesNode: false,
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

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const useTar = has('tar');

/** Zip dist/<dirName> into outZip with <dirName>/ as the top-level folder inside. */
function zip(dirName, outZip) {
  rmSync(outZip, { force: true });
  if (useTar) {
    // bsdtar picks zip format from the .zip suffix (-a); -C keeps paths relative.
    // The bundles are plain real files (the server deploys with node-linker=hoisted,
    // so there are no pnpm symlink junctions to chase), so no -h/dereference needed.
    execSync(`tar -a -c -f "${outZip}" -C "${dist}" "${dirName}"`, {
      cwd: root,
      stdio: 'inherit',
    });
  } else {
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${join(dist, dirName)}' -DestinationPath '${outZip}' -Force"`,
      { cwd: root, stdio: 'inherit' },
    );
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
const verTag = [PRODUCT_VERSION, stamp, gitCommit && `${gitCommit}${gitDirty ? '-dirty' : ''}`]
  .filter(Boolean)
  .join('-');

if (!existsSync(dist)) {
  console.error(`zip-dist: ${dist} does not exist — run pnpm package / package:legacy first.`);
  process.exit(1);
}
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

console.log(`Zipping Mara 3 distributables  (version tag: ${verTag})`);
if (!useTar) console.log('  (tar not found — using PowerShell Compress-Archive)');

const archives = [];
const failures = [];

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

  const zipName = `${comp.name}-v${verTag}.zip`;
  const zipPath = join(outDir, zipName);
  try {
    zip(comp.dir, zipPath);
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
  { component: 'Mara3-Desktop', manifest: 'latest.json', label: 'desktop' },
  { component: 'Mara3-Win7', manifest: 'latest-win7.json', label: 'Win7' },
]) {
  const archive = archives.find((a) => a.component === component);
  if (!archive) continue;
  const latest = {
    version: PRODUCT_VERSION,
    url: `${updateBase}/${archive.file}`,
    notes: '',
    pub_date: builtAt,
    sha256: archive.sha256,
  };
  writeFileSync(join(outDir, manifest), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`   ${manifest.padEnd(16)} ${label} update manifest -> ${latest.url}`);
}

console.log('\n============================================================');
console.log(` Done. ${archives.length} archive(s) in: ${outDir}`);
console.log('   manifest.json    per-archive versions + checksums');
console.log('   SHA256SUMS.txt   sha256  filename  (verify with sha256sum -c)');
if (failures.length) console.log(` WARNING: ${failures.length} failed: ${failures.join(', ')}`);
console.log('============================================================');

if (failures.length) process.exit(1);
