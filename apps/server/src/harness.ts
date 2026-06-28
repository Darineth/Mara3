// Test-support helpers: a tiny promise-based WS client and a login shortcut, used
// by the server test suites to drive a real socket against an in-process server.
import { WebSocket } from 'ws';
import {
  encode,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
} from '@mara/protocol';

/**
 * A minimal async WebSocket client for driving the server in tests. Buffers
 * incoming server messages and lets tests await the next one of a given type.
 */
export class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((m: ServerMessage) => void) | null = null;
  /** Resolves when the server (or we) close the socket — with the close code. */
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(private readonly ws: WebSocket) {
    this.closed = new Promise((resolve) =>
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    ws.on('message', (data) => {
      const msg = parseServerMessage(data.toString());
      // Hand directly to a pending next() if one is waiting; otherwise buffer.
      // Assumes a single outstanding waiter (tests await sequentially).
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  /** Open a socket and resolve once it's connected (rejects on connect error). */
  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  send(message: ClientMessage): void {
    this.ws.send(encode(message));
  }

  /** Resolve the next buffered/incoming server message. */
  next(timeoutMs = 1000): Promise<ServerMessage> {
    const buffered = this.queue.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('timed out waiting for server message'));
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(timer);
        resolve(m);
      };
    });
  }

  /** Await the next message of a specific type, discarding others in between. */
  async waitFor<T extends ServerMessageType>(
    type: T,
    timeoutMs = 1000,
  ): Promise<ServerMessageOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for "${type}"`);
      const msg = await this.next(remaining);
      if (msg.type === type) return msg as ServerMessageOf<T>;
    }
  }

  close(): void {
    this.ws.close();
  }
}

/** Log in (the client speaks first); resolve the assigned token, name + secret. */
export async function login(
  client: TestClient,
  name: string,
  color = '#cccccc',
  identityKey?: string,
): Promise<{ token: number; name: string; sessionToken: string }> {
  client.send({
    type: 'login',
    protocol: PROTOCOL_VERSION,
    name,
    color,
    ...(identityKey ? { identityKey } : {}),
  });
  const welcome = await client.waitFor('welcome');
  return { token: welcome.self.token, name: welcome.self.name, sessionToken: welcome.sessionToken };
}
