// Builds all Mara 3 distributables into dist/:
//   dist/server/   a self-contained Node server (bundled node.exe + server + web)
//   dist/desktop/  portable Mara3.exe (Windows 10/11 x64; only if Rust is available)
//                  (on Linux: dist/desktop-linux/Mara3 — needs system webkit2gtk-4.1)
//   dist/web/      the raw web build, for hosting elsewhere
//
// Run via package.bat, or: node scripts/package.mjs [--skip-tests] [--skip-desktop]

import { execSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));
const skipTests = args.has('--skip-tests');
const skipDesktop = args.has('--skip-desktop');

// Default self-hosted folder for the desktop "update available" nudge. The client is
// built to poll <base>/<manifest> and zip-dist.mjs writes the manifest pointing at
// <base>/<archive>. Override per-build with MARA_UPDATE_BASE_URL, or MARA_UPDATE_URL=
// to disable the check. Keep in sync with zip-dist.mjs's UPDATE_BASE_URL.
const UPDATE_BASE_URL = 'https://mara.pretoast.com/mara3-updates';

// The shell builds for the host OS, so it polls that OS's manifest (matching the name
// zip-dist.mjs emits). Build the Linux client on Linux, the Windows one on Windows.
const CLIENT_MANIFEST =
  process.platform === 'linux' ? 'latest-linux-x64.json' : 'latest-windows-x64.json';

const LAUNCHER = `@echo off
cd /d "%~dp0"
set NODE_ENV=production
set "MARA_WEB_ROOT=%~dp0web"
rem Keep persistent state (data\\, uploads\\) next to this launcher, OUTSIDE app\\,
rem so updating only replaces code and never touches saved data or mara.config.
set "MARA_BASE_DIR=%~dp0"
rem Display only - do NOT export MARA_PORT, or it would override mara.config.
set "SHOWPORT=%MARA_PORT%"
if "%SHOWPORT%"=="" set "SHOWPORT=5050"
echo Mara 3 server  -^>  http://localhost:%SHOWPORT%
echo (Port/host come from the environment or mara.config; see README.txt.)
echo Open that URL in a browser to use the chat. Close this window (or Ctrl+C) to stop.
echo Server output is written to server.log next to this launcher.

rem Auto-restart: if the server exits (crash, unhandled error), relaunch it after a short
rem pause so a transient failure doesn't take the server offline. Uses ping (not timeout)
rem for the delay so it also works headless under Task Scheduler, where timeout has no
rem console and would fail. stdout/stderr go to server.log so a background run still
rem captures logs. To stop for good: close the window, Ctrl+C then Y, or stop the scheduled
rem task -- killing node alone just makes this loop relaunch it.
:run
echo [%date% %time%] starting Mara 3 server>>"%~dp0server.log"
"%~dp0node.exe" "%~dp0app\\dist\\main.js">>"%~dp0server.log" 2>&1
set "rc=%errorlevel%"
echo.
echo Mara 3 server stopped (exit code %rc%). Restarting in 3s -- close this window or stop the task.
echo [%date% %time%] server exited (code %rc%); restarting in 3s>>"%~dp0server.log"
ping -n 4 127.0.0.1 >nul
goto run
`;

const CONFIG_EXAMPLE = `# Mara 3 server configuration.
#
# Rename this file to "mara.config" (keep it next to Mara3-Server.bat) to use it.
# Format is KEY=value, one per line; lines starting with # are comments.
# Environment variables override anything set here, so you can still do
#     set MARA_PORT=6000
#     Mara3-Server.bat
# to override for a single launch.

# --- Network ---
#MARA_HOST=0.0.0.0           # bind address; set 127.0.0.1 when behind a reverse proxy
#MARA_PORT=5050              # listen port

# --- Presentation ---
#MARA_SERVER_NAME=Mara 3 Server
#MARA_MOTD=Welcome to Mara 3.
# The MOTD is shown to everyone on connect and renders MARKDOWN, so it can include
# links. For a longer/multi-line message, create a "MOTD.md" file next to this config
# instead (it takes precedence over MARA_MOTD). To point users at the desktop client,
# host the stable "Mara3-windows-x64-latest.zip" (emitted by packaging) on your download
# host and link it, e.g.:
#     [Mara 3 for Windows](https://your-host/path/Mara3-windows-x64-latest.zip)
#MARA_DEFAULT_CHANNEL=Main   # channel everyone auto-joins; leave empty to disable

# --- WebSocket ---
#MARA_WS_PATH=/ws            # must match what a reverse proxy forwards

# --- Flood control (per-connection message rate limit) ---
#MARA_MSG_RATE=15           # sustained messages/sec allowed; 0 disables the limit
#MARA_MSG_BURST=30          # how many messages may be sent in a quick burst
#MARA_MSG_FLOOD_KICK=300    # consecutive over-limit messages before the socket is closed

# --- Uploads ---
#MARA_MAX_UPLOAD_MB=10       # per-file cap
#MARA_MAX_CACHE_MB=512       # total upload-cache cap (oldest evicted first)

# --- History ---
#MARA_HISTORY_LIMIT=1000     # messages retained per channel (persisted; deepest scroll-back)
#MARA_HISTORY_CHUNK=50       # messages sent on join, and per "load older" page on scroll-up

# --- Storage ---
# Persistent state (history, identities, uploads) lives next to Mara3-Server.bat by
# default (in data\\ and uploads\\), so an update that replaces app\\ + web\\ leaves
# it untouched. Point these at absolute paths to relocate it (e.g. a backed-up
# drive). Set MARA_HISTORY_FILE / MARA_IDENTITY_FILE empty to disable persistence
# (in-memory only - history and tokens are lost on restart).
#MARA_UPLOAD_DIR=D:\\Mara3-Data\\uploads
#MARA_HISTORY_FILE=D:\\Mara3-Data\\history.json
#MARA_IDENTITY_FILE=D:\\Mara3-Data\\identity.json
`;

const SERVER_README = `Mara 3 Server (self-contained)
==============================

Double-click Mara3-Server.bat to start. It runs a bundled copy of Node.js, so
nothing needs to be installed. It hosts the chat web UI and the WebSocket on a
single port (default 5050).

  - This machine:   http://localhost:5050
  - Other PCs:      http://<this-machine-ip>:5050  (allow the port through the
                    firewall; the app auto-connects to whatever address it loads)

Configuration (highest priority first):
  1. Environment variables, per launch, e.g.:
         set MARA_PORT=6000
         Mara3-Server.bat
  2. A "mara.config" file next to Mara3-Server.bat. Copy mara.config.example
     to mara.config and edit it; it lists every setting (port, host, server
     name, MOTD, upload caps, history limit, ...).
  Environment variables override the file, which overrides the built-in defaults.

Your data (created on first run, kept next to this launcher - NOT inside app\\):
  mara.config   your settings (you create this from mara.config.example)
  data\\         message history + identity tokens (history.json, identity.json)
  uploads\\      uploaded images (size-capped cache)
  server.log    server output/log (grows over time; safe to delete or trim anytime)

Updating without losing settings or data:
  Replace the CODE, keep your state. Overwrite these from the new version:
      app\\   web\\   node.exe   Mara3-Server.bat   README.txt   mara.config.example
  Leave these alone:
      mara.config   data\\   uploads\\
  State lives beside the launcher (not inside app\\), so dropping in a new app\\ +
  web\\ never disturbs your history, identities, uploads, or config.

Optional: run Create-Shortcut.bat to put a "Mara 3 Server" shortcut (with icon)
on your Desktop, pointing at this launcher.

Contents:
  node.exe              bundled Node.js runtime                               [code]
  app\\                  the server (app\\dist\\main.js) and its dependencies    [code]
  web\\                  the chat client the server hosts                       [code]
  mara.config.example   sample config; rename to mara.config to use
  Create-Shortcut.bat   makes a Desktop shortcut to the server (with the icon)
  Mara3-Server.ico      the server's icon (used by that shortcut)
`;

// Helper the user can run to drop a Desktop shortcut to the launcher, carrying the
// green Mara icon. Created on the user's machine so the (absolute) shortcut path is
// correct and survives the bundle being moved/extracted anywhere.
const CREATE_SHORTCUT = `@echo off
rem Create a Desktop shortcut to the Mara 3 server launcher, with the Mara icon.
set "DIR=%~dp0"
set "LNK=%USERPROFILE%\\Desktop\\Mara 3 Server.lnk"
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%LNK%'); $s.TargetPath='%DIR%Mara3-Server.bat'; $s.WorkingDirectory='%DIR%'; $s.IconLocation='%DIR%Mara3-Server.ico'; $s.Description='Mara 3 chat server'; $s.Save()"
if errorlevel 1 (echo Failed to create the shortcut.) else (echo Created shortcut: "%LNK%")
pause
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
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, {
      stdio: 'ignore',
    });
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
// Wipe last run's output, but PRESERVE dist/prebuilt/ — a cross-platform build staged
// by `pnpm package:linux` (built in WSL) that the later zip-dist folds in. Otherwise the
// only working order would be package -> package:linux -> zip; preserving it lets you
// stage the Linux client once and re-run packaging freely.
if (existsSync(dist)) {
  for (const entry of readdirSync(dist)) {
    if (entry === 'prebuilt') continue;
    rmSync(join(dist, entry), { recursive: true, force: true });
  }
}
mkdirSync(dist, { recursive: true });

step(5, total, 'Packaging self-contained Node server');
const serverDir = join(dist, 'server');
// 1. Server + its production dependencies (resolves the @mara/* workspace deps).
//    node-linker=hoisted forces a FLAT node_modules of real files (no pnpm symlink
//    store), so the bundle is self-contained and portable: it survives being zipped
//    and extracted on another machine. The default isolated layout resolves transitive
//    deps via physical .pnpm nesting + symlinks, which can't be archived faithfully —
//    stored links are absolute (dangle elsewhere) and dereferenced copies lose their
//    .pnpm siblings (e.g. sirv can't find totalist). Hoisted sidesteps both.
run(
  `pnpm --filter @mara/server deploy --prod --config.node-linker=hoisted "${join(serverDir, 'app')}"`,
);
// 2. Bundle the Node runtime currently running this script.
copyFileSync(process.execPath, join(serverDir, 'node.exe'));
// 3. Bundle the web client the server hosts locally.
cpSync(join(root, 'apps', 'web', 'dist'), join(serverDir, 'web'), { recursive: true });
// 4. Launcher + readme.
writeFileSync(join(serverDir, 'Mara3-Server.bat'), LAUNCHER);
writeFileSync(join(serverDir, 'README.txt'), SERVER_README);
writeFileSync(join(serverDir, 'mara.config.example'), CONFIG_EXAMPLE);
writeFileSync(join(serverDir, 'Create-Shortcut.bat'), CREATE_SHORTCUT);
copyFileSync(join(root, 'apps', 'server', 'Mara3-Server.ico'), join(serverDir, 'Mara3-Server.ico'));
// 5. Also drop the raw web build for custom hosting.
cpSync(join(root, 'apps', 'web', 'dist'), join(dist, 'web'), { recursive: true });

if (!skipDesktop) {
  step(6, total, 'Building desktop client');
  if (!has('cargo')) {
    console.log(
      '  - Rust/cargo not found; skipping desktop. Install https://rustup.rs to include it.',
    );
  } else {
    // The bundler is disabled (tauri.conf.json bundle.active:false), so this just
    // compiles the standalone exe — no MSI/NSIS installer, no updater artifacts. Its
    // tauri:build script deploys the exe to dist/desktop/Mara3.exe itself.
    // Pass any signing key through anyway, harmlessly, in case bundling is re-enabled.
    const keyFile = join(root, 'apps', 'shell', '.tauri', 'mara-update.key');
    const env = { ...process.env };
    if (existsSync(keyFile) && !env.TAURI_SIGNING_PRIVATE_KEY) {
      env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, 'utf8').trim();
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
    }
    // The "update available" nudge: one self-hosted folder URL (MARA_UPDATE_BASE_URL,
    // defaulting to UPDATE_BASE_URL below) drives the whole pipeline — the client polls
    // <base>/<CLIENT_MANIFEST> (baked in here, OS-specific) and the manifest written by
    // zip-dist.mjs points its download at <base>/<archive>. Set MARA_UPDATE_URL= (empty)
    // to bake in nothing → the client never shows an update banner.
    if (env.MARA_UPDATE_URL === undefined) {
      const base = (env.MARA_UPDATE_BASE_URL || UPDATE_BASE_URL).replace(/\/+$/, '');
      env.MARA_UPDATE_URL = `${base}/${CLIENT_MANIFEST}`;
    }
    run('pnpm --filter @mara/shell tauri:build', env);
  }
}

console.log('\n============================================================');
console.log(` Done. Distributables in: ${dist}`);
console.log('   server\\   self-contained server — run Mara3-Server.bat');
console.log('   web\\      raw web build for custom hosting');
if (!skipDesktop)
  console.log(
    process.platform === 'linux'
      ? '   desktop-linux/  portable Mara3 (if Rust was available; needs webkit2gtk-4.1)'
      : '   desktop\\  portable Mara3.exe (if Rust was available)',
  );
console.log('============================================================');
