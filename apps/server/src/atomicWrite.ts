import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Atomic file replacement for the persisted stores: write a temp file beside the target, then
// rename it over the real one. An in-place write interrupted by a hard kill or power cut leaves
// truncated JSON, which the next boot can't parse and whose replacement would erase the data
// for good; a rename either lands whole or not at all.

/** Atomically replace `file` with `data` (creating its directory if needed). */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Synchronous {@link writeFileAtomic}, for the final flush on shutdown. */
export function writeFileAtomicSync(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
