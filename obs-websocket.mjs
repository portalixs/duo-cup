import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('base64');

export function createObsConnection({ port = 4455, password = '' }, onEvent) {
  let current;

  function connect() {
    if (current) return current;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const connection = { socket, pending };
    current = connection;
    connection.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => socket.close(), 2500);
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        if (current === connection) current = null;
        const error = new Error('Нет связи с OBS WebSocket');
        reject(error);
        for (const request of pending.values()) request.reject(error);
      });
      socket.addEventListener('error', () => socket.close());
      socket.addEventListener('message', event => {
        let packet;
        try { packet = JSON.parse(event.data); }
        catch { socket.close(); return; }
        const { op, d } = packet ?? {};
        if (!d) return;
        if (op === 0) {
          const { authentication } = d;
          const proof = authentication && hash(hash(password + authentication.salt) + authentication.challenge);
          const eventSubscriptions = 4 | 64 | 256; // Scenes, outputs and media inputs.
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions, ...(proof && { authentication: proof }) } }));
        } else if (op === 2) {
          clearTimeout(timer);
          resolve();
        } else if (op === 5) {
          onEvent(d.eventType, d.eventData);
        } else if (op === 7) {
          const request = pending.get(d.requestId);
          if (!request) return;
          if (d.requestStatus?.result) request.resolve(d.responseData ?? {});
          else request.reject(new Error(d.requestStatus?.comment ?? `OBS: ${d.requestStatus?.code ?? 'ошибка запроса'}`));
        }
      });
    });
    return connection;
  }

  async function request(requestType, requestData = {}, timeout = 1400) {
    const connection = connect();
    await connection.ready;
    const { socket, pending } = connection;
    const requestId = randomUUID();
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`OBS не ответил на ${requestType}`)), timeout);
        pending.set(requestId, { resolve, reject });
        socket.send(JSON.stringify({ op: 6, d: { requestId, requestType, requestData } }));
      });
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  }

  return { request, close: () => current?.socket.close() };
}
