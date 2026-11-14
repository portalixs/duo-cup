import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('base64');
const obsError = (code, message) => Object.assign(new Error(message), { code });
const protocolError = () => obsError('OBS_PROTOCOL_UNSUPPORTED', 'Проверьте, что выбран порт WebSocket 5.x в OBS Studio 28 или новее.');

export function createObsConnection({ port = 4455, password = '' }, onEvent = () => {}) {
  let current;

  function connect() {
    if (current) return current;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    const connection = { socket, pending };
    current = connection;
    connection.ready = new Promise((resolve, reject) => {
      let opened = false;
      let identified = false;
      const unreachable = () => obsError('OBS_UNREACHABLE', `WebSocket OBS недоступен на порту ${port}. Проверьте порт и включите сервер в OBS.`);
      const timer = setTimeout(() => {
        fail(opened ? obsError('OBS_HANDSHAKE_TIMEOUT', `Порт ${port} открылся, но OBS WebSocket 5.x не завершил подключение. Проверьте порт в OBS.`) : unreachable());
      }, 2500);
      function fail(error) {
        clearTimeout(timer);
        if (current === connection) current = null;
        reject(error);
        for (const request of pending.values()) request.reject(error);
        if (socket.readyState < WebSocket.CLOSING) socket.close();
      }
      socket.addEventListener('open', () => { opened = true; });
      socket.addEventListener('close', ({ code }) => {
        const error = code === 4009
          ? obsError('OBS_AUTH_FAILED', 'OBS отклонил пароль WebSocket. Скопируйте актуальный пароль из OBS и сохраните его в пульте.')
          : code === 4010 ? protocolError()
            : opened ? obsError('OBS_DISCONNECTED', 'OBS закрыл соединение WebSocket.') : unreachable();
        fail(error);
      });
      socket.addEventListener('message', event => {
        let packet;
        try { packet = JSON.parse(event.data); }
        catch { fail(protocolError()); return; }
        const { op, d } = packet ?? {};
        if (!d || (!identified && op !== 0 && op !== 2)) {
          if (!identified) fail(protocolError());
          return;
        }
        if (op === 0) {
          const { authentication } = d;
          if (!Number.isInteger(d.rpcVersion) || d.rpcVersion < 1) { fail(protocolError()); return; }
          if (authentication && !password) {
            fail(obsError('OBS_PASSWORD_REQUIRED', 'OBS требует пароль WebSocket. Скопируйте пароль из OBS и сохраните его в пульте.'));
            return;
          }
          const proof = authentication && hash(hash(password + authentication.salt) + authentication.challenge);
          const eventSubscriptions = 4 | 64 | 256; // Scenes, outputs and media inputs.
          socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions, ...(proof && { authentication: proof }) } }));
        } else if (op === 2) {
          identified = true;
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
