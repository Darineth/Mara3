import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
    try {
      // Shape: { [channelName]: entry[] }. Validate each entry via the protocol
      // schema so a corrupt/tampered file can't smuggle in malformed data.
      const obj = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      // Backfill ids for entries written before message ids existed, so an old history
      // file migrates transparently: find the max id already present, then assign the
      // rest in stored (chronological) order. Newer files already carry ids, so this is a
      // no-op for them.
      let maxId = 0;
      for (const arr of Object.values(obj)) {
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
          const id = (e as { id?: unknown })?.id;
          if (typeof id === 'number' && id > maxId) maxId = id;
        }
      }
      for (const [name, arr] of Object.entries(obj)) {
        if (!Array.isArray(arr)) continue;
        this.data.set(
          name,
          arr.map((e) => {
            if (e && typeof e === 'object' && (e as { id?: unknown }).id == null) {
              (e as { id: number }).id = ++maxId;
            }
            return channelHistoryEntrySchema.parse(e);
          }),
        );
      }
      this.log.info({ channels: this.data.size, file: this.file }, 'loaded message history');
    } catch (err) {
      // Missing file is normal on first run; anything else we note but tolerate
      // (start empty rather than refuse to boot on a corrupt history file).
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn({ err, file: this.file }, 'could not load history; starting empty');
      }
    }
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
      mkdirSync(dirname(this.file), { recursive: true });
      await writeFile(this.file, this.snapshot());
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to persist history');
      this.dirty = true; // retry on the next change
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
      writeFileSync(this.file, this.snapshot());
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to flush history on shutdown');
    }
  }
}
