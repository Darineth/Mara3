// Assemble the Windows 7 legacy client into dist/desktop-legacy/:
//
//   Mara3.exe         the portable Win7-target exe
//   Run-Mara3.bat     launcher (points WebView2 at the runtime beside it)
//   webview2-runtime/ the fixed-version WebView2 runtime (Win7 has no evergreen)
//   README.txt
//
// The runtime is grabbed from the first source available:
//   1. MARA_WEBVIEW2_URL — download the fixed-version .cab from this URL and extract
//   2. MARA_WEBVIEW2_CAB — extract a local .cab file
//   3. apps/client-legacy/src-tauri/webview2-runtime/ — copy an already-extracted runtime
// If none is set/found, it writes GET-RUNTIME.txt with instructions instead — there
// is no stable public direct-download URL for Microsoft's Fixed Version runtime, so
// obtaining the .cab once is the single manual step.
//
//   pnpm package:legacy            (builds the exe, then assembles)
//   MARA_WEBVIEW2_CAB=path pnpm package:legacy
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

// 3. Grab the WebView2 runtime, or leave instructions.
const runtimeDest = join(out, 'webview2-runtime');
const runtimeSrc = grabRuntime();
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
  console.log(`\nwebview2-runtime: grabbed (${mb} MB)`);
} else {
  mkdirSync(runtimeDest, { recursive: true });
  writeFileSync(
    join(runtimeDest, 'GET-RUNTIME.txt'),
    `This folder must contain Microsoft's FIXED VERSION WebView2 runtime — i.e. a
folder with msedgewebview2.exe + msedge.dll and support files at its top level.
Windows 7 has no evergreen WebView2 runtime, so the app can't render without this.

IMPORTANT: get the right download. You need the "Fixed Version" runtime, NOT:
  - the Evergreen Standalone/Bootstrapper installer (MicrosoftEdgeWebview2Setup.exe), or
  - the Edge offline installer (MicrosoftEdge_X64_*.exe + MicrosoftEdgeUpdate*).
Those install/contain Edge but do not give you a runtime folder with msedgewebview2.exe.

Get it once, then re-run packaging — it's extracted/copied here automatically:

  - On the WebView2 download page, under "Fixed Version", pick the version + x64 and
    download the .cab (last Win7-capable is ~Chromium 109 / 109.0.1518.x), then either:
      MARA_WEBVIEW2_CAB=path\\to\\Microsoft.WebView2.FixedVersionRuntime.<ver>.x64.cab pnpm package:legacy
    or extract the .cab and put its msedgewebview2.exe folder's CONTENTS into
    apps/client-legacy/src-tauri/webview2-runtime/, then re-run.
`,
  );
  console.log('\nwebview2-runtime: NOT available — wrote GET-RUNTIME.txt instructions.');
}

writeFileSync(
  join(out, 'README.txt'),
  `Mara 3 — Windows 7 client (portable)

Run Run-Mara3.bat. It points WebView2 at the webview2-runtime folder beside
it and launches Mara3.exe. Keep all three together:

  Mara3.exe
  Run-Mara3.bat
  webview2-runtime\\        (Microsoft Fixed Version WebView2 runtime)

settings.json is created next to the exe on first run (server picker choice).
`,
);

console.log(`\nDone. Win7 client assembled in: ${out}`);
