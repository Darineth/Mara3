// pnpm package:macos — build the macOS desktop client on a Mac over SSH and stage its DMG
// for the release. Like Linux, Tauri can't cross-compile the native webview (nor use the
// macOS SDK, codesign or hdiutil off a Mac), so the build runs on the Mac itself. This
// streams the working tree there, builds a universal (Apple Silicon + Intel) .app and its
// drag-to-Applications DMG (layout in tauri.macos.conf.json), and pulls the DMG back into
// dist/prebuilt/. A later `pnpm package:zip` ships it as-is, next to the other archives.
//
// The DMG layout is applied by scripting Finder, so the Mac needs a logged-in desktop
// session and, once, permission for sshd to control Finder (a prompt on the Mac's screen).
//
//   pnpm package:macos              build + stage the macOS client over SSH
//   pnpm package:macos --dry-run    print the plan + the remote build script, run nothing
//   pnpm package:macos --optional   skip (don't fail) when no Mac is configured/reachable —
//                                   package:all runs this form
// `pnpm package:all` runs this step itself (before zip-dist); on its own, follow with
// `pnpm package:zip` to assemble dist/zips/.
//
// Requires key-based SSH to the Mac (no password prompt — runs in BatchMode) and, on the
// Mac, Xcode command-line tools, Rust with both apple-darwin targets, Node and pnpm (see
// apps/shell/README.md). Config via env:
//   MARA_MAC_HOST         ssh destination: user@host or a ~/.ssh/config alias (required)
//   MARA_MAC_DIR          Mac-side build dir (default: $HOME/mara-macos-build; if you
//                         override it, use $HOME or an absolute path, not a ~)
//   MARA_UPDATE_BASE_URL  update-nudge host (default below); MARA_UPDATE_URL= to disable

import { execFileSync, execSync, spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');
const prebuiltDir = join(dist, 'prebuilt');
const stagedName = 'Mara3-macos-universal.dmg';
const dryRun = process.argv.includes('--dry-run');
// --optional (used by package:all): skip with a warning when no Mac is configured or it
// can't be reached, instead of failing the whole release. A reachable Mac whose build
// fails still hard-fails.
const optional = process.argv.includes('--optional');

// Keep in sync with package.mjs / package-linux.mjs. The client polls its own manifest,
// read from the CORS-enabled raw-content copy of `updates/`.
const MANIFEST_BASE_URL = 'https://raw.githubusercontent.com/Darineth/Mara3/main/updates';
const manifestBase = (process.env.MARA_MANIFEST_BASE_URL || MANIFEST_BASE_URL).replace(/\/+$/, '');
const updateUrl = process.env.MARA_UPDATE_URL ?? `${manifestBase}/latest-macos-universal.json`;

const host = process.env.MARA_MAC_HOST || '';
// $HOME stays literal so the Mac's shell expands it (a ~ from a variable wouldn't).
const macDir = process.env.MARA_MAC_DIR || '$HOME/mara-macos-build';
// Never prompt: a password or host-key question would hang the build with no one to answer.
const sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

/** On Windows, the OS's own ssh/tar rather than whatever PATH finds first. From a Git Bash
 *  shell that's Git's msys ssh, which can't reach the Windows ssh-agent — so a key with a
 *  passphrase fails in BatchMode — and msys tar, which reads "D:" as a remote host. */
function winTool(name) {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const p =
    name === 'ssh'
      ? join(sys, 'System32', 'OpenSSH', 'ssh.exe')
      : join(sys, 'System32', `${name}.exe`);
  return process.platform === 'win32' && existsSync(p) ? p : name;
}
const SSH = winTool('ssh');
const TAR = winTool('tar');

const shellConf = JSON.parse(
  readFileSync(join(root, 'apps/shell/src-tauri/tauri.conf.json'), 'utf8'),
);
const appName = `${shellConf.productName}.app`;

/**
 * Run a command, forwarding its output as it arrives (a universal release build takes
 * minutes and must not sit silent). `input` is written to its stdin; `stdin` instead pipes
 * another process's output in; `stdout` redirects its output to a stream.
 */
function run(cmd, args, { input, stdin, stdout, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.pipe(stdout ?? process.stdout, { end: !!stdout });
    child.stderr.on('data', (c) => process.stderr.write(c));
    if (stdin) stdin.pipe(child.stdin);
    else child.stdin.end(input ?? '');
    child.on('error', reject);
    child.on('close', (code) => {
      if (!stdout) return resolve(code ?? 1);
      // Let the file finish flushing before anyone reads it.
      if (stdout.writableFinished) resolve(code ?? 1);
      else stdout.once('finish', () => resolve(code ?? 1));
    });
  });
}

// The build script that runs on the Mac. Uses only `$VAR` (no `${...}`) so it doesn't
// collide with this JS template literal — the only interpolations here are ours.
const script = `#!/usr/bin/env bash
# A non-interactive ssh session reads no login profile, so pick up the user's toolchain
# (Homebrew, rustup, nvm, pnpm) however they set it up. Before set -u: profiles aren't
# written to survive it.
for f in "$HOME/.zprofile" "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.cargo/env"; do
  [ -f "$f" ] && . "$f" >/dev/null 2>&1 || true
done
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$HOME/Library/pnpm:$PATH"
set -euo pipefail

DIR="${macDir}"
TREE="$DIR/tree"
OUT="$DIR/${stagedName}"
BUNDLE="apps/shell/src-tauri/target/universal-apple-darwin/release/bundle"
APP="$BUNDLE/macos/${appName}"

for t in aarch64-apple-darwin x86_64-apple-darwin; do
  rustup target list --installed | grep -qx "$t" || {
    echo "ERROR: Rust target $t is missing — on the Mac: rustup target add $t"; exit 1; }
done

# Mirror the uploaded tree into the build dir. A separate step (not extracting in place) so
# files deleted on Windows are deleted here too, while node_modules and target survive
# between builds — a from-scratch universal build compiles everything twice.
echo ">> syncing uploaded tree -> $TREE"
mkdir -p "$TREE"
rsync -a --delete --exclude node_modules --exclude target --exclude dist --exclude .git "$DIR/.src/" "$TREE/"

cd "$TREE"
echo ">> pnpm install"
pnpm install
echo ">> building @mara/shell (Tauri 2, macOS universal, .app + .dmg)"
# The DMG's window layout (background, icon spots) is set by scripting Finder. Tauri skips
# that step when CI is set, which would ship a plain unarranged window, so make sure it isn't.
unset CI
rm -rf "$BUNDLE/dmg"
if ! MARA_UPDATE_URL="${updateUrl}" pnpm --filter @mara/shell exec tauri build --target universal-apple-darwin; then
  echo "ERROR: tauri build failed. If it died laying out the DMG (osascript / Finder / -1743):"
  echo "  the Mac must have a logged-in desktop session, and the first run shows a prompt there"
  echo "  asking to let sshd control Finder. Allow it (System Settings -> Privacy & Security ->"
  echo "  Automation), then rerun."
  exit 1
fi

[ -d "$APP" ] || { echo "ERROR: build produced no $APP"; exit 1; }
codesign --verify --deep --strict "$APP"
DMGS=("$BUNDLE"/dmg/*.dmg)
[ -f "$DMGS" ] || { echo "ERROR: build produced no DMG in $BUNDLE/dmg"; exit 1; }
hdiutil verify "$DMGS" >/dev/null
echo ">> staging dmg -> $OUT"
cp "$DMGS" "$OUT"
echo ">> staged $(du -h "$OUT" | cut -f1)"
`;

console.log('package:macos — build the macOS desktop client over SSH\n');
console.log(`  host:       ${host || '(MARA_MAC_HOST not set)'}`);
console.log(`  build dir:  ${macDir}`);
console.log(`  bundle:     ${appName} (universal-apple-darwin)`);
console.log(`  staging:    dist/prebuilt/${stagedName}`);
console.log(`  update URL: ${updateUrl || '(disabled)'}\n`);

if (dryRun) {
  console.log('--- Mac build script (--dry-run; nothing executed) ---\n');
  console.log(script);
  process.exit(0);
}

function skipOrFail(msg, help) {
  if (optional) {
    console.warn(
      `package:macos: ${msg}; skipping. The release will omit the macOS client\n` +
        '  unless a valid one is already staged in dist/prebuilt/.',
    );
    process.exit(0);
  }
  console.error(`package:macos: ${msg}.\n${help}`);
  process.exit(1);
}

// Preflight. Distinguish "no Mac" (skippable under --optional) from "Mac reachable but the
// build broke" (always a hard fail, so a setup problem isn't silently swallowed into a
// release with no macOS client).
if (!host) {
  skipOrFail(
    'MARA_MAC_HOST is not set',
    "  Set it to the Mac's ssh destination, e.g. MARA_MAC_HOST=me@mac-mini.local",
  );
}
try {
  execFileSync(SSH, [...sshOpts, host, 'true'], { stdio: 'ignore' });
} catch {
  skipOrFail(
    `can't reach ${host} over SSH`,
    '  - Enable Remote Login on the Mac (System Settings → General → Sharing).\n' +
      '  - Set up key auth (ssh-copy-id, or append your public key to ~/.ssh/authorized_keys\n' +
      '    on the Mac) and connect once by hand to accept its host key.',
  );
}

// Upload: stream a tar of the working tree straight into a fresh staging dir on the Mac.
// tar runs with cwd = repo root and archives "." — handing it a D:\ path would make an
// msys GNU tar (if that's the tar on PATH) read "D:" as a remote host.
console.log(`>> uploading working tree -> ${host}:${macDir}/.src`);
const tar = spawn(
  TAR,
  [
    '-c',
    '-f',
    '-',
    ...['node_modules', 'target', 'dist', '.git'].flatMap((x) => ['--exclude', x]),
    '.',
  ],
  { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
);
const tarDone = new Promise((res) => tar.on('close', (code) => res(code ?? 1)));
const uploadStatus = await run(
  SSH,
  [
    ...sshOpts,
    host,
    `rm -rf "${macDir}/.src" && mkdir -p "${macDir}/.src" && tar -x -f - -C "${macDir}/.src"`,
  ],
  { stdin: tar.stdout },
);
if ((await tarDone) !== 0 || uploadStatus !== 0) {
  console.error('\npackage:macos: uploading the working tree failed (see output above).');
  process.exit(1);
}

const buildStatus = await run(SSH, [...sshOpts, host, 'bash -s'], {
  input: script.replace(/\r\n/g, '\n'),
});
if (buildStatus !== 0) {
  console.error('\npackage:macos: the Mac build failed (see output above).');
  process.exit(1);
}

// Download the staged DMG. `cat` over ssh rather than scp: the remote path carries a
// literal $HOME that only a remote shell expands.
mkdirSync(prebuiltDir, { recursive: true });
const staged = join(prebuiltDir, stagedName);
rmSync(staged, { force: true });
const fetchStatus = await run(SSH, [...sshOpts, host, `cat "${macDir}/${stagedName}"`], {
  stdout: createWriteStream(staged),
});
if (fetchStatus !== 0 || !existsSync(staged) || statSync(staged).size === 0) {
  rmSync(staged, { force: true });
  console.error(`\npackage:macos: couldn't download the staged DMG from ${host}.`);
  process.exit(1);
}

// Bind the staged DMG to the release it was built from, so zip-dist refuses to fold a
// stale one into a later release (it's preserved across `pnpm package`'s clean). The
// version is the shell's own (client) track — the same value zip-dist names it by.
function tryExec(cmd) {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}
const porcelain = tryExec('git status --porcelain');
const meta = {
  version: shellConf.version ?? null,
  commit: tryExec('git rev-parse --short HEAD'),
  dirty: porcelain == null ? null : porcelain.length > 0,
  builtAt: new Date().toISOString(),
};
writeFileSync(`${staged}.build.json`, `${JSON.stringify(meta, null, 2)}\n`);

console.log('\n============================================================');
console.log(` Done. Staged macOS client: dist/prebuilt/${stagedName}`);
console.log('   Next: pnpm package:zip (or pnpm package:all) folds it into dist/zips/');
console.log('         as Mara3-macos-universal-*.dmg + latest-macos-universal.json.');
console.log('============================================================');
