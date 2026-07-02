// Publish the current dist/zips/ as a GitHub Release for Darineth/Mara3, so the desktop
// "update available" nudge and download links resolve through
//   https://github.com/Darineth/Mara3/releases/latest/download/<asset>
// which always points at the newest published release's asset of that name. That "latest"
// behaviour is why the packaging scripts default MARA_UPDATE_BASE_URL there.
//
// IMPORTANT — this script does NOT build. It only uploads what is already in dist/zips/,
// so it can never publish a stale or partial set by accident. Do a FULL build first:
//
//   pnpm package:all        # builds every workspace package, bundles server + desktop
//                           # clients, then zips everything into dist/zips/
//   pnpm release:github     # then publish that as a GitHub release
//
// Usage:
//   pnpm release:github [vTAG] [--draft] [--dry-run] [--notes-file <path>]
//   node scripts/release-github.mjs
//     vTAG        release tag (default: v<package.json version>); a bare "3.0.7" is fine.
//     --draft     create as a draft (won't become releases/latest until published).
//     --dry-run   print what would be uploaded + the gh command, without running it.
//     --notes-file  use these release notes instead of the CHANGELOG section.
//
// Requires the GitHub CLI (`gh`) authenticated with push access to the repo.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const zipsDir = join(root, 'dist', 'zips');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

// --- args -----------------------------------------------------------------------
const args = process.argv.slice(2);
const draft = args.includes('--draft');
const dryRun = args.includes('--dry-run');
const notesFileArg = argValue('--notes-file');
const tagArg = args.find((a) => /^v?\d+\.\d+\.\d+/.test(a));
const tag = tagArg ? (tagArg.startsWith('v') ? tagArg : `v${tagArg}`) : `v${version}`;

function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function has(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// --- preflight ------------------------------------------------------------------
if (!has('gh')) {
  fail('GitHub CLI (gh) not found. Install it from https://cli.github.com and run `gh auth login`.');
}
try {
  execSync('gh auth status', { stdio: 'ignore' });
} catch {
  fail('GitHub CLI is not authenticated — run `gh auth login` (needs push access to the repo).');
}
if (!existsSync(zipsDir)) {
  fail('No dist/zips/ — run `pnpm package:all` first (it builds every package, bundles the clients, and zips).');
}

// Every regular file in dist/zips/ becomes a release asset: the version-stamped archives,
// the stable *-latest.* aliases, the latest-*.json update manifests, manifest.json, and
// SHA256SUMS.txt. The stable-named files are what releases/latest/download resolves against.
const assets = readdirSync(zipsDir)
  .map((name) => join(zipsDir, name))
  .filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
if (assets.length === 0) fail('dist/zips/ is empty — run `pnpm package:all` first.');

// Warn if a platform's stable update assets weren't produced this run (e.g. the Linux
// client wasn't built): the update nudge for that platform won't resolve until they are.
const files = new Set(assets.map((p) => p.split(/[\\/]/).pop()));
const stableUpdateAssets = [
  'latest-windows-x64.json',
  'Mara3-windows-x64-latest.zip',
  'latest-windows7-x64.json',
  'Mara3-windows7-x64-latest.zip',
  'latest-linux-x64.json',
  'Mara3-linux-x64-latest.tar.gz',
];
const missing = stableUpdateAssets.filter((n) => !files.has(n));
if (missing.length) {
  console.warn(
    `\n! Heads up: these stable update assets are absent (their platform wasn't built this run),\n` +
      `  so the "update available" nudge won't resolve for them until a build that includes them:\n` +
      missing.map((m) => `    - ${m}`).join('\n'),
  );
}

// --- release notes --------------------------------------------------------------
/** Pull the CHANGELOG section body for `version`, or '' if not found. */
function changelogNotes(v) {
  try {
    const md = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const section = md
      .split(/\n(?=## \[)/)
      .find((s) => s.startsWith(`## [${v}]`));
    return section ? section.replace(/^## \[[^\n]*\n/, '').trim() : '';
  } catch {
    return '';
  }
}

let notesFile = notesFileArg;
if (!notesFile) {
  const notes = changelogNotes(version);
  if (notes) {
    notesFile = join(tmpdir(), `mara-release-notes-${version}.md`);
    writeFileSync(notesFile, `${notes}\n`);
  }
}

// --- build the gh command -------------------------------------------------------
let ghArgs;
let releaseExists = false;
try {
  execSync(`gh release view ${tag}`, { stdio: 'ignore' });
  releaseExists = true;
} catch {
  releaseExists = false;
}

if (releaseExists) {
  // Re-run: refresh the assets on the existing release (title/notes are left as they are).
  ghArgs = ['release', 'upload', tag, ...assets, '--clobber'];
} else {
  ghArgs = ['release', 'create', tag, ...assets, '--title', `Mara ${version}`];
  if (notesFile) ghArgs.push('--notes-file', notesFile);
  else ghArgs.push('--generate-notes');
  if (draft) ghArgs.push('--draft');
}

// --- report + run ---------------------------------------------------------------
console.log(`\nMara 3 → GitHub release`);
console.log(`  repo    Darineth/Mara3`);
console.log(`  tag     ${tag}${releaseExists ? '  (exists → refreshing assets)' : ''}`);
console.log(`  notes   ${releaseExists ? '(unchanged)' : notesFile ? `CHANGELOG [${version}]` : 'auto-generated'}`);
console.log(`  assets  (${assets.length})`);
for (const p of assets) console.log(`            ${p.split(/[\\/]/).pop()}`);
console.log(`\n  gh ${ghArgs.join(' ')}\n`);

if (dryRun) {
  console.log('(dry run — nothing published)');
  process.exit(0);
}

try {
  execFileSync('gh', ghArgs, { cwd: root, stdio: 'inherit' });
} catch {
  fail('gh failed. If the tag was created at the wrong commit, `git push --follow-tags` first (the release should sit on the pushed tag).');
}
console.log(`\n✓ Published ${tag} to GitHub.`);
