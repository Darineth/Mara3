import { mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { EmojiEntry, Token } from '@mara/protocol';
import { EMOJI_ROUTE } from './emoji.js';
import type { Logger } from './logger.js';

/** A stored user-contributed emoji: the image file (a random-hex name in the user-emoji dir,
 *  served at `/emoji/<file>`), the durable user token of whoever added it (the only one who
 *  may replace or remove it), their display name at add time (for the management UI), and
 *  when it was added. */
export interface UserEmojiRecord {
  file: string;
  owner: Token;
  by: string;
  at: number;
}

/** A served user-emoji filename: our random 32-hex name + a known extension (matching what the
 *  upload endpoint mints). A hand-edited file that doesn't match is ignored on load. */
const FILE_RE = /^[0-9a-f]{32}\.(png|jpg|gif|webp|avif|bmp)$/;
/** The emoji shortcode charset (mirrors the wire's `emojiNameSchema`, min 2). */
const NAME_RE = /^[a-zA-Z0-9_+-]{2,64}$/;

/**
 * The user-contributed custom emoji set: a persisted map of `:shortcode:` → its stored image
 * and owner. Unlike the operator {@link EmojiStore} (where the filesystem is the source of
 * truth and the filename is the shortcode), this decouples shortcode from filename so an owner
 * can rename-by-replacing and we can record who may remove each one. Persistence mirrors the
 * identity store: debounced async writes, a synchronous flush on shutdown, an empty file path
 * meaning in-memory only (tests).
 *
 * The JSON file is also the **operator's moderation lever**: {@link watchExternal} re-reads it
 * when it changes on disk (an edit we didn't make), so removing an entry by hand takes effect
 * live. See {@link reloadFromDisk}.
 */
export class UserEmojiStore {
  private readonly byName = new Map<string, UserEmojiRecord>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** mtime (ms) of the file as of our last write, so the watcher can tell our own writes from
   *  an external (operator) edit. */
  private lastWriteMtime = 0;
  private watcher: FSWatcher | null = null;
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly saveDelayMs = 1500,
  ) {
    if (this.file) {
      const loaded = this.parseFile();
      if (loaded) this.applyMap(loaded);
      this.recordMtime();
      this.log.info({ emoji: this.byName.size, file: this.file }, 'loaded user emoji');
    }
  }

  /** The current set as wire entries (shortcode → `/emoji/` URL, plus owner + adder name). */
  manifest(): EmojiEntry[] {
    return [...this.byName].map(([name, rec]) => ({
      name,
      url: `${EMOJI_ROUTE}${rec.file}`,
      owner: rec.owner,
      by: rec.by,
    }));
  }

  get(name: string): UserEmojiRecord | undefined {
    return this.byName.get(name);
  }

  count(): number {
    return this.byName.size;
  }

  /** Bind (or overwrite) a shortcode to a record and persist. Policy — reserved names,
   *  ownership, caps — is enforced by the caller (the hub). */
  set(name: string, rec: UserEmojiRecord): void {
    this.byName.set(name, rec);
    this.schedule();
  }

  /** Remove a shortcode, returning its record (so the caller can delete the file), and persist.
   *  Undefined if it wasn't present. */
  delete(name: string): UserEmojiRecord | undefined {
    const rec = this.byName.get(name);
    if (!rec) return undefined;
    this.byName.delete(name);
    this.schedule();
    return rec;
  }

  /**
   * Watch the file for external (operator) edits. On a change we didn't make, re-read it and
   * invoke `onChange` with the records whose image is no longer referenced (so the caller can
   * delete those orphaned files and broadcast the new set). A malformed edit is ignored — the
   * current set is kept, never wiped. Returns a stop function. No-op for an in-memory store.
   */
  watchExternal(onChange: (removed: UserEmojiRecord[]) => void): () => void {
    if (!this.file) return () => {};
    const dir = dirname(this.file);
    const target = basename(this.file);
    try {
      // Watch the *directory* (not the file) so an editor's atomic save — write temp, rename
      // over the file — is still seen; filter events down to our file by name.
      this.watcher = watch(dir, (_event, filename) => {
        if (filename && filename.toString() !== target) return;
        if (this.watchDebounce) return; // coalesce the burst of events one save produces
        this.watchDebounce = setTimeout(() => {
          this.watchDebounce = null;
          this.handleExternalChange(onChange);
        }, 200);
        this.watchDebounce.unref?.();
      });
      this.watcher.unref?.(); // never keep the process alive on its own
    } catch (err) {
      this.log.warn(
        { err, file: this.file },
        'could not watch user-emoji file; operator edits will need a restart',
      );
      return () => {};
    }
    return () => this.stopWatch();
  }

  private stopWatch(): void {
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private handleExternalChange(onChange: (removed: UserEmojiRecord[]) => void): void {
    let mtime = 0;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      mtime = 0; // file removed → treat as an external edit (reload → empty)
    }
    if (mtime === this.lastWriteMtime) return; // our own write echoing back
    const removed = this.reloadFromDisk();
    onChange(removed);
  }

  /**
   * Re-read the file from disk, replacing the in-memory set, and return the records whose image
   * is no longer referenced (removed, or repointed to a different file) so the caller can free
   * them. A malformed/unreadable file is ignored (current set kept, nothing removed). Public so
   * the watcher — and tests — can drive it directly.
   */
  reloadFromDisk(): UserEmojiRecord[] {
    const next = this.parseFile();
    if (!next) return []; // parse error → keep what we have
    const before = new Map(this.byName);
    this.applyMap(next);
    this.recordMtime();
    const removed: UserEmojiRecord[] = [];
    for (const [name, rec] of before) {
      if (this.byName.get(name)?.file !== rec.file) removed.push(rec);
    }
    return removed;
  }

  /** Parse the file into a fresh map: an absent file yields an empty map; a read or JSON error
   *  yields `null` (caller keeps its current set rather than wiping it). */
  private parseFile(): Map<string, UserEmojiRecord> | null {
    const map = new Map<string, UserEmojiRecord>();
    if (!this.file) return map;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return map; // absent → empty
      this.log.warn({ err, file: this.file }, 'could not read user-emoji file; keeping current');
      return null;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      this.log.warn({ err, file: this.file }, 'user-emoji file is not valid JSON; ignoring edit');
      return null;
    }
    for (const [name, value] of Object.entries(obj)) {
      if (!NAME_RE.test(name) || !value || typeof value !== 'object') continue;
      const v = value as { file?: unknown; owner?: unknown; by?: unknown; at?: unknown };
      if (typeof v.file !== 'string' || !FILE_RE.test(v.file)) continue;
      if (typeof v.owner !== 'number') continue;
      map.set(name, {
        file: v.file,
        owner: v.owner,
        by: typeof v.by === 'string' ? v.by.slice(0, 64) : '',
        at: typeof v.at === 'number' ? v.at : 0,
      });
    }
    return map;
  }

  private applyMap(map: Map<string, UserEmojiRecord>): void {
    this.byName.clear();
    for (const [name, rec] of map) this.byName.set(name, rec);
  }

  private recordMtime(): void {
    try {
      this.lastWriteMtime = statSync(this.file).mtimeMs;
    } catch {
      this.lastWriteMtime = 0; // no file yet
    }
  }

  private schedule(): void {
    if (!this.file) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, this.saveDelayMs);
    this.timer.unref?.();
  }

  private snapshot(): string {
    const obj: Record<string, UserEmojiRecord> = {};
    for (const [name, rec] of this.byName) obj[name] = rec;
    return JSON.stringify(obj);
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      await writeFile(this.file, this.snapshot());
      this.recordMtime(); // so the watcher recognizes this write as ours
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to persist user emoji');
      this.dirty = true;
    }
  }

  /** Synchronous final write for shutdown; also stops the watcher so the process can exit. */
  flush(): void {
    this.stopWatch();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, this.snapshot());
      this.recordMtime();
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to flush user emoji on shutdown');
    }
  }
}
