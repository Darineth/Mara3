import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { colorSchema, type Token } from '@mara/protocol';
import type { Logger } from './logger.js';

/** The parts of a user's presence that are *visible to others* — so they belong to
 *  the identity, not the device, and follow it across clients. Local-only settings
 *  (theme, macros, …) stay on each client. Both fields travel together. */
export interface IdentityProfile {
  name: string;
  color: string;
}

/** What we persist per identity: the stable token, plus the shared profile once set. */
interface IdentityRecord {
  token: Token;
  profile?: IdentityProfile;
}

/** A stored name is bounded like the wire's; a bad hand-edit is ignored, not fatal. */
function validProfile(name: unknown, color: unknown): IdentityProfile | undefined {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) return undefined;
  if (!colorSchema.safeParse(color).success) return undefined;
  return { name, color: color as string };
}

/**
 * Stable client identity → user token (and the shared, others-visible profile), with
 * optional disk persistence so a client keeps the same token *and* display name/colour
 * across reconnects, server restarts, and other clients adopting the same identity. The
 * client presents a secret `identityKey`; we only ever store its SHA-256 hash (keyed by
 * hex), so the on-disk file never holds the raw secret. An empty file path means
 * in-memory only (tests).
 */
export class IdentityStore {
  // hashed key -> record. The reverse index (token -> the *same* record object) lets
  // profile updates, which arrive keyed by token after login, find their record; it
  // also doubles as the "is this token reserved by an identity" set.
  private readonly byKey = new Map<string, IdentityRecord>();
  private readonly byToken = new Map<Token, IdentityRecord>();
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
    return this.byKey.get(IdentityStore.hash(key))?.token;
  }

  /** The identity's stored profile (name + colour), or undefined if none set yet. A
   *  fresh copy, so callers can't mutate our record. */
  profileFor(key: string): IdentityProfile | undefined {
    const p = this.byKey.get(IdentityStore.hash(key))?.profile;
    return p ? { ...p } : undefined;
  }

  /** Bind an identity key to a freshly minted token (persisted; profile set later). */
  bind(key: string, token: Token): void {
    const record: IdentityRecord = { token };
    this.byKey.set(IdentityStore.hash(key), record);
    this.byToken.set(token, record);
    this.schedule();
  }

  /** Record the others-visible profile for a token's identity (persisted). A no-op for
   *  an anonymous (unbound) token, so ephemeral users leave nothing on disk. */
  setProfile(token: Token, profile: IdentityProfile): void {
    const record = this.byToken.get(token);
    if (!record) return;
    record.profile = { name: profile.name, color: profile.color };
    this.schedule();
  }

  /** Whether a token is reserved by some (possibly offline) identity. */
  reserves(token: Token): boolean {
    return this.byToken.has(token);
  }

  private register(hash: string, record: IdentityRecord): void {
    this.byKey.set(hash, record);
    this.byToken.set(record.token, record);
  }

  private load(): void {
    if (!this.file) return;
    try {
      const obj = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [h, value] of Object.entries(obj)) {
        // v1 format: hash -> token (a bare number). v2: hash -> { token, name?, color? }.
        if (typeof value === 'number') {
          this.register(h, { token: value });
        } else if (value && typeof value === 'object') {
          const v = value as { token?: unknown; name?: unknown; color?: unknown };
          if (typeof v.token === 'number') {
            this.register(h, { token: v.token, profile: validProfile(v.name, v.color) });
          }
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
    const obj: Record<string, { token: Token; name?: string; color?: string }> = {};
    for (const [h, rec] of this.byKey) {
      obj[h] = rec.profile
        ? { token: rec.token, name: rec.profile.name, color: rec.profile.color }
        : { token: rec.token };
    }
    return JSON.stringify(obj);
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
