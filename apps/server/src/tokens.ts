// Token minting: user/channel identifiers and opaque session resume secrets.
import { randomBytes, randomInt } from 'node:crypto';
import type { Token } from '@mara/protocol';

/**
 * Allocate a fresh non-zero uint32 token not already in use — the modern stand-in
 * for Mara 2's Mersenne-Twister token draw with collision retry.
 */
export function nextToken(isTaken: (t: Token) => boolean): Token {
  let token: Token;
  do {
    // [1, 2^32): excludes 0, which the protocol reserves as a "no token" sentinel.
    token = randomInt(1, 0x1_0000_0000);
  } while (isTaken(token));
  return token;
}

/**
 * Opaque token a client presents to resume a session after reconnecting. 128
 * bits of entropy: it doubles as the upload-endpoint bearer credential, so it
 * must be unguessable.
 */
export function makeResumeToken(): string {
  return randomBytes(16).toString('hex');
}
