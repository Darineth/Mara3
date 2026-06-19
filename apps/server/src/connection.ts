// Per-socket wrapper: tracks the login handshake stage and sends framed messages.
import { WebSocket } from 'ws';
import { encode, type ServerMessage, type Token } from '@mara/protocol';

/**
 * Login handshake stages, advanced strictly in order by the hub:
 * `awaitingVersion` → `awaitingLogin` → `active`, plus a terminal `closed`.
 * Only `active` connections may send the post-login message set.
 */
export type ConnectionState = 'awaitingVersion' | 'awaitingLogin' | 'active' | 'closed';

/**
 * One client socket and its place in the login handshake. The hub owns all
 * shared state; a Connection only knows how to send and which user it became.
 */
export class Connection {
  state: ConnectionState = 'awaitingVersion';
  userToken: Token | null = null;

  constructor(
    readonly id: string,
    private readonly ws: WebSocket,
  ) {}

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
