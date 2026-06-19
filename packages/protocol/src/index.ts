/**
 * @mara/protocol — the single source of truth for the Mara wire format.
 *
 * Imported by both the server and every client so a message shape can change in
 * exactly one place and is validated identically on both ends.
 */

/** Bumped on any breaking change to the message set. Negotiated at handshake. */
export const PROTOCOL_VERSION = 1;

/**
 * The Mara product generation (this is Mara 3), carried in the `clientVersion`
 * handshake. Tracked separately from PROTOCOL_VERSION: the product can rev
 * without a wire-breaking change, and vice versa.
 */
export const MARA_VERSION = 3;

export * from './primitives.js';
export * from './messages.js';
export * from './codec.js';
