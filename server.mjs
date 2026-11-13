import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, resolveMatches } from './dist/model.mjs';
import { createObserverHud } from './hud-data.mjs';
import { error, updateMatch } from './tournament-control.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');
const event = JSON.parse(readFileSync(join(dist, 'event.json'), 'utf8'));
const port = Number(process.env.PORT || 8787);
const host = '127.0.0.1';
const runtime = resolve(process.env.TOURNAMENT_DATA_DIR || join(root, 'runtime'));
const statePath = join(runtime, 'state.json');
const secretPath = join(runtime, 'keys.json');
mkdirSync(runtime, { recursive: true });

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

const makeKey = () => randomBytes(24).toString('hex');
const keys = readJson(secretPath, { admin: makeKey(), gsi: makeKey() });
if (!/^[a-f0-9]{48}$/.test(keys.admin) || !/^[a-f0-9]{48}$/.test(keys.gsi)) {
  throw new Error('Повреждён файл ключей runtime/keys.json');
}
try { writeFileSync(secretPath, JSON.stringify(keys, null, 2), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }

const cfg = `"DUO CUP observer"
{
    "uri" "http://127.0.0.1:${port}/api/gsi"
    "timeout" "2.0"
    "buffer" "0.1"
    "throttle" "0.2"
    "heartbeat" "5.0"
    "auth" { "token" "${keys.gsi}" }
    "data"
    {
        "provider" "1"
        "map" "1"
        "round" "1"
        "allplayers_id" "1"
        "allplayers_state" "1"
        "allplayers_weapons" "1"
        "allplayers_match_stats" "1"
        "allplayers_position" "1"
        "player_id" "1"
        "phase_countdowns" "1"
        "bomb" "1"
        "allgrenades" "1"
    }
}
`;
writeFileSync(join(runtime, 'gamestate_integration_duocup.cfg'), cfg, { mode: 0o600 });

let state = readJson(statePath, emptyState);
let game = null;
let lastGsi = 0;
const observerHud = createObserverHud();
const staleAfter = 15_000;
const publication = readJson(join(runtime, 'publish.json'), null);
let publishStatus = publication ? 'Ожидается синхронизация' : 'Публикация не настроена';
let revision = -1;
let completedMap = null;

function commit(next) {
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2));
  renameSync(temporary, statePath);
  state = next;
}

function equalKey(value, key) {
  return typeof value === 'string' && value.length === key.length &&
    Buffer.byteLength(value) === key.length && timingSafeEqual(Buffer.from(value), Buffer.from(key));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 96 * 1024) throw error(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw error(400, 'Ожидается объект JSON'); }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function publicState() {
  const fresh = Date.now() - lastGsi < staleAfter;
  return {
    results: state.results,
    active: state.active,
    game: state.active && fresh ? game : null,
    gsi: fresh,
    rounds: state.rounds,
    broadcast: state.broadcast ?? {},
    started: state.started,
    streamUrl: state.streamUrl || event.streamUrl,
    service: true,
    publishStatus,
  };
}

async function syncSite(action) {
  const { active, gsi, game: current } = publicState();
  const completed = completedMap;
  const telemetry = { active, gsi, game: current && { mapId: current.mapId, ctTeam: current.ctTeam }, completed };
  const response = await fetch(new URL('/api/bridge', publication.url), {
    method: 'POST', headers: { Authorization: `Bearer ${publication.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, telemetry }), signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw error(response.status, data.error || 'Сайт недоступен');
  if (!data.state || !Number.isSafeInteger(data.revision)) throw new Error('Некорректный ответ сайта');
  if (data.revision > revision) {
    if (state.active !== data.state.active) { game = null; completedMap = null; }
    if (JSON.stringify(state) !== JSON.stringify(data.state)) commit(data.state);
    revision = data.revision;
  }
  if (completedMap === completed && (!completed || data.state.broadcast?.[completed.match]?.mapWinners?.[completed.mapId] === completed.winner)) completedMap = null;
  publishStatus = 'Сайт синхронизирован';
}

async function publish() {
  try {
    await syncSite();
  } catch (cause) { publishStatus = `Сайт недоступен (${cause.message})`; }
  setTimeout(publish, 2500).unref();
}

function receiveGame(payload) {
  if (!equalKey(payload.auth?.token, keys.gsi)) throw error(401, 'Неверный ключ GSI');
  if (payload.provider?.appid !== 730) throw error(400, 'Ожидаются данные CS2');
  lastGsi = Date.now();
  const map = payload.map;
  const ct = map?.team_ct?.score;
  const t = map?.team_t?.score;
  if (!state.active || !Number.isSafeInteger(ct) || ct < 0 || !Number.isSafeInteger(t) || t < 0 ||
      typeof map.name !== 'string' || !/^[a-z0-9_/-]{1,128}$/i.test(map.name)) {
    game = null;
    return;
  }
  const mapId = map.name.split('/').at(-1).toLowerCase();
  const mapName = mapId.replace(/^(de|cs|ar|dz)_/i, '').replaceAll('_', ' ');
  const match = resolveMatches(event, state).find(item => item.id === state.active);
  const options = state.broadcast?.[state.active];
  const hud = observerHud(payload, match, options, mapId);
  if (map.phase === 'gameover' && ct !== t && hud.ctTeam && match?.teams.every(Boolean)) {
    const winner = ct > t ? hud.ctTeam : match.teams.find(team => team.id !== hud.ctTeam).id;
    if (options?.mapWinners?.[mapId] !== winner) {
      if (publication) completedMap = { match: match.id, mapId, winner };
      else {
        const mapWinners = { ...options?.mapWinners, [mapId]: winner };
        commit({ ...state, broadcast: { ...state.broadcast, [match.id]: { ...options, mapWinners } } });
      }
    }
  }
  game = {
    map: mapName.charAt(0).toUpperCase() + mapName.slice(1),
    mapId, ct, t,
    ...hud,
    phase: ['warmup', 'intermission', 'gameover'].includes(map.phase) ? map.phase : (hud.phase ?? 'live'),
    buying: map.phase === 'live' && hud.phase === 'freezetime',
    clockEnd: map.phase === 'gameover' ? null : hud.clockEnd,
  };
}

const publicFiles = new Map([
  ['/', 'index.html'], ['/obs', 'obs.html'], ['/control', 'control.html'],
  ...['index.html', 'obs.html', 'control.html', 'event.json', 'style.css', 'obs.css', 'hud.css', 'art.svg',
    'app.mjs', 'model.mjs', 'obs.mjs', 'control.mjs'].map(file => [`/${file}`, file]),
]);
const mime = { html: 'text/html', css: 'text/css', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, publicState());
    if (req.method === 'GET' && path === '/api/hud-media') return json(res, 200, readJson(join(runtime, 'hud-media.json'), {}));
    if (req.method === 'POST' && path === '/api/gsi') {
      receiveGame(await readBody(req));
      res.writeHead(204).end();
      return;
    }
    if (['GET', 'POST'].includes(req.method) && path === '/api/control') {
      if (!equalKey(req.headers.authorization, `Bearer ${keys.admin}`)) throw error(401, 'Неверный ключ организатора');
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (publication) await syncSite(body);
        else {
          const next = updateMatch(event, state, body, game?.mapId ?? null);
          if (next.active !== state.active) game = null;
          if (next !== state) commit(next);
        }
      }
      return json(res, 200, publicState());
    }
    const hudAsset = /^\/hud\/(assets\.json|(radar\/[a-z0-9_]+\.png)|(weapons\/[a-z0-9_]+\.svg))$/.test(path);
    const media = /^\/hud-media\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(path);
    const file = req.method === 'GET' && (publicFiles.get(path) || (hudAsset || media ? path.slice(1) : null));
    if (!file) throw error(404, 'Страница не найдена');
    let content;
    try { content = readFileSync(join(media ? runtime : dist, file)); }
    catch (cause) { if (cause.code === 'ENOENT') throw error(404, 'Файл не найден'); throw cause; }
    const type = mime[file.split('.').at(-1)];
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': hudAsset ? 'public, max-age=300' : 'no-cache' });
    res.end(content);
  } catch (cause) {
    if (!cause.status) console.error(cause);
    if (!res.writableEnded) json(res, cause.status || 500, cause.status ? { error: cause.message } : { error: 'Ошибка сервера' });
  }
}

const server = createServer(handle);
server.listen(port, host, () => {
  console.log(`Сайт          http://${host}:${port}/`);
  console.log(`Организатор   http://${host}:${port}/control`);
  console.log(`Ключ          ${secretPath}`);
  console.log(`CS2           ${join(runtime, 'gamestate_integration_duocup.cfg')}`);
});
if (publication) publish();
