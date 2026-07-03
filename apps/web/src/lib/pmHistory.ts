/**
 * Device-local private-message history. The server deliberately never stores,
 * queues, or replays PMs — that stance is unchanged. What this module adds is
 * purely this-device memory: each browser profile keeps the PM lines it has
 * itself witnessed in localStorage, so a refresh/restart restores open
 * conversations (and pop-out windows can hydrate from the same store).
 *
 * The blob is bound to the identity key it was saved under; a different
 * identity on the same origin loads nothing. Conversations are keyed by peer
 * token, which the server keeps stable for identified users — a peer who
 * connected anonymously may reappear under a new token, orphaning (but not
 * losing) the old thread.
 */
import type { ChatLine, RestoredPmConversation, Token } from '@mara/client-core';

const KEY = 'mara3.pmHistory';

/** Retention caps: plenty for a chat you'd scroll back through, comfortably
 *  inside localStorage quotas even with many threads. */
export const PM_HISTORY_MAX_LINES = 200;
export const PM_HISTORY_MAX_CONVERSATIONS = 50;

interface StoredBlob {
  identityKey: string;
  conversations: RestoredPmConversation[];
}

/** The subset of Storage we use; injectable so tests don't need a real DOM. */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** Shape-check one stored line; garbage entries are dropped rather than trusted. */
function validLine(value: unknown): value is Omit<ChatLine, 'id'> {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  return (
    (l.kind === 'chat' || l.kind === 'emote') &&
    (typeof l.from === 'number' || l.from === null) &&
    typeof l.text === 'string' &&
    typeof l.at === 'number'
  );
}

function validConversation(value: unknown): value is RestoredPmConversation {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.peer === 'number' &&
    typeof c.name === 'string' &&
    typeof c.color === 'string' &&
    Array.isArray(c.lines)
  );
}

/**
 * Load the persisted conversations for `identityKey`, ready to hand to
 * MaraClient's `initialPrivateMessages`. Any failure (no storage, bad JSON,
 * another identity's blob) yields `[]` — history must never block startup.
 */
export function loadPmHistory(
  identityKey: string,
  storage: StorageLike | null = defaultStorage(),
): RestoredPmConversation[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const blob = JSON.parse(raw) as Partial<StoredBlob>;
    if (blob.identityKey !== identityKey || !Array.isArray(blob.conversations)) return [];
    return blob.conversations
      .filter(validConversation)
      .map((c) => ({ ...c, lines: c.lines.filter(validLine).slice(-PM_HISTORY_MAX_LINES) }));
  } catch {
    return [];
  }
}

/**
 * Persist the current conversations (write-through from the live store). Lines
 * are capped per conversation; when there are too many conversations the least
 * recently active are dropped — without disturbing the given order, which is
 * the tab order to restore. Ids are stripped — they're per-session render
 * keys, reassigned on restore.
 */
export function savePmHistory(
  identityKey: string,
  conversations: { peer: Token; name: string; color: string; lines: ChatLine[] }[],
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  let kept = conversations.map((c) => ({
    peer: c.peer,
    name: c.name,
    color: c.color,
    lines: c.lines.slice(-PM_HISTORY_MAX_LINES).map(({ id: _id, ...line }) => line),
  }));
  if (kept.length > PM_HISTORY_MAX_CONVERSATIONS) {
    const lastAt = (c: (typeof kept)[number]) => c.lines[c.lines.length - 1]?.at ?? 0;
    const survivors = new Set(
      [...kept]
        .sort((a, b) => lastAt(b) - lastAt(a))
        .slice(0, PM_HISTORY_MAX_CONVERSATIONS)
        .map((c) => c.peer),
    );
    kept = kept.filter((c) => survivors.has(c.peer));
  }
  const blob: StoredBlob = { identityKey, conversations: kept };
  try {
    storage.setItem(KEY, JSON.stringify(blob));
  } catch {
    /* quota / privacy mode — losing history is acceptable, breaking chat is not */
  }
}

/**
 * Merge a single conversation into the stored blob, leaving the rest untouched.
 * Used by PM pop-out windows: they own exactly one conversation and must not
 * clobber the main window's full tab set — but they must persist lines they
 * received while the main window wasn't around to write them.
 */
export function upsertPmConversation(
  identityKey: string,
  convo: { peer: Token; name: string; color: string; lines: ChatLine[] },
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const stored = {
    peer: convo.peer,
    name: convo.name,
    color: convo.color,
    lines: convo.lines.slice(-PM_HISTORY_MAX_LINES).map(({ id: _id, ...line }) => line),
  };
  const conversations = loadPmHistory(identityKey, storage);
  const i = conversations.findIndex((c) => c.peer === convo.peer);
  if (i >= 0) conversations[i] = stored;
  else conversations.push(stored);
  const blob: StoredBlob = { identityKey, conversations };
  try {
    storage.setItem(KEY, JSON.stringify(blob));
  } catch {
    /* ignore */
  }
}

/** Forget one conversation (the user closed its tab — this device stops remembering it). */
export function removePmConversation(
  identityKey: string,
  peer: Token,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  const conversations = loadPmHistory(identityKey, storage).filter((c) => c.peer !== peer);
  const blob: StoredBlob = { identityKey, conversations };
  try {
    storage.setItem(KEY, JSON.stringify(blob));
  } catch {
    /* ignore */
  }
}

/** Forget everything (the user turned PM history off). */
export function clearPmHistory(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
