/**
 * Wire codec: encode messages to WebSocket text frames and decode/validate
 * incoming ones. Each direction comes in throwing (`parse*`) and non-throwing
 * (`safeParse*`) variants so callers pick error-handling style per call site.
 */
import { z } from 'zod';
import {
  clientMessageSchema,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from './messages.js';

/** Raised when an incoming frame is not valid JSON or fails schema validation. */
export class ProtocolError extends Error {
  constructor(
    message: string,
    /** Underlying Zod issue list, when validation (not JSON) failed. */
    readonly issues?: z.ZodIssue[],
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/** Discriminated result of a non-throwing `safeParse*` call (mirrors Zod's). */
export type ParseResult<T> = { success: true; data: T } | { success: false; error: ProtocolError };

/** Serialize a message to a WebSocket text frame. */
export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ProtocolError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function decode<S extends z.ZodTypeAny>(schema: S, raw: string | unknown): z.output<S> {
  // Accept either a raw frame string or an already-parsed value, so callers
  // that received pre-deserialized JSON skip a redundant parse round-trip.
  const json = typeof raw === 'string' ? parseJson(raw) : raw;
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ProtocolError('message failed validation', result.error.issues);
  }
  return result.data;
}

function safeDecode<S extends z.ZodTypeAny>(
  schema: S,
  raw: string | unknown,
): ParseResult<z.output<S>> {
  try {
    return { success: true, data: decode(schema, raw) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof ProtocolError ? err : new ProtocolError(String(err)),
    };
  }
}

/** Parse a client→server frame, throwing {@link ProtocolError} on failure. */
export function parseClientMessage(raw: string | unknown): ClientMessage {
  return decode(clientMessageSchema, raw);
}

/** Parse a server→client frame, throwing {@link ProtocolError} on failure. */
export function parseServerMessage(raw: string | unknown): ServerMessage {
  return decode(serverMessageSchema, raw);
}

/** Non-throwing variant for client→server frames. */
export function safeParseClientMessage(raw: string | unknown): ParseResult<ClientMessage> {
  return safeDecode(clientMessageSchema, raw);
}

/** Non-throwing variant for server→client frames. */
export function safeParseServerMessage(raw: string | unknown): ParseResult<ServerMessage> {
  return safeDecode(serverMessageSchema, raw);
}
