const event = JSON.parse(assets['/event.json'][1]);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function equalKey(actual, expected) {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

async function isAdmin(request, env) {
  const key = /^Bearer ([a-f0-9]{48})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!key || !env.ADMIN_KEY_HASH) return false;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return equalKey(Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), env.ADMIN_KEY_HASH);
}

async function bodyOf(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw error(415, 'Ожидается JSON');
  const reader = request.body?.getReader();
  if (!reader) throw error(400, 'Пустой запрос');
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw error(413, 'Слишком большой запрос'); }
    body += decoder.decode(value, { stream: true });
  }
  try {
    const value = JSON.parse(body + decoder.decode());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw error(400, 'Ожидается объект JSON'); }
}

function spectatorState(state) {
  const { started, rounds, results, active, streamUrl } = state;
  const seriesScores = currentSeriesScores(event, state);
  return { started, rounds, results, active, streamUrl, ...(Object.keys(seriesScores).length && { seriesScores }) };
}

function adminState({ state, bridge }) {
  const online = Date.now() - (bridge?.seen ?? 0) < 15_000;
  const snapshot = online ? bridge.game : null;
  const game = snapshot?.matchId && snapshot.matchId !== state.active
    ? { ...snapshot, matchId: null, ctTeam: null } : snapshot;
  return { ...spectatorState(state), broadcast: state.broadcast ?? {}, game, gsi: online && bridge.gsi,
    service: online, publishStatus: online ? 'ПК наблюдателя подключён' : 'ПК наблюдателя не на связи' };
}

async function readRecord(db) {
  const row = await db.prepare('SELECT body FROM tournament_snapshot WHERE id = 1').first();
  const raw = row?.body ?? null;
  const stored = raw == null ? emptyState : JSON.parse(raw);
  return { raw, record: stored.state ? stored : { state: spectatorState(stored), revision: 0 } };
}

async function changeRecord(db, apply) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { raw, record } = await readRecord(db);
    const next = apply(record);
    if (next === record) return record;
    next.revision = record.revision + 1;
    const body = JSON.stringify(next);
    const query = raw == null
      ? db.prepare('INSERT OR IGNORE INTO tournament_snapshot (id, body) VALUES (1, ?)').bind(body)
      : db.prepare('UPDATE tournament_snapshot SET body = ? WHERE id = 1 AND body = ?').bind(body, raw);
    if ((await query.run()).meta.changes === 1) return next;
  }
  throw error(409, 'Данные изменились. Повторите действие.');
}

function applyAction(record, body) {
  const { state, bridge } = record;
  const mapId = Date.now() - (bridge?.seen ?? 0) < 15_000 && bridge.active === state.active ? bridge.game?.mapId : null;
  const next = updateMatch(event, state, body, mapId);
  if (body.action === 'reset') return { ...record, state: next, bridge: undefined };
  return next === state ? record : { ...record, state: next };
}

function updateBridge(record, body) {
  const next = { ...record };
  if (body.action) Object.assign(next, applyAction(record, body.action));
  if (!body.telemetry) return next;

  const data = body.telemetry;
  const state = next.state;
  const active = data.active === state.active ? state.active : null;
  const match = resolveMatches(event, state).find(match => match.id === active);
  const raw = data.game;
  const mapId = typeof raw?.mapId === 'string' && /^[a-z0-9_]{1,64}$/.test(raw.mapId) ? raw.mapId : null;
  const linked = Boolean(active && match && (!Object.hasOwn(raw ?? {}, 'matchId') || raw.matchId === active));
  const ctTeam = linked && match.teams.some(team => team?.id === raw?.ctTeam) ? raw.ctTeam : null;
  const game = mapId ? { mapId, ctTeam, matchId: linked ? active : null } : null;
  if (game) {
    const boundedInt = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
    const phase = ['warmup', 'live', 'freezetime', 'over', 'intermission', 'halftime', 'paused',
      'timeout_ct', 'timeout_t', 'bomb', 'defuse', 'gameover'].includes(raw.phase) ? raw.phase : null;
    Object.assign(game, { ct: boundedInt(raw.ct, 1000), t: boundedInt(raw.t, 1000),
      round: boundedInt(raw.round, 2000), phase, clockEnd: boundedInt(raw.clockEnd, Date.now() + 3_600_000) });
  }
  next.bridge = { seen: Date.now(), active, gsi: data.gsi === true, game };

  const result = data.completed;
  if (result?.match === active && /^[a-z0-9_]{1,64}$/.test(result?.mapId ?? '') && match?.teams.some(team => team?.id === result.winner)) {
    const options = state.broadcast?.[active];
    if (options?.mapWinners?.[result.mapId] !== result.winner) {
      const mapWinners = { ...options?.mapWinners, [result.mapId]: result.winner };
      next.state = { ...state, broadcast: { ...state.broadcast, [active]: { ...options, mapWinners } } };
    }
  }
  return next;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === '/api/state' && request.method === 'GET') {
        return json(spectatorState((await readRecord(env.DB)).record.state));
      }
      if (pathname === '/api/control' && ['GET', 'POST'].includes(request.method)) {
        if (!await isAdmin(request, env)) return json({ error: 'Неверный ключ организатора' }, 401);
        if (request.method === 'GET') return json(adminState((await readRecord(env.DB)).record));
        const body = await bodyOf(request);
        return json(adminState(await changeRecord(env.DB, record => applyAction(record, body))));
      }
      if (pathname === '/api/bridge' && ['GET', 'POST'].includes(request.method)) {
        if (!env.PUBLISH_KEY || !equalKey(request.headers.get('Authorization'), `Bearer ${env.PUBLISH_KEY}`)) return json({ error: 'Нет доступа' }, 401);
        const body = request.method === 'POST' ? await bodyOf(request) : null;
        const record = body ? await changeRecord(env.DB, current => updateBridge(current, body)) : (await readRecord(env.DB)).record;
        return json({ state: record.state, revision: record.revision });
      }
      const asset = request.method === 'GET' && Object.hasOwn(assets, pathname) && assets[pathname];
      if (!asset) return new Response('Страница не найдена', { status: 404 });
      const [type, content, binary] = asset;
      const body = binary ? Uint8Array.from(atob(content), char => char.charCodeAt(0)) : content;
      return new Response(body, { headers: {
        'Content-Type': binary ? type : `${type}; charset=utf-8`, 'Cache-Control': binary ? 'public, max-age=3600' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      } });
    } catch (cause) {
      return json({ error: cause.status ? cause.message : 'Ошибка сервера' }, cause.status || 500);
    }
  },
};
