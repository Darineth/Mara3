import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@mara/protocol';
import { getServerInfo, readWebBuild, SERVER_VERSION } from './version.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mara-ver-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('server version + served web build', () => {
  it('reports its name, own semver, and protocol version', () => {
    const info = getServerInfo(null, 'My Server');
    expect(info.name).toBe('My Server');
    expect(info.version).toBe(SERVER_VERSION);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.protocol).toBe(PROTOCOL_VERSION);
    expect(info.webBuild).toBeUndefined(); // no web root → nothing served
  });

  it('reads the build id of the served web assets from version.json', () => {
    writeFileSync(
      join(dir, 'version.json'),
      JSON.stringify({ version: '3.0.0', buildId: 'abc123' }),
    );
    expect(readWebBuild(dir)).toBe('abc123');
    expect(getServerInfo(dir, 'My Server').webBuild).toBe('abc123');
  });

  it('stays quiet when version.json is missing or malformed', () => {
    expect(readWebBuild(dir)).toBeUndefined(); // no file
    writeFileSync(join(dir, 'version.json'), 'not json');
    expect(readWebBuild(dir)).toBeUndefined();
    writeFileSync(join(dir, 'version.json'), JSON.stringify({ version: '3.0.0' })); // no buildId
    expect(readWebBuild(dir)).toBeUndefined();
  });
});
