// Builds all Mara 3 distributables into dist/:
//   dist/server/   a self-contained Node server (bundled node.exe + server + web)
//   dist/desktop/  Tauri installers (only if Rust is available)
//   dist/web/      the raw web build, for hosting elsewhere
//
// Run via package.bat, or: node scripts/package.mjs [--skip-tests] [--skip-desktop]

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));
const skipTests = args.has('--skip-tests');
const skipDesktop = args.has('--skip-desktop');

const LAUNCHER = `@echo off
cd /d "%~dp0"
set NODE_ENV=production
set "MARA_WEB_ROOT=%~dp0web"
if "%MARA_PORT%"=="" set MARA_PORT=5050
echo Mara 3 server  -^>  http://localhost:%MARA_PORT%
echo (Close this window to stop the server.)
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:%MARA_PORT%"
"%~dp0node.exe" "%~dp0app\\dist\\main.js"
`;

const SERVER_README = `Mara 3 Server (self-contained)
==============================

Double-click Mara3-Server.bat to start. It runs a bundled copy of Node.js, so
nothing needs to be installed. It hosts the chat web UI and the WebSocket on a
single port (default 5050).

  - This machine:   http://localhost:5050
  - Other PCs:      http://<this-machine-ip>:5050  (allow the port through the
                    firewall; the app auto-connects to whatever address it loads)

Change the port:
    set MARA_PORT=6000
    Mara3-Server.bat

Contents:
  node.exe   bundled Node.js runtime
  app\\       the server (app\\dist\\main.js) and its dependencies
  web\\       the chat client the server hosts
`;

function run(cmd, env = process.env) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', shell: true, env });
}

function step(n, total, msg) {
  console.log(`\n[${n}/${total}] ${msg}`);
}

function has(cmd) {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const total = skipDesktop ? 5 : 6;

step(1, total, 'Installing dependencies');
run('pnpm install');

step(2, total, 'Building all packages');
run('pnpm build');

if (!skipTests) {
  step(3, total, 'Running tests');
  run('pnpm test');
} else {
  step(3, total, 'Skipping tests (--skip-tests)');
}

step(4, total, 'Cleaning dist/');
if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

step(5, total, 'Packaging self-contained Node server');
const serverDir = join(dist, 'server');
// 1. Server + its production dependencies (resolves the @mara/* workspace deps).
run(`pnpm --filter @mara/server deploy --prod "${join(serverDir, 'app')}"`);
// 2. Bundle the Node runtime currently running this script.
copyFileSync(process.execPath, join(serverDir, 'node.exe'));
// 3. Bundle the web client the server hosts locally.
cpSync(join(root, 'apps', 'web', 'dist'), join(serverDir, 'web'), { recursive: true });
// 4. Launcher + readme.
writeFileSync(join(serverDir, 'Mara3-Server.bat'), LAUNCHER);
writeFileSync(join(serverDir, 'README.txt'), SERVER_README);
// 5. Also drop the raw web build for custom hosting.
cpSync(join(root, 'apps', 'web', 'dist'), join(dist, 'web'), { recursive: true });

if (!skipDesktop) {
  step(6, total, 'Building desktop client');
  if (!has('cargo')) {
    console.log('  - Rust/cargo not found; skipping desktop. Install https://rustup.rs to include it.');
  } else {
    const keyFile = join(root, 'apps', 'shell', '.tauri', 'mara-update.key');
    const env = { ...process.env };
    if (env.TAURI_SIGNING_PRIVATE_KEY || existsSync(keyFile)) {
      // Signed build (produces updater .sig artifacts).
      if (!env.TAURI_SIGNING_PRIVATE_KEY) env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8').trim();
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
      run('pnpm --filter @mara/shell tauri:build', env);
    } else {
      // No signing key available: build installers without updater artifacts.
      const override = join(tmpdir(), 'mara-no-updater.json');
      writeFileSync(override, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
      run(`pnpm --filter @mara/shell exec tauri build --config "${override}"`, env);
    }
    const desktopDir = join(dist, 'desktop');
    mkdirSync(desktopDir, { recursive: true });
    const bundle = join(root, 'apps', 'shell', 'src-tauri', 'target', 'release', 'bundle');
    for (const sub of ['msi', 'nsis']) {
      const dir = join(bundle, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.msi') || f.endsWith('.exe') || f.endsWith('.sig')) {
          copyFileSync(join(dir, f), join(desktopDir, f));
        }
      }
    }
    const exe = join(root, 'apps', 'shell', 'src-tauri', 'target', 'release', 'mara-shell.exe');
    if (existsSync(exe)) copyFileSync(exe, join(desktopDir, 'Mara3-Desktop.exe'));
  }
}

console.log('\n============================================================');
console.log(` Done. Distributables in: ${dist}`);
console.log('   server\\   self-contained server — run Mara3-Server.bat');
console.log('   web\\      raw web build for custom hosting');
if (!skipDesktop) console.log('   desktop\\  installers (if Rust was available)');
console.log('============================================================');
