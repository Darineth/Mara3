// Builds all Mara 3 distributables into dist/:
//   dist/server/   a self-contained Node server (bundled node.exe + server + web)
//   dist/desktop/  portable Mara3.exe (Windows 10/11 x64; only if Rust is available)
//                  (on Linux: dist/desktop-linux/Mara3 — needs system webkit2gtk-4.1)
//   dist/android/  Mara3.apk (signed release, arm64; only if the Android toolchain is present)
//   dist/web/      the raw web build, for hosting elsewhere
//
// Run via package.bat, or:
//   node scripts/package.mjs [--skip-tests] [--skip-desktop] [--skip-android]

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
const skipAndroid = args.has('--skip-android');

// Default base for the desktop "update available" nudge: the repo's GitHub Releases
// "latest" download endpoint, so <base>/<asset> always resolves to the newest published
// release's asset of that name (publish each release's assets under stable names — see
// scripts/release-github.mjs). The client polls <base>/<manifest> and zip-dist.mjs writes
// each manifest's download URL as <base>/<archive>. Override per-build with
// MARA_UPDATE_BASE_URL, or MARA_UPDATE_URL= (empty) to disable the check. Keep in sync with
// zip-dist.mjs's UPDATE_BASE_URL.
const UPDATE_BASE_URL = 'https://github.com/Darineth/Mara3/releases/latest/download';

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

# --- Presence ---
#MARA_DISCONNECT_GRACE_MS=15000  # hold a user's "disconnected" for this long after their
                                 # last socket drops; a reconnect within it is silent (no
                                 # leave/join spam from flaky mobile connections). 0 = off.
#MARA_FLAP_SETTLE_MS=300000      # a user who keeps dropping/reconnecting (a backgrounded
                                 # mobile tab) is flagged "flapping" and held on THIS longer
                                 # window instead, so their churn stays silent until they send
                                 # a message or stay gone this long. 0 = disable flap damping.
#MARA_UNRELIABLE_DROPS=2         # after this many join->leave cycles with NO message sent, a
                                 # client is flagged "unreliable" and its join/disconnect are
                                 # muted entirely until it next interacts (catches slow churn
                                 # that spaces reconnects past the flap window). 0 = off.

# --- Flood control (per-connection message rate limit) ---
#MARA_MSG_RATE=15           # sustained messages/sec allowed; 0 disables the limit
#MARA_MSG_BURST=30          # how many messages may be sent in a quick burst
#MARA_MSG_FLOOD_KICK=300    # consecutive over-limit messages before the socket is closed

# --- Uploads ---
#MARA_MAX_UPLOAD_MB=10       # per-file cap
#MARA_MAX_CACHE_MB=512       # total upload-cache cap (oldest evicted first)

# --- Avatars (durable, never evicted; downscaled client-side before upload) ---
#MARA_MAX_AVATAR_MB=2        # per-avatar cap
#MARA_AVATAR_DIR=D:\\Mara3-Data\\avatars

# --- Custom emoji (operator-provided) ---
# Drop image files (png/jpg/gif/webp/avif/bmp) into this folder; each file's name
# becomes its :shortcode: (e.g. blobwave.png -> :blobwave:). Served at /emoji/ and
# offered in the composer's emoji picker. Defaults to an "emoji" folder next to
# Mara3-Server.bat; new files are picked up within seconds (no restart needed).
#MARA_EMOJI_DIR=D:\\Mara3-Data\\emoji

# --- Custom emoji (user-contributed) ---
# Users can add their own emoji in-app (Menu -> Custom emoji): the image is stored durably in
# this folder and a shortcode is bound to it. Only the person who added an emoji can remove or
# replace it in-app. Everything is self-contained in the folder — images plus an index.json,
# so you can back it up or move it as a unit.
#MARA_MAX_EMOJI_MB=1          # per-emoji cap (GIFs kept as-is; others downscaled to 128px)
#MARA_MAX_EMOJI_COUNT=500     # cap on how many user-contributed emoji can exist at once
#MARA_USER_EMOJI_DIR=D:\\Mara3-Data\\user-emoji     # images + index.json (durable, never evicted)
# The index (shortcode -> image map) is the operator's moderation lever: index.json inside the
# folder above, a readable file ({"badword": {"file":"<id>.png","owner":<token>,"by":"<name>",
# "at":<ms>}, ...}). To take an emoji down, delete its entry — the server picks up the edit live
# (removes it for everyone and reclaims the image), no restart needed. Override the path with:
#MARA_USER_EMOJI_FILE=D:\\Mara3-Data\\user-emoji\\index.json

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

// A JDK dir is usable for the Android build only if it's 17+ (Android Gradle needs it). The
// ambient JAVA_HOME often points at an older JDK, so we validate rather than trust it.
function isJdk17Plus(dir) {
  try {
    const m = readFileSync(join(dir, 'release'), 'utf8').match(/JAVA_VERSION="?(\d+)/);
    if (m) return Number(m[1]) >= 17;
  } catch {
    /* no release file — fall through to the name check */
  }
  return /jdk[-_]?(1[7-9]|[2-9]\d)/i.test(dir);
}

function findJdk17() {
  const cands = [];
  if (process.env.JAVA_HOME) cands.push(process.env.JAVA_HOME);
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      Boolean,
    )) {
      for (const vendor of ['Microsoft', 'Eclipse Adoptium', 'Java', 'Amazon Corretto', 'Zulu']) {
        const dir = join(root, vendor);
        try {
          for (const name of readdirSync(dir)) cands.push(join(dir, name));
        } catch {
          /* vendor dir absent */
        }
      }
    }
  } else {
    for (const base of ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']) {
      try {
        for (const name of readdirSync(base)) {
          cands.push(
            process.platform === 'darwin' ? join(base, name, 'Contents/Home') : join(base, name),
          );
        }
      } catch {
        /* base absent */
      }
    }
  }
  return cands.find((c) => c && existsSync(c) && isJdk17Plus(c)) ?? null;
}

// Locate the Android toolchain (JDK 17+, SDK, NDK) from the environment or standard install
// locations. Returns the env overrides to build with, or null if anything is missing (so the
// APK step can skip gracefully, like the desktop step does when Rust is absent).
function resolveAndroidEnv() {
  const java = findJdk17();
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')
      : process.platform === 'darwin'
        ? join(process.env.HOME || '', 'Library', 'Android', 'sdk')
        : join(process.env.HOME || '', 'Android', 'Sdk'));
  let ndk = process.env.NDK_HOME || process.env.ANDROID_NDK_HOME || process.env.ANDROID_NDK_ROOT;
  if (!ndk && existsSync(join(sdk, 'ndk'))) {
    const versions = readdirSync(join(sdk, 'ndk'))
      .filter((d) => /^\d/.test(d))
      .sort();
    if (versions.length) ndk = join(sdk, 'ndk', versions[versions.length - 1]);
  }
  if (!java || !existsSync(sdk) || !ndk || !existsSync(ndk)) return null;
  return { JAVA_HOME: java, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, NDK_HOME: ndk };
}

const total = 5 + (skipDesktop ? 0 : 1) + (skipAndroid ? 0 : 1);
let stepNum = 5; // steps 1-5 below are fixed; desktop/android increment from here

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
  step(++stepNum, total, 'Building desktop client');
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

let androidApkBuilt = false;
if (!skipAndroid) {
  step(++stepNum, total, 'Building Android APK');
  const androidEnv = resolveAndroidEnv();
  if (!androidEnv) {
    console.log(
      '  - Android toolchain not found (need JDK 17+, Android SDK, and NDK); skipping APK.',
    );
    console.log('    Set JAVA_HOME / ANDROID_HOME / NDK_HOME (or install the SDK) to include it.');
  } else {
    // Signed release APK (arm64 — the only Android ABI we ship). Signing config + keystore
    // live in gen/android (gitignored); without them Gradle emits an *-unsigned.apk instead.
    run('pnpm --filter @mara/shell tauri android build --apk --target aarch64', {
      ...process.env,
      ...androidEnv,
    });
    const relDir = join(
      root,
      'apps',
      'shell',
      'src-tauri',
      'gen',
      'android',
      'app',
      'build',
      'outputs',
      'apk',
      'universal',
      'release',
    );
    const signed = join(relDir, 'app-universal-release.apk');
    const unsigned = join(relDir, 'app-universal-release-unsigned.apk');
    const androidDir = join(dist, 'android');
    if (existsSync(signed)) {
      mkdirSync(androidDir, { recursive: true });
      copyFileSync(signed, join(androidDir, 'Mara3.apk'));
      androidApkBuilt = true;
    } else if (existsSync(unsigned)) {
      mkdirSync(androidDir, { recursive: true });
      copyFileSync(unsigned, join(androidDir, 'Mara3-unsigned.apk'));
      console.log('  ! Release keystore not configured — produced an UNSIGNED APK (will not');
      console.log('    install as-is). Add gen/android/keystore.properties to sign it.');
    } else {
      console.log(`  ! No release APK found under ${relDir}`);
    }
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
if (androidApkBuilt) console.log('   android\\  Mara3.apk (signed release, arm64)');
console.log('============================================================');
