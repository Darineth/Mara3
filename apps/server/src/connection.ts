// Per-socket wrapper: tracks the login handshake stage and sends framed messages.
import { WebSocket } from 'ws';
import { encode, type ServerMessage, type Token } from '@mara/protocol';

/**
 * Connection stages: a fresh socket is `awaitingLogin` until the client sends a
 * valid `login`, which advances it to `active`; `closed` is terminal. Only
 * `active` connections may send the post-login message set.
 */
export type ConnectionState = 'awaitingLogin' | 'active' | 'closed';

/**
 * One client socket and its place in the login handshake. The hub owns all
 * shared state; a Connection only knows how to send and which user it became.
 */
export class Connection {
  state: ConnectionState = 'awaitingLogin';
  userToken: Token | null = null;
  /** Per-socket upload bearer secret, minted at login. */
  sessionToken: string | null = null;

  // -- inbound rate limiting (token bucket) ---------------------------------
  private tokens = 0;
  private lastRefillMs = 0;
  /** Consecutive over-limit messages (reset by an allowed one); drives the flood-kick. */
  dropStreak = 0;

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
  ) {}

  /**
   * Token-bucket gate for an inbound message: refills `rate` tokens/sec up to a
   * `burst` cap and consumes one. Returns true to allow; on false the caller drops
   * the message (`dropStreak` tracks the throttled run so a persistent flooder can
   * be disconnected). The bucket starts full (first call refills to `burst`).
   */
  rateAllow(nowMs: number, rate: number, burst: number): boolean {
    const elapsed = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.lastRefillMs = nowMs;
    this.tokens = Math.min(burst, this.tokens + elapsed * rate);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.dropStreak = 0;
      return true;
    }
    this.dropStreak += 1;
    return false;
  }

  send(message: ServerMessage): void {
    // Guard against sends to a half-closed socket (e.g. a broadcast racing a
    // disconnect); writing to a non-OPEN socket would throw.
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(message));
    }
  }

  close(code?: number, reason?: string): void {
    this.state = 'closed';
    this.ws.close(code, reason);
  }
}
