import { randomBytes, randomInt } from 'node:crypto';
import type { Token } from '@mara/protocol';

/**
 * Allocate a fresh non-zero uint32 token not already in use — the modern stand-in
 * for Mara 2's Mersenne-Twister token draw with collision retry.
 */
export function nextToken(isTaken: (t: Token) => boolean): Token {
  let token: Token;
  do {
    token = randomInt(1, 0x1_0000_0000);
  } while (isTaken(token));
  return token;
}

/** Opaque token a client presents to resume a session after reconnecting. */
export function makeResumeToken(): string {
  return randomBytes(16).toString('hex');
}
