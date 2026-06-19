// Token minting: public user/channel identifiers and the per-session secret.
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
 * Per-session secret handed to the client in `welcome`. 128 bits of entropy: it
 * is the bearer credential for authenticated HTTP calls (the upload endpoint),
 * so it must be unguessable and is never broadcast like the public token.
 */
export function makeSessionToken(): string {
  return randomBytes(16).toString('hex');
}
