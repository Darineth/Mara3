import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic, writeFileAtomicSync } from './atomicWrite.js';

describe('atomic writes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mara-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file and leaves no temp file behind', async () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, '{"old":true}');
    await writeFileAtomic(file, '{"new":true}');
    expect(readFileSync(file, 'utf8')).toBe('{"new":true}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('creates the directory on first write (sync flush)', () => {
    const file = join(dir, 'nested', 'state.json');
    writeFileAtomicSync(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
