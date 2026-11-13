import { emptyState, nextRound, readEvent, resolveMatches, stageName } from './model.mjs';

const el = id => document.getElementById(id);
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
el('overlay-link').hidden = !local;
let event;
try { event = await readEvent(); }
catch {
  el('login-status').textContent = 'Данные турнира недоступны. Обновите страницу.';
  el('login-status').classList.add('error');
  throw new Error('Не удалось загрузить данные турнира');
}
let session = null;
let state = emptyState;
let matches = [];
let busy = false;
let online = false;
let streamEdited = false;
let broadcastMatch;
let broadcastSignature = '';
let broadcastEdited = false;
el('stream').addEventListener('input', () => { streamEdited = true; });
el('broadcast-maps').addEventListener('input', () => { broadcastEdited = true; });
el('broadcast-ct').addEventListener('change', () => { broadcastEdited = true; });

function updateBroadcast(match) {
  const saved = state.broadcast?.[match?.id];
  const ctTeam = (match && match.id === state.active ? state.game?.ctTeam : null) ?? saved?.ctTeam ?? '';
  const signature = JSON.stringify([saved, ctTeam]);
  const selectedMatchChanged = match?.id !== broadcastMatch;
  if (selectedMatchChanged) broadcastEdited = false;
  if (selectedMatchChanged || (!broadcastEdited && signature !== broadcastSignature)) {
    broadcastMatch = match?.id;
    broadcastSignature = signature;
    el('broadcast-maps').value = (saved?.maps ?? []).join(', ');
    el('broadcast-ct').replaceChildren(new Option('По игровым никам', ''),
      ...(match?.teams ?? []).map(team => new Option(`${team.tag} · ${team.players.join(' / ')}`, team.id)));
    el('broadcast-ct').value = ctTeam;
  }
  const disabled = !online || busy || !match;
  el('broadcast-maps').disabled = disabled;
  el('broadcast-ct').disabled = disabled;
  el('broadcast-save').disabled = disabled;
}

function updateMatchFields() {
  const match = matches.find(item => item.id === el('match').value);
  el('start').disabled = !online || busy || !match || !!match.winner || match.id === state.active;
  el('save').disabled = !online || busy || !match;
  el('first').textContent = match?.teams[0].tag ?? 'Первая команда';
  el('second').textContent = match?.teams[1].tag ?? 'Вторая команда';
  el('score-note').textContent = match ? `BO${match.bestOf}. Введите выигранные карты, до ${(match.bestOf + 1) / 2}.` : 'Выберите матч.';
  el('left').value = match?.score?.[0] ?? '';
  el('right').value = match?.score?.[1] ?? '';
  updateBroadcast(match);
}

function render(next) {
  const matchInput = el('match');
  const selected = matchInput.value;
  const oldMatch = matches.find(match => match.id === selected);
  const keepScore = [el('left').value, el('right').value];
  state = next;
  matches = resolveMatches(event, state).filter(match => match.teams.every(Boolean));
  el('event').disabled = !online || busy || state.started;
  el('round').disabled = !online || busy || !state.started || !nextRound(event, state).length;
  el('pause').disabled = !online || busy || !state.active;
  el('stream-save').disabled = !online || busy;
  const connection = local ? `CS2 GSI ${state.gsi ? 'подключён' : 'ожидается'}` : 'Панель подключена';
  el('service').textContent = online ? [connection, state.publishStatus].filter(Boolean).join(' · ')
    : 'Связь с панелью потеряна. Восстанавливаем подключение…';
  if (!streamEdited) el('stream').value = state.streamUrl || '';
  matchInput.disabled = !online || busy || !matches.length;
  const options = matches.map(match => new Option(
    `${match.id} · ${stageName(match.id)} · ${match.teams.map(team => team.tag).join(' — ')}${match.winner ? ' ✓' : match.id === state.active ? ' · В эфире' : ''}`, match.id));
  matchInput.replaceChildren(...options);
  if (!matches.length) matchInput.add(new Option('Нет доступных матчей', ''));
  matchInput.value = matches.some(match => match.id === selected) ? selected
    : state.active || matches.find(match => !match.winner)?.id || matches[0]?.id || '';
  updateMatchFields();
  const newMatch = matches.find(match => match.id === matchInput.value);
  if (oldMatch?.id === newMatch?.id && String(oldMatch?.score) === String(newMatch?.score)) {
    [el('left').value, el('right').value] = keepScore;
  }
}

function message(text, error = false) {
  el('toast').textContent = text;
  el('toast').classList.toggle('error', error);
}

function loginMessage(text, error = false) {
  el('login-status').textContent = text;
  el('login-status').classList.toggle('error', error);
}

async function requestControl(key, payload) {
  const response = await fetch('/api/control', {
    method: payload ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${key}`,
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    body: payload ? JSON.stringify(payload) : undefined,
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || 'Панель временно недоступна. Попробуйте снова.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function logout(text = '', error = false) {
  if (session) clearTimeout(session.timer);
  session = null;
  state = emptyState;
  matches = [];
  busy = false;
  online = false;
  streamEdited = false;
  broadcastMatch = undefined;
  broadcastSignature = '';
  broadcastEdited = false;
  el('match').replaceChildren();
  el('stream').value = '';
  el('key').value = '';
  el('admin-panel').hidden = true;
  el('login-panel').hidden = false;
  loginMessage(text, error);
  el('key').focus();
}

async function refresh(activeSession) {
  if (!activeSession || session !== activeSession) return;
  const change = activeSession.change;
  try {
    if (!busy) {
      const next = await requestControl(activeSession.key);
      if (session !== activeSession || change !== activeSession.change) return;
      if (!online || JSON.stringify(next) !== JSON.stringify(state)) {
        online = true;
        render(next);
      }
    }
  } catch (error) {
    if (session !== activeSession || change !== activeSession.change) return;
    if ([401, 403].includes(error.status)) logout('Доступ администратора завершён. Войдите снова.', true);
    else if (online) { online = false; render(state); }
  } finally {
    if (session === activeSession) activeSession.timer = setTimeout(() => refresh(activeSession), document.hidden ? 4000 : 1800);
  }
}

el('login').addEventListener('submit', async event => {
  event.preventDefault();
  const key = el('key').value.trim();
  if (!key || el('login-button').disabled) return;
  el('login-button').disabled = true;
  loginMessage('Проверяем ключ…');
  try {
    const next = await requestControl(key);
    const activeSession = { key, change: 0, timer: null };
    session = activeSession;
    online = true;
    el('key').value = '';
    loginMessage('');
    message('');
    el('login-panel').hidden = true;
    el('admin-panel').hidden = false;
    render(next);
    activeSession.timer = setTimeout(() => refresh(activeSession), 1800);
    el('logout').focus();
  } catch (error) {
    loginMessage([401, 403].includes(error.status) ? 'Неверный ключ организатора.' : 'Панель временно недоступна. Попробуйте снова.', true);
  } finally { el('login-button').disabled = false; }
});
el('logout').addEventListener('click', () => logout());
el('login-button').disabled = false;

async function send(payload) {
  if (busy || !online || !session) return;
  const activeSession = session;
  activeSession.change++;
  busy = true;
  render(state);
  try {
    const data = await requestControl(activeSession.key, payload);
    if (session !== activeSession) return;
    if (payload.action === 'stream') streamEdited = false;
    if (payload.action === 'broadcast') broadcastEdited = false;
    state = data;
    message('Сохранено');
  } catch (error) {
    if (session !== activeSession) return;
    if ([401, 403].includes(error.status)) logout('Доступ администратора завершён. Войдите снова.', true);
    else message(error.message, true);
  } finally {
    if (session === activeSession) { busy = false; render(state); }
  }
}

el('match').addEventListener('change', updateMatchFields);
el('event').addEventListener('click', () => send({ action: 'event' }));
el('round').addEventListener('click', () => send({ action: 'round', round: state.rounds.length }));
el('start').addEventListener('click', () => send({ action: 'start', match: el('match').value }));
el('pause').addEventListener('click', () => send({ action: 'pause' }));
el('stream-form').addEventListener('submit', e => { e.preventDefault(); send({ action: 'stream', url: el('stream').value.trim() }); });
el('broadcast-settings').addEventListener('submit', e => {
  e.preventDefault();
  const maps = el('broadcast-maps').value.toLowerCase().split(',').map(map => map.trim()).filter(Boolean)
    .map(map => /^(de|cs)_/.test(map) ? map : `de_${map}`);
  send({ action: 'broadcast', match: el('match').value, maps, ctTeam: el('broadcast-ct').value });
});
el('result').addEventListener('submit', e => {
  e.preventDefault();
  send({ action: 'result', match: el('match').value, score: [el('left').valueAsNumber, el('right').valueAsNumber] });
});
