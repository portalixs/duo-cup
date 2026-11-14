import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createObsConnection } from '../obs-websocket.mjs';

const hello = { op: 0, d: { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } } };

function sendText(socket, message) {
  const json = Buffer.from(JSON.stringify(message));
  assert.ok(json.length < 126);
  socket.write(Buffer.concat([Buffer.from([0x81, json.length]), json]));
}

async function withObs(onConnect, check) {
  const sockets = new Set();
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onConnect(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await check(server.address().port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('reports when OBS requests a password that has not been configured', async () => {
  await withObs(socket => sendText(socket, hello), async port => {
    const client = createObsConnection({ port });
    await assert.rejects(client.request('GetVersion'), { code: 'OBS_PASSWORD_REQUIRED' });
  });
});

test('reports an authentication failure without disclosing the password', async () => {
  await withObs(socket => {
    socket.once('data', () => socket.end(Buffer.from([0x88, 0x02, 0x0f, 0xa9])));
    sendText(socket, hello);
  }, async port => {
    const client = createObsConnection({ port, password: 'do-not-expose' });
    await assert.rejects(client.request('GetVersion'), error => {
      assert.equal(error.code, 'OBS_AUTH_FAILED');
      assert.ok(!error.message.includes('do-not-expose'));
      return true;
    });
  });
});

test('distinguishes invalid protocol and a WebSocket endpoint without an OBS handshake', async () => {
  await withObs(socket => sendText(socket, { 'update-type': 'Heartbeat' }), async port => {
    const client = createObsConnection({ port });
    await assert.rejects(client.request('GetVersion'), { code: 'OBS_PROTOCOL_UNSUPPORTED' });
  });
  await withObs(() => {}, async port => {
    const client = createObsConnection({ port });
    await assert.rejects(client.request('GetVersion'), { code: 'OBS_HANDSHAKE_TIMEOUT' });
  });
});
