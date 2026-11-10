import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyState, nextRound, resolveMatches } from './dist/model.mjs';

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
    "throttle" "0.5"
    "heartbeat" "5.0"
    "auth" { "token" "${keys.gsi}" }
    "data"
    {
        "provider" "1"
        "map" "1"
        "round" "1"
    }
}
`;
writeFileSync(join(runtime, 'gamestate_integration_duocup.cfg'), cfg, { mode: 0o600 });

let state = readJson(statePath, emptyState);
let game = null;
let lastGsi = 0;
const staleAfter = 15_000;
const publication = readJson(join(runtime, 'publish.json'), null);
let publishedSnapshot = '';
let publishStatus = publication ? 'Ожидается синхронизация' : 'Публикация не настроена';

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

function error(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw error(413, 'Слишком большой запрос');
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
    started: state.started,
    streamUrl: state.streamUrl || event.streamUrl,
    service: true,
    publishStatus,
  };
}

async function publish() {
  const { started, rounds, results, active, streamUrl } = publicState();
  const snapshot = JSON.stringify({ started, rounds, results, active, streamUrl });
  try {
    if (snapshot !== publishedSnapshot) {
      const response = await fetch(new URL('/api/publish', publication.url), {
        method: 'PUT', headers: { Authorization: `Bearer ${publication.key}`, 'Content-Type': 'application/json' },
        body: snapshot, signal: AbortSignal.timeout(6000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      publishedSnapshot = snapshot;
      publishStatus = 'Сайт синхронизирован';
    }
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
  const mapName = map.name.split('/').at(-1).replace(/^(de|cs|ar|dz)_/i, '').replaceAll('_', ' ');
  game = {
    map: mapName.charAt(0).toUpperCase() + mapName.slice(1),
    ct, t,
    phase: ['warmup', 'live', 'intermission', 'gameover'].includes(map.phase) ? map.phase : 'unknown',
  };
}

function updateMatch(body) {
  if (body.action === 'event') {
    if (!state.started) commit({ ...state, started: true, rounds: [nextRound(event, state)] });
    return;
  }
  if (body.action === 'stream') {
    const value = body.url;
    if (typeof value !== 'string' || value.length > 500) throw error(400, 'Укажите ссылку HTTPS');
    if (value) {
      try { if (new URL(value).protocol !== 'https:') throw new Error(); }
      catch { throw error(400, 'Укажите ссылку HTTPS'); }
    }
    commit({ ...state, streamUrl: value });
    return;
  }
  if (body.action === 'pause') {
    commit({ ...state, active: null });
    game = null;
    return;
  }

  if (!state.started) throw error(409, 'Сначала запустите турнир');
  if (body.action === 'round') {
    if (body.round !== state.rounds.length) throw error(409, 'Обновите панель перед созданием тура');
    const matches = nextRound(event, state);
    if (!matches.length) throw error(409, 'Нет следующего тура. Проверьте результаты текущего');
    commit({ ...state, rounds: [...state.rounds, matches] });
    return;
  }
  const matches = resolveMatches(event, state);
  const match = matches.find(item => item.id === body.match);
  if (!match || match.teams.some(team => !team)) throw error(409, 'Обе команды должны определиться');
  if (body.action === 'start') {
    if (match.winner) throw error(409, 'Матч уже завершён');
    if (state.active === match.id) return;
    commit({ ...state, active: match.id });
    game = null;
    return;
  }
  if (body.action !== 'result') throw error(400, 'Неизвестное действие');
  const score = body.score;
  const target = (match.bestOf + 1) / 2;
  if (!Array.isArray(score) || score.length !== 2 ||
      score.some(n => !Number.isInteger(n) || n < 0 || n > target) ||
      Math.max(...score) !== target || score[0] === score[1]) {
    throw error(400, `Для BO${match.bestOf} победителю нужно ${target} карт(ы)`);
  }
  const changedWinner = match.winner && match.winner.id !== match.teams[Number(score[1] > score[0])].id;
  if (changedWinner && match.id.startsWith('G')) {
    const isCurrentRound = match.id.startsWith(`G${state.rounds.length}.`);
    const playoffStarted = matches.some(match => /^[SF]/.test(match.id) && (match.id === state.active || match.winner));
    if (!isCurrentRound || playoffStarted) throw error(409, 'На этот результат уже опирается следующий этап');
  }
  if (changedWinner && matches.some(next => next.slots.includes(match.id) &&
      (next.id === state.active || next.winner))) {
    throw error(409, 'Победитель уже участвует в следующем матче');
  }
  const wasActive = state.active === match.id;
  commit({ ...state, results: { ...state.results, [match.id]: score }, active: wasActive ? null : state.active });
  if (wasActive) game = null;
}

const publicFiles = new Map([
  ['/', 'index.html'], ['/obs', 'obs.html'], ['/control', 'control.html'],
  ...['index.html', 'obs.html', 'control.html', 'event.json', 'style.css', 'obs.css', 'art.svg',
    'app.mjs', 'model.mjs', 'obs.mjs', 'control.mjs'].map(file => [`/${file}`, file]),
]);
const mime = { html: 'text/html', css: 'text/css', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml' };

async function handle(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/api/state') return json(res, 200, publicState());
    if (req.method === 'POST' && path === '/api/gsi') {
      receiveGame(await readBody(req));
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && path === '/api/control') {
      if (!equalKey(req.headers.authorization, `Bearer ${keys.admin}`)) throw error(401, 'Неверный ключ организатора');
      updateMatch(await readBody(req));
      return json(res, 200, publicState());
    }
    const file = req.method === 'GET' && publicFiles.get(path);
    if (!file) throw error(404, 'Страница не найдена');
    const content = readFileSync(join(dist, file));
    res.writeHead(200, { 'Content-Type': `${mime[file.split('.').at(-1)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
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
