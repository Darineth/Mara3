/**
 * @mara/protocol — the single source of truth for the Mara wire format.
 *
 * Imported by both the server and every client so a message shape can change in
 * exactly one place and is validated identically on both ends.
 */

/**
 * Wire-protocol version. The client sends it in `login`; the server denies a
 * mismatch. Bump on any breaking change to the message set.
 */
export const PROTOCOL_VERSION = 1;

export * from './primitives.js';
export * from './messages.js';
export * from './codec.js';
