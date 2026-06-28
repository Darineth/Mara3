import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigFile } from './config.js';

// Each test writes a throwaway config file under a fresh temp dir and points the
// loader at it via MARA_CONFIG, so nothing touches the real cwd or process.env.
const dirs: string[] = [];
function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mara-cfg-'));
  dirs.push(dir);
  const path = join(dir, 'mara.config');
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('loadConfigFile', () => {
  it('returns null and leaves env untouched when no file exists', () => {
    const env = { MARA_CONFIG: join(tmpdir(), 'does-not-exist-xyz', 'mara.config') };
    expect(loadConfigFile(env)).toBeNull();
    expect(env).toEqual({ MARA_CONFIG: env.MARA_CONFIG });
  });

  it('fills MARA_* values into env and reports which it applied', () => {
    const path = writeConfig('MARA_PORT=6000\nMARA_HOST=127.0.0.1\n');
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path };
    const result = loadConfigFile(env);
    expect(result?.path).toBe(path);
    expect(result?.applied.sort()).toEqual(['MARA_HOST', 'MARA_PORT']);
    expect(env.MARA_PORT).toBe('6000');
    expect(env.MARA_HOST).toBe('127.0.0.1');
  });

  it('never overwrites a variable already set in the environment (env wins)', () => {
    const path = writeConfig('MARA_PORT=6000\n');
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path, MARA_PORT: '7000' };
    const result = loadConfigFile(env);
    expect(env.MARA_PORT).toBe('7000'); // unchanged
    expect(result?.applied).not.toContain('MARA_PORT');
  });

  it('skips comments, blanks, and non-MARA keys', () => {
    const path = writeConfig(
      ['# a comment', '', '   ', 'PATH=/evil', 'NODE_OPTIONS=--bad', 'MARA_PORT=6000'].join('\n'),
    );
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path };
    loadConfigFile(env);
    expect(env.PATH).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.MARA_PORT).toBe('6000');
  });

  it('strips one layer of matching surrounding quotes and trims whitespace', () => {
    const path = writeConfig('MARA_MOTD = "Welcome, all!"\nMARA_SERVER_NAME=\'My Server\'\n');
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path };
    loadConfigFile(env);
    expect(env.MARA_MOTD).toBe('Welcome, all!');
    expect(env.MARA_SERVER_NAME).toBe('My Server');
  });

  it('strips inline comments from values, but quotes protect a literal #', () => {
    const path = writeConfig(
      [
        'MARA_PORT=6000   # the listen port',
        'MARA_MOTD="welcome #1 fans"   # a greeting',
        'MARA_UPLOAD_DIR=/srv/a#b', // bare # (no leading space) is part of the value
      ].join('\n'),
    );
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path };
    loadConfigFile(env);
    expect(env.MARA_PORT).toBe('6000');
    expect(env.MARA_MOTD).toBe('welcome #1 fans');
    expect(env.MARA_UPLOAD_DIR).toBe('/srv/a#b');
  });

  it('feeds through to loadConfig so the file shapes the final config', () => {
    const path = writeConfig('MARA_PORT=6000\nMARA_SERVER_NAME=Edited\n');
    const env: NodeJS.ProcessEnv = { MARA_CONFIG: path };
    loadConfigFile(env);
    const cfg = loadConfig(env);
    expect(cfg.port).toBe(6000);
    expect(cfg.serverName).toBe('Edited');
  });
});

describe('loadConfig storage paths', () => {
  it('roots history, identity, and uploads under MARA_BASE_DIR', () => {
    const cfg = loadConfig({ MARA_BASE_DIR: '/srv/mara' });
    expect(cfg.uploadDir).toBe(join('/srv/mara', 'uploads'));
    expect(cfg.historyFile).toBe(join('/srv/mara', 'data', 'history.json'));
    expect(cfg.identityFile).toBe(join('/srv/mara', 'data', 'identity.json'));
  });

  it('lets a per-store override win over MARA_BASE_DIR', () => {
    const cfg = loadConfig({ MARA_BASE_DIR: '/srv/mara', MARA_UPLOAD_DIR: '/mnt/pics' });
    expect(cfg.uploadDir).toBe('/mnt/pics');
    expect(cfg.historyFile).toBe(join('/srv/mara', 'data', 'history.json')); // others still base
  });

  it('keeps the empty-string "disable persistence" escape hatch', () => {
    const cfg = loadConfig({
      MARA_BASE_DIR: '/srv/mara',
      MARA_HISTORY_FILE: '',
      MARA_IDENTITY_FILE: '',
    });
    expect(cfg.historyFile).toBe('');
    expect(cfg.identityFile).toBe('');
  });

  it('falls back to the server package dir when no base is set', () => {
    const cfg = loadConfig({});
    expect(cfg.uploadDir.endsWith('uploads')).toBe(true);
    expect(cfg.historyFile.endsWith(join('data', 'history.json'))).toBe(true);
  });
});
