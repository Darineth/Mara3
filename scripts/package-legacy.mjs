// Assemble the Windows 7 legacy client into dist/desktop-legacy/:
//
//   Mara3.exe         the portable Win7-target exe
//   Run-Mara3.bat     launcher (points WebView2 at the runtime beside it)
//   webview2-runtime/ the fixed-version WebView2 runtime (Win7 has no evergreen)
//   README.txt
//
// By DEFAULT the packaged/zipped edition ships webview2-runtime/ EMPTY — just a
// README.txt telling the user how to obtain + place the runtime. It's large (~100+ MB)
// and Win7-specific, so it's distributed separately rather than bloating every download.
//
// Opt into a SELF-CONTAINED bundle (runtime included) with MARA_WEBVIEW2_BUNDLE=1, or by
// pointing at a source (which implies bundling), taken from the first available of:
//   1. MARA_WEBVIEW2_URL — download the fixed-version .cab from this URL and extract
//   2. MARA_WEBVIEW2_CAB — extract a local .cab file
//   3. apps/client-legacy/src-tauri/webview2-runtime/ — copy an already-extracted runtime
// (There's no stable public direct-download URL for Microsoft's Fixed Version runtime, so
// obtaining the .cab once is the single manual step if you do bundle.)
//
//   pnpm package:legacy                         (empty runtime + README — the default)
//   MARA_WEBVIEW2_BUNDLE=1 pnpm package:legacy   (bundle from the local runtime folder)
//   MARA_WEBVIEW2_CAB=path pnpm package:legacy   (bundle from a .cab)
//   MARA_WEBVIEW2_URL=https://… pnpm package:legacy

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'dist', 'desktop-legacy');
const skipBuild = process.argv.includes('--skip-build');

// "Update available" nudge: bake the Win7 client's OWN manifest URL into the build.
// It's a separate download from the modern desktop, so it polls latest-windows7-x64.json
// (not latest-windows-x64.json). Defaults to the repo's GitHub Releases "latest" download
// endpoint — keep UPDATE_BASE_URL in sync with package.mjs / zip-dist.mjs. Override with
// MARA_UPDATE_BASE_URL, or MARA_UPDATE_URL= (empty) to disable. zip-dist.mjs emits the
// matching latest-windows7-x64.json.
const UPDATE_BASE_URL = 'https://github.com/Darineth/Mara3/releases/latest/download';
const buildEnv = { ...process.env };
if (buildEnv.MARA_UPDATE_URL === undefined) {
  const base = (buildEnv.MARA_UPDATE_BASE_URL || UPDATE_BASE_URL).replace(/\/+$/, '');
  buildEnv.MARA_UPDATE_URL = `${base}/latest-windows7-x64.json`;
}

function run(cmd, opts = {}) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', shell: true, ...opts });
}

// Recursively find the directory that contains the runtime's msedgewebview2.exe.
function findRuntimeRoot(dir) {
  if (!existsSync(dir)) return null;
  if (existsSync(join(dir, 'msedgewebview2.exe'))) return dir;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const hit = findRuntimeRoot(join(dir, entry.name));
      if (hit) return hit;
    }
  }
  return null;
}

function extractCab(cab, dest) {
  mkdirSync(dest, { recursive: true });
  // `expand` is a Windows built-in; the fixed-version runtime ships as a .cab.
  run(`expand "${cab}" -F:* "${dest}"`);
}

// Returns the dir holding msedgewebview2.exe, or null if no source was available.
function grabRuntime() {
  const staging = join(tmpdir(), `mara-wv2-${process.pid}`);
  const url = process.env.MARA_WEBVIEW2_URL;
  const cab = process.env.MARA_WEBVIEW2_CAB;
  const local = join(root, 'apps', 'client-legacy', 'src-tauri', 'webview2-runtime');

  if (url) {
    mkdirSync(staging, { recursive: true });
    const dl = join(staging, 'webview2.cab');
    console.log(`Downloading WebView2 fixed runtime from ${url}`);
    run(`curl -L -o "${dl}" "${url}"`);
    extractCab(dl, join(staging, 'extracted'));
    return findRuntimeRoot(join(staging, 'extracted'));
  }
  if (cab) {
    if (!existsSync(cab)) throw new Error(`MARA_WEBVIEW2_CAB not found: ${cab}`);
    extractCab(cab, join(staging, 'extracted'));
    return findRuntimeRoot(join(staging, 'extracted'));
  }
  if (existsSync(local)) {
    // Only accept it if it's a real extracted runtime (has msedgewebview2.exe) —
    // don't copy, e.g., an Edge offline installer bundle that lacks the runtime exe.
    return findRuntimeRoot(local);
  }
  return null;
}

// 1. Build the Win7-target exe — tauri:build deploys it to dist/desktop-legacy/
//    Mara3.exe itself (via copy-client). Clean first so the build repopulates.
if (!skipBuild) {
  rmSync(out, { recursive: true, force: true });
  run('pnpm --filter @mara/client-legacy tauri:build', { env: buildEnv });
}
mkdirSync(out, { recursive: true });
const exe = join(out, 'Mara3.exe');
if (!existsSync(exe)) {
  console.error(`package-legacy: ${exe} not found — run without --skip-build first.`);
  process.exit(1);
}

// 2. Add the launcher next to the exe.
copyFileSync(join(root, 'apps', 'client-legacy', 'Run-Mara3.bat'), join(out, 'Run-Mara3.bat'));

// 3. WebView2 runtime. Default: leave the folder EMPTY with a README (the runtime is
//    distributed separately). Opt into bundling a self-contained zip with
//    MARA_WEBVIEW2_BUNDLE=1, or by setting MARA_WEBVIEW2_CAB / MARA_WEBVIEW2_URL (which
//    imply it). The folder always gets the README, so it survives as a real (non-empty)
//    entry in the zip and tells the user what to put there.
const runtimeDest = join(out, 'webview2-runtime');
mkdirSync(runtimeDest, { recursive: true });
const bundleRuntime =
  process.env.MARA_WEBVIEW2_BUNDLE === '1' ||
  !!process.env.MARA_WEBVIEW2_CAB ||
  !!process.env.MARA_WEBVIEW2_URL;
const runtimeSrc = bundleRuntime ? grabRuntime() : null;
if (runtimeSrc) {
  cpSync(runtimeSrc, runtimeDest, { recursive: true });
  const mb = (
    readdirSync(runtimeDest, { recursive: true })
      .map((f) => {
        try {
          return statSync(join(runtimeDest, f)).size;
        } catch {
          return 0;
        }
      })
      .reduce((a, b) => a + b, 0) /
    (1024 * 1024)
  ).toFixed(0);
  console.log(`\nwebview2-runtime: bundled (${mb} MB)`);
} else {
  writeFileSync(
    join(runtimeDest, 'README.txt'),
    `Mara 3 (Windows 7) needs Microsoft's FIXED VERSION WebView2 runtime to render, and
this download does NOT include it — Windows 7 has no evergreen runtime, and the runtime
is large, so it's provided separately. The app will not start until you place it here.

Put the runtime's files into THIS folder, so it directly contains:
    msedgewebview2.exe
    msedge.dll
    ...and the rest of the runtime's support files (at the top level, right here).

Where to get it:
  - Get the matching "webview2-runtime" copy from wherever you got this download, OR
  - Download it from Microsoft: on the WebView2 download page, under "Fixed Version",
    choose x64 (the last Win7-capable build is ~Chromium 109 / 109.0.1518.x) and download
    the .cab. Extract it and copy the folder that contains msedgewebview2.exe into here
    (its CONTENTS at the top level of this folder).

Get the RIGHT download — the "Fixed Version" runtime, NOT the Evergreen installer
(MicrosoftEdgeWebview2Setup.exe) or the Edge offline installer; those contain/install Edge
but do not give you a runtime folder with msedgewebview2.exe.

Then run Run-Mara3.bat.
`,
  );
  console.log(
    bundleRuntime
      ? '\nwebview2-runtime: bundling requested but no runtime source found — wrote README.txt instead.'
      : '\nwebview2-runtime: left empty (runtime provided separately) — wrote README.txt.',
  );
}

writeFileSync(
  join(out, 'README.txt'),
  `Mara 3 — Windows 7 client (portable)

Run Run-Mara3.bat. It points WebView2 at the webview2-runtime folder beside
it and launches Mara3.exe. Keep all three together:

  Mara3.exe
  Run-Mara3.bat
  webview2-runtime\\        (Microsoft Fixed Version WebView2 runtime)

IMPORTANT: this download ships webview2-runtime\\ EMPTY. Windows 7 needs Microsoft's
Fixed Version WebView2 runtime, provided separately — the app won't start until it's in
place. See webview2-runtime\\README.txt for how to get it and where to put it.

settings.json is created next to the exe on first run (server picker choice).
`,
);

console.log(`\nDone. Win7 client assembled in: ${out}`);
