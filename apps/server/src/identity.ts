import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Token } from '@mara/protocol';
import type { Logger } from './logger.js';

/**
 * Stable client identity → user token, with optional disk persistence so a
 * client keeps the same token across reconnects *and* server restarts. The
 * client presents a secret `identityKey`; we only ever store its SHA-256 hash
 * (keyed by hex), so the on-disk file never holds the raw secret. An empty file
 * path means in-memory only (tests).
 */
export class IdentityStore {
  // hashed key -> user token
  private readonly byKey = new Map<string, Token>();
  // reverse set, so token allocation can avoid a token bound to an offline identity
  private readonly tokens = new Set<Token>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string,
    private readonly log: Logger,
    private readonly saveDelayMs = 1500,
  ) {
    this.load();
  }

  private static hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  /** The stable token bound to this identity key, or undefined if unseen. */
  tokenFor(key: string): Token | undefined {
    return this.byKey.get(IdentityStore.hash(key));
  }

  /** Bind an identity key to a freshly minted token (persisted). */
  bind(key: string, token: Token): void {
    this.byKey.set(IdentityStore.hash(key), token);
    this.tokens.add(token);
    this.schedule();
  }

  /** Whether a token is reserved by some (possibly offline) identity. */
  reserves(token: Token): boolean {
    return this.tokens.has(token);
  }

  private load(): void {
    if (!this.file) return;
    try {
      const obj = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [h, token] of Object.entries(obj)) {
        if (typeof token === 'number') {
          this.byKey.set(h, token);
          this.tokens.add(token);
        }
      }
      this.log.info({ identities: this.byKey.size, file: this.file }, 'loaded identities');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.log.warn({ err, file: this.file }, 'could not load identities; starting empty');
      }
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
    return JSON.stringify(Object.fromEntries(this.byKey));
  }

  private async persist(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      await writeFile(this.file, this.snapshot());
    } catch (err) {
      this.log.error({ err, file: this.file }, 'failed to persist identities');
      this.dirty = true;
    }
  }

  /** Synchronous final write for shutdown. */
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
      this.log.error({ err, file: this.file }, 'failed to flush identities on shutdown');
    }
  }
}
