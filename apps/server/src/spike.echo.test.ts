import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

// Spike B: prove a browser-style JSON message survives a WebSocket round-trip.
// This validates the transport + envelope shape before the real protocol lands.

let wss: WebSocketServer;
let url: string;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(data.toString()));
  });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as AddressInfo;
  url = `ws://127.0.0.1:${port}`;
});

afterAll(() => {
  wss.close();
});

it('round-trips a JSON envelope over WebSocket', async () => {
  const sent = { type: 'chat', payload: { channelToken: 12345, userToken: 678, text: 'hi' } };

  const received = await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => ws.send(JSON.stringify(sent)));
    ws.on('message', (data) => {
      resolve(JSON.parse(data.toString()));
      ws.close();
    });
    ws.on('error', reject);
  });

  expect(received).toEqual(sent);
});
