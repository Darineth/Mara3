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
export const PROTOCOL_VERSION = 5;

/**
 * WebSocket close code 1012, "service restart": the server is stopping cleanly (it sends this
 * to every socket on shutdown), so a client can say so rather than report a lost connection.
 */
export const CLOSE_SERVICE_RESTART = 1012;

export * from './primitives.js';
export * from './messages.js';
export * from './codec.js';
