import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { channelHistoryEntrySchema, type ChannelHistoryEntry } from '@mara/protocol';
import type { Logger } from './logger.js';

/**
 * Per-channel message backlog with optional disk persistence. Always provides
 * the in-memory ring buffer the hub reads/writes; when constructed with a file
 * path it also loads on startup and saves (debounced) on change, so backlog
 * survives a server restart. An empty path means in-memory only.
 */
export class HistoryStore {
  private readonly data = new Map<string, ChannelHistoryEntry[]>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly saveDelayMs = 1500,
  ) {
    this.load();
  }

  /** A channel's retained backlog (oldest first); never null. */
  get(name: string): ChannelHistoryEntry[] {
    return this.data.get(name) ?? [];
  }

  /** The newest `limit` entries (oldest first), plus whether older ones exist. Used for
   *  the initial join backlog so a client gets a chunk, not the whole retained history. */
  recent(name: string, limit: number): { entries: ChannelHistoryEntry[]; hasMore: boolean } {
    const all = this.get(name);
    const entries = limit >= all.length ? all : all.slice(all.length - limit);
    return { entries, hasMore: all.length > entries.length };
  }

  /** Up to `limit` entries with id < `beforeId` (the newest of those, oldest first), plus
   *  whether still-older entries exist. Used to page older history on scroll-up. */
  before(
    name: string,
    beforeId: number,
    limit: number,
  ): { entries: ChannelHistoryEntry[]; hasMore: boolean } {
    const older = this.get(name).filter((e) => e.id < beforeId);
    const entries = limit >= older.length ? older : older.slice(older.length - limit);
    return { entries, hasMore: older.length > entries.length };
  }

  /** A single retained message by id, or undefined once it has aged out of the channel's
   *  buffer. Scoped to one channel by design: it's what stops a reply from quoting a
   *  message the replier can't see (an id from a channel they aren't in). */
  byId(name: string, id: number): ChannelHistoryEntry | undefined {
    return this.get(name).find((e) => e.id === id);
  }

  /** Highest retained message id (0 if none). The hub seeds its id counter from this
   *  so newly-assigned ids keep increasing across restarts. */
  maxId(): number {
    let max = 0;
    for (const arr of this.data.values()) for (const e of arr) if (e.id > max) max = e.id;
    return max;
  }

  /** Append a message, cap the buffer, and schedule a save. */
  append(name: string, entry: ChannelHistoryEntry, cap: number): void {
    const arr = this.data.get(name) ?? [];
    arr.push(entry);
    if (arr.length > cap) arr.splice(0, arr.length - cap);
    this.data.set(name, arr);
    this.schedule();
  }

  private load(): void {
    if (!this.file) return; // persistence disabled
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      // Missing file is normal on first run; anything else we note but tolerate.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn({ err, file: this.file }, 'could not read history; starting empty');
      }
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      // Unparseable file (e.g. a truncated write from a crash). Start empty, but move
      // the file aside first — otherwise the next save would overwrite it, turning a
      // recoverable accident into permanent loss.
      const rescue = `${this.file}.corrupt`;
      try {
        renameSync(this.file, rescue);
        this.log.error({ err, file: this.file, rescue }, 'history file corrupt; moved aside');
      } catch (renameErr) {
        this.log.error({ err, renameErr, file: this.file }, 'history file corrupt and un-movable');
      }
      return;
    }
    // Shape: { [channelName]: entry[] }. Validate each entry via the protocol schema so
    // a corrupt/tampered file can't smuggle in malformed data. Validation is PER ENTRY:
    // a bad entry is dropped (and counted), never allowed to take the rest of the
    // history down with it — an all-or-nothing parse here once meant one invalid entry
    // silently discarded everything after it, made permanent by the next save.
    // Backfill ids for entries written before message ids existed, so an old history
    // file migrates transparently: find the max id already present, then assign the
    // rest in stored (chronological) order. Newer files already carry ids.
    let maxId = 0;
    for (const arr of Object.values(obj)) {
      if (!Array.isArray(arr)) continue;
      for (const e of arr) {
        const id = (e as { id?: unknown })?.id;
        if (typeof id === 'number' && id > maxId) maxId = id;
      }
    }
    let dropped = 0;
    for (const [name, arr] of Object.entries(obj)) {
      if (!Array.isArray(arr)) continue;
      const entries: ChannelHistoryEntry[] = [];
      for (const e of arr) {
        if (e && typeof e === 'object' && (e as { id?: unknown }).id == null) {
          (e as { id: number }).id = ++maxId;
        }
        const parsed = channelHistoryEntrySchema.safeParse(e);
        if (parsed.success) entries.push(parsed.data);
        else dropped++;
      }
      this.data.set(name, entries);
    }
    if (dropped > 0) {
      this.log.warn({ dropped, file: this.file }, 'dropped invalid history entries on load');
    }
    this.log.info({ channels: this.data.size, file: this.file }, 'loaded message history');
  }

  private schedule(): void {
    if (!this.file) return; // in-memory only
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, this.saveDelayMs);
    // Don't let a pending save keep the process alive on its own.
    this.timer.unref?.();
  }

  private snapshot(): string {
    return JSON.stringify(Object.fromEntries(this.data));
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      // Atomic: write a temp file, then rename over the real one. An in-place write
      // interrupted by a crash/power cut leaves truncated JSON — which the next boot
      // can't parse, and whose replacement would erase the history for good.
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, this.snapshot());
      await rename(tmp, this.file);
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to persist history; will retry');
      // Retry on our own schedule — "on the next change" isn't enough, because if no
      // further message ever arrives the tail would sit unwritten until shutdown (or
      // be lost in a crash). Transient Windows file locks make this path real.
      this.dirty = true;
      this.schedule();
    }
  }

  /** Synchronous final write for shutdown (cancels any pending debounce). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, this.snapshot());
      renameSync(tmp, this.file);
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to flush history on shutdown');
    }
  }
}
