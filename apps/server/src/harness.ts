import { WebSocket } from 'ws';
import {
  encode,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
  type UserStyle,
} from '@mara/protocol';

/**
 * A minimal async WebSocket client for driving the server in tests. Buffers
 * incoming server messages and lets tests await the next one of a given type.
 */
export class TestClient {
  private readonly queue: ServerMessage[] = [];
  private waiter: ((m: ServerMessage) => void) | null = null;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = parseServerMessage(data.toString());
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

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

const defaultStyle: UserStyle = {
  font: { family: 'Verdana', pointSize: 10, bold: false, italic: false, underline: false },
  color: '#cccccc',
};

/** Run the version + login handshake; resolve the assigned user token + name. */
export async function login(
  client: TestClient,
  name: string,
  style: UserStyle = defaultStyle,
): Promise<{ token: number; name: string }> {
  await client.waitFor('serverHello');
  client.send({ type: 'clientVersion', maraVersion: 3, clientVersion: 1, appVersion: 1 });
  await client.waitFor('response');
  client.send({ type: 'login', name, style });
  const accepted = await client.waitFor('loginAccepted');
  return { token: accepted.token, name: accepted.name };
}
