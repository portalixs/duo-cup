import { emptyState, nextRound, readEvent, recordedSeriesScore, resolveMatches, safe, stageName } from './model.mjs';

const el = id => document.getElementById(id);
const local = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
const matchTags = match => match.teams.map(team => team.tag).join(' — ');
const stage = match => /^S[12]$/.test(match.id) ? `Полуфинал ${match.id.slice(1)}` : stageName(match.id);
const mapName = id => id === 'de_dust2' ? 'Dust II' : id.replace(/^(de|cs)_/, '').split('_').filter(Boolean)
  .map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
const mapPool = ['de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke',
  'de_overpass', 'de_train', 'de_vertigo'];

let event;
let session = null;
let state = emptyState;
let matches = [];
let selectedId = '';
let filter = 'current';
let overviewMatch = null;
let renderedMatch = null;
let broadcastSignature = '';
let busy = false;
let online = false;
let streamEdited = false;
const resultDrafts = new Map();
const broadcastDrafts = new Map();

function seriesScore(match) {
  return recordedSeriesScore(match, state.broadcast?.[match.id]);
}

function clearMatchDrafts() {
  selectedId = '';
  filter = 'current';
  renderedMatch = null;
  broadcastSignature = '';
  resultDrafts.clear();
  broadcastDrafts.clear();
  el('manual-result').open = false;
}

function openingDay(match) {
  const deferred = event.qualifierSchedule?.deferredOpeningPair;
  if (!match.id.startsWith('G1.') || deferred?.length !== 2) return null;
  return deferred.every(id => match.slots.includes(id)) ? 2 : 1;
}

function matchCaption(match) {
  const day = openingDay(match);
  return `${stage(match)} · BO${match.bestOf}${day === 1 ? ' · День 1' : day === 2 ? ' · Сыграют позже' : ''}`;
}

function statusFor(match, active) {
  if (match.winner) return ['Завершён', 'done'];
  if (match.id === active) return ['В эфире', 'live'];
  return [openingDay(match) === 2 ? 'Перенесён' : 'Ожидает результата', 'waiting'];
}

function showMessage(id, text, error = false) {
  const notice = el(id);
  notice.hidden = !text;
  notice.textContent = text;
  notice.classList.toggle('error', error);
}

function setMarkup(node, markup) {
  if (node.rendered === markup) return;
  node.innerHTML = markup;
  node.rendered = markup;
}

function currentMatches() {
  const playoffs = matches.filter(match => /^[SF]/.test(match.id));
  return playoffs.length ? playoffs : matches.filter(match => match.id.startsWith(`G${state.rounds.length}.`));
}

function filteredMatches() {
  if (filter === 'all') return [...matches].reverse();
  if (filter === 'playoff') return matches.filter(match => /^[SF]/.test(match.id));
  return currentMatches();
}

function selectVisibleMatch() {
  const visible = filteredMatches();
  if (visible.some(match => match.id === selectedId)) return;
  selectedId = (visible.find(match => match.id === state.active) ?? visible.find(match => !match.winner) ?? visible[0])?.id ?? '';
}

function renderOverview() {
  const current = currentMatches();
  const live = matches.find(match => match.id === state.active);
  const canAdvance = state.started && nextRound(event, state).length > 0;
  const final = current.find(match => match.id === 'F1');
  const pending = current.filter(match => !match.winner);
  const playoff = current.some(match => /^[SF]/.test(match.id));
  const completed = current.length - pending.length;
  const waitingForDeferred = !live && pending.length === 1 && openingDay(pending[0]) === 2;
  const phase = !state.started ? 'До старта' : playoff ? 'Плей-офф' : `Отбор · Тур ${state.rounds.length}`;
  const progress = current.length ? `Подтверждено результатов: ${completed} из ${current.length}.` : '';
  overviewMatch = live ?? pending.find(match => openingDay(match) !== 2) ?? pending[0] ?? null;
  el('overview-stage').textContent = phase;
  el('overview-title').textContent = !state.started ? 'Откройте первый тур'
    : final?.winner ? `Победили ${final.winner.players.join(' и ')}`
      : canAdvance ? 'Можно открыть следующий тур' : live ? 'Матч выбран для эфира'
        : waitingForDeferred ? 'Остался перенесённый матч' : 'Матчи текущего этапа';
  el('overview-detail').textContent = !state.started ? 'На сайте появятся пары первого тура.'
    : waitingForDeferred ? `${matchTags(pending[0])} сыграют позже. После подтверждения результата можно открыть второй тур.` : progress;
  el('live-summary').hidden = !live;
  el('live-summary').textContent = live ? `${matchTags(live)} · ${seriesScore(live).join(' : ')}` : '';
  el('event').hidden = state.started;
  el('round').hidden = !canAdvance;
  el('open-next').hidden = !state.started || canAdvance || !overviewMatch;
  el('open-next').textContent = live ? 'Открыть матч в эфире' : waitingForDeferred ? 'Открыть перенесённый матч' : 'Открыть следующий матч';
  for (const id of ['event', 'round']) el(id).disabled = !online || busy;
}

function matchRow(match) {
  const [status, tone] = statusFor(match, state.active);
  const showScore = match.score || match.id === state.active || state.broadcast?.[match.id]?.mapResults?.length;
  const score = showScore ? seriesScore(match).join(' : ') : '—';
  return `<button class="admin-match-option" type="button" data-match="${safe(match.id)}" aria-pressed="${match.id === selectedId}">
    <span class="admin-match-option-meta">${safe(matchCaption(match))}</span>
    <strong class="admin-match-option-title">${safe(matchTags(match))}</strong>
    <span class="admin-pill" data-tone="${tone}">${status}</span>
    <span class="admin-match-option-score" aria-label="${showScore ? `Счёт ${score}` : 'Счёт ещё не введён'}">${score}</span>
  </button>`;
}

function renderQueue() {
  const list = el('match-list');
  const filtered = filteredMatches();
  const focused = document.activeElement?.dataset.match;
  for (const button of document.querySelectorAll('.admin-filter')) {
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  }
  el('match-count').textContent = filtered.length ? `${filtered.filter(match => match.winner).length} из ${filtered.length} завершено` : '';
  const empty = !state.started ? 'Матчи появятся после старта турнира.'
    : filter === 'playoff' ? 'Участники плей-офф определятся после отбора.' : 'Нет матчей на этом этапе.';
  setMarkup(list, filtered.length ? filtered.map(matchRow).join('') : `<p class="admin-empty">${empty}</p>`);
  if (focused && document.activeElement === document.body) {
    [...list.querySelectorAll('button')].find(button => button.dataset.match === focused)?.focus({ preventScroll: true });
  }
}

function renderResult(match, changed) {
  const target = (match.bestOf + 1) / 2;
  const saved = state.broadcast?.[match.id];
  const score = resultDrafts.get(match.id) ?? match.score ?? (saved?.mapResults?.length ? seriesScore(match) : ['', '']);
  const name = match.teams.map(team => team.tag);
  const disabled = !online || busy;
  el('first').textContent = name[0];
  el('second').textContent = name[1];
  el('manual-result-title').textContent = match.score ? 'Исправить итог серии' : 'Ввести итог серии вручную';
  el('score-note').textContent = `Укажите итоговый счёт по картам. Победителю нужно ${target}.`;
  for (const [i, id] of ['left', 'right'].entries()) {
    const input = el(id);
    input.max = target;
    input.disabled = busy;
    if (changed || input.value !== String(score[i])) input.value = score[i];
  }
  const complete = score.every(value => value !== '' && Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= target)
    && Math.max(...score.map(Number)) === target && Number(score[0]) !== Number(score[1]);
  el('save').textContent = 'Сохранить итог';
  el('save').disabled = disabled || !complete;
}

function renderMapList(match, saved, draft) {
  const list = el('broadcast-maps');
  const maps = draft?.maps ?? saved?.maps ?? [];
  const liveMap = match.id === state.active ? state.game?.mapId : null;
  const customMaps = [liveMap, ...(saved?.maps ?? []), ...maps].filter(id => /^(de|cs)_[a-z0-9_]{1,48}$/.test(id ?? ''));
  const catalog = new Set([...mapPool, ...customMaps]);

  setMarkup(list, Array.from({ length: match.bestOf }, (_, index) =>
    `<label class="admin-field">Карта ${index + 1}<select aria-describedby="maps-note"></select></label>`).join(''));
  for (const [index, select] of [...list.querySelectorAll('select')].entries()) {
    const selected = maps[index] ?? '';
    const used = new Set(maps.filter((_, position) => position !== index));
    setMarkup(select, '<option value="">Не выбрана</option>' + [...catalog].map(id =>
      `<option value="${safe(id)}"${used.has(id) ? ' disabled' : ''}>${safe(mapName(id))}</option>`).join(''));
    if (select.value !== selected) select.value = selected;
    select.disabled = busy || index < (saved?.mapResults?.length ?? 0);
  }
  el('maps-note').textContent = 'Выберите карты в порядке игры.';
}

function renderBroadcast(match, changed) {
  const saved = state.broadcast?.[match.id];
  const draft = broadcastDrafts.get(match.id);
  const signature = JSON.stringify([saved?.maps, saved?.ctTeam, match.teams.map(team => team.id)]);
  if (changed || (signature !== broadcastSignature && !draft)) {
    const ctTeam = draft?.ctTeam ?? saved?.ctTeam ?? '';
    el('broadcast-ct').replaceChildren(new Option('Выберите команду', ''),
      ...match.teams.map(team => new Option(`${team.tag} · ${team.players.join(' / ')}`, team.id)));
    el('broadcast-ct').value = ctTeam;
  }
  broadcastSignature = signature;
  renderMapList(match, saved, draft);
  const detected = match.id === state.active && match.teams.find(team => team.id === state.game?.ctTeam);
  el('sides-note').textContent = detected ? `Сейчас за CT играет ${detected.tag}.` : 'Укажите, кто начинает за CT.';
  el('broadcast-ct').disabled = busy;
  const ready = selectedMaps().every(Boolean) && match.teams.some(team => team.id === el('broadcast-ct').value);
  el('start').disabled = !online || busy || !ready;
  el('broadcast-save').disabled = !online || busy || !ready;
}

function renderSeries(match, saved, isLive) {
  const results = saved?.mapResults ?? [];
  const maps = saved?.maps ?? [];
  const index = results.length;
  const current = maps[index];
  const canScore = Boolean(isLive && !match.score && maps.length === match.bestOf && current && saved?.ctTeam);
  const detected = current && saved?.mapWinners?.[current];
  const suggested = match.teams.find(team => team.id === detected);
  const mapList = el('series-maps');
  mapList.hidden = !maps.length;
  setMarkup(mapList, maps.map((map, position) => {
    const winner = match.teams.find(team => team.id === results[position]?.winner);
    const playing = Boolean(canScore && position === index);
    return `<li${playing ? ' aria-current="step"' : ''}><span>${safe(mapName(map))}</span>${winner ? `<strong>${safe(winner.tag)}</strong>` : ''}</li>`;
  }).join(''));
  el('map-result').hidden = !isLive;
  el('current-map').textContent = canScore ? `Карта ${index + 1} · ${mapName(current)}` : 'Сохраните карты и сторону CT, чтобы отмечать победителей.';
  const note = el('map-result-note');
  note.hidden = !canScore || !suggested;
  note.textContent = suggested ? `CS2 сообщает о победе ${suggested.tag}.` : '';
  const buttons = el('map-winner-buttons');
  buttons.hidden = !canScore;
  setMarkup(buttons, match.teams.map(team => `<button type="button" class="admin-btn is-primary" data-map-winner="${safe(team.id)}" data-map-index="${index}">Победа ${safe(team.tag)}</button>`).join(''));
  for (const button of buttons.querySelectorAll('button')) button.disabled = !online || busy;
  el('map-undo').hidden = !isLive || !results.length || Boolean(match.score);
  el('map-undo').disabled = !online || busy;
}

function renderDetail() {
  const match = matches.find(item => item.id === selectedId);
  const workspace = document.querySelector('.admin-workspace');
  workspace.classList.toggle('has-selected-match', Boolean(match));
  el('detail-content').hidden = !match;
  el('detail-empty').hidden = Boolean(match);
  el('detail-stage').hidden = !match;
  el('detail-status').hidden = !match;
  el('detail-title').textContent = match ? matchTags(match) : 'Матч';
  if (!match) {
    el('detail-empty').textContent = state.started ? 'Выберите матч из списка.' : 'Начните турнир, чтобы получить пары первого тура.';
    renderedMatch = null;
    return;
  }

  const changed = renderedMatch !== match.id;
  renderedMatch = match.id;
  const isLive = match.id === state.active;
  const saved = state.broadcast?.[match.id];
  const needsSetup = saved?.maps?.length !== match.bestOf || !saved?.ctTeam;
  if (changed) {
    el('settings').open = !match.winner && (!isLive || needsSetup);
    el('manual-result').open = false;
  }
  const [status, tone] = statusFor(match, state.active);
  el('detail-stage').textContent = matchCaption(match);
  el('detail-status').textContent = status;
  el('detail-status').dataset.tone = tone;
  const score = seriesScore(match);
  setMarkup(el('detail-teams'), `<div class="admin-team admin-team-left">
    <span class="admin-team-mark" style="--team:${safe(match.teams[0].color)}">${safe(match.teams[0].tag)}</span>
    <span>${safe(match.teams[0].players.join(' / '))}</span></div>
    <div class="admin-series-score"><strong aria-label="Счёт по картам ${score.join(' : ')}">${score.join(' : ')}</strong><span>Карты</span></div>
    <div class="admin-team admin-team-right">
    <span class="admin-team-mark" style="--team:${safe(match.teams[1].color)}">${safe(match.teams[1].tag)}</span>
    <span>${safe(match.teams[1].players.join(' / '))}</span></div>`);

  const onAir = matches.find(item => item.id === state.active);
  el('broadcast-note').textContent = isLive ? 'Матч выбран для оверлея.'
    : onAir ? `Сейчас в эфире ${matchTags(onAir)}.` : 'Выберите карты и сторону CT перед эфиром.';
  el('start').hidden = isLive || Boolean(match.winner);
  el('start').textContent = onAir && !isLive ? 'Переключить эфир' : 'Вывести в эфир';
  el('broadcast-save').hidden = !isLive || Boolean(match.winner);
  el('settings').hidden = Boolean(match.winner);
  el('pause').hidden = !isLive;
  el('pause').disabled = !online || busy;
  el('match-reset').hidden = !match.score && !saved?.mapResults?.length && !isLive;
  el('match-reset').disabled = !online || busy;
  renderSeries(match, saved, isLive);
  renderResult(match, changed);
  renderBroadcast(match, changed);
}

const gamePhases = new Map([
  ['warmup', 'Разминка'], ['freezetime', 'Закуп'], ['live', 'Идёт раунд'], ['bomb', 'Бомба заложена'],
  ['defuse', 'Обезвреживание'], ['over', 'Раунд завершён'], ['halftime', 'Смена сторон'],
  ['intermission', 'Смена сторон'], ['paused', 'Пауза'], ['timeout_ct', 'Тайм-аут CT'],
  ['timeout_t', 'Тайм-аут T'], ['gameover', 'Карта завершена'],
]);

function renderGame() {
  const game = state.game;
  const finished = game?.phase === 'gameover';
  const status = el('game-status');
  const unavailable = !online ? 'Связь с панелью потеряна'
    : !state.service ? 'ПК наблюдателя не на связи'
      : !state.gsi ? 'Нет данных из CS2' : '';
  status.dataset.tone = finished ? 'done' : unavailable ? 'offline' : game ? 'live' : 'waiting';
  status.textContent = finished ? 'Карта завершена' : unavailable || gamePhases.get(game?.phase) || (game ? 'Данные поступают' : 'Ожидаем карту');
  el('game-summary').hidden = !game;

  const note = el('game-note');
  if (!game) {
    note.hidden = false;
    note.textContent = unavailable ? 'Счёт появится, когда ПК наблюдателя передаст данные текущей игры.'
      : 'CS2 подключена. Данные появятся после входа в матч.';
    return;
  }

  const linked = game.matchId && matches.find(match => match.id === game.matchId);
  const ctTeam = linked && linked.teams.find(team => team.id === game.ctTeam);
  const tTeam = ctTeam && linked.teams.find(team => team.id !== ctTeam.id);
  const hasScore = Number.isSafeInteger(game.ct) && Number.isSafeInteger(game.t);
  const roundsPlayed = hasScore ? game.ct + game.t : null;
  const round = game.round ?? (hasScore && game.phase ? Math.max(1, roundsPlayed + Number(!['gameover', 'over', 'halftime', 'intermission'].includes(game.phase))) : null);
  el('game-map').textContent = game.map || (game.mapId ? mapName(game.mapId) : '—');
  el('game-round').textContent = round && game.phase !== 'warmup' ? round : '—';
  el('game-score-label').textContent = finished ? 'Итог карты' : 'Счёт по раундам';
  el('game-score').textContent = hasScore ? `${ctTeam?.tag ?? 'CT'} ${game.ct} : ${game.t} ${tTeam?.tag ?? 'T'}` : '—';
  el('game-match').textContent = linked ? matchTags(linked) : 'Без привязки';

  const pairingNote = !linked ? 'Чтобы привязать игру, выберите матч и нажмите «Вывести в эфир».'
    : !ctTeam ? 'Стороны команд не определены. Укажите команду за CT в настройках матча.' : '';
  const resultNote = finished && !linked?.score ? 'Отметьте победителя карты в карточке матча.' : '';
  note.textContent = unavailable ? 'Показаны последние полученные данные.' : pairingNote || resultNote;
  note.hidden = !note.textContent;
}

function render(next) {
  if (state.started && !next.started) {
    clearMatchDrafts();
    streamEdited = false;
    showMessage('toast', 'Турнир сброшен');
  }
  state = next;
  matches = resolveMatches(event, state).filter(match => match.teams.every(Boolean));
  if (selectedId && selectedId === state.active && !filteredMatches().some(match => match.id === selectedId)) filter = 'all';
  selectVisibleMatch();
  const connection = el('service');
  const connected = online && state.gsi;
  connection.dataset.tone = connected ? 'live' : online ? 'waiting' : 'offline';
  const label = !online ? 'Восстанавливаем связь'
    : connected ? 'CS2 подключена' : state.service ? 'Ожидаем данные CS2' : 'ПК наблюдателя не на связи';
  if (connection.textContent !== label) connection.textContent = label;
  if (!streamEdited) el('stream').value = state.streamUrl || '';
  el('stream').disabled = busy;
  el('stream-save').disabled = !online || busy;
  el('tournament-reset').disabled = !online || busy;
  renderOverview();
  renderGame();
  renderQueue();
  renderDetail();
}

function selectMatch(id, reveal = false) {
  if (!matches.some(match => match.id === id)) return;
  selectedId = id;
  if (reveal && !filteredMatches().some(match => match.id === id)) filter = 'all';
  renderQueue();
  renderDetail();
  if (reveal || matchMedia('(max-width: 760px)').matches) el('detail-title').focus();
}

async function requestControl(key, payload) {
  const response = await fetch('/api/control', {
    method: payload ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
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
  clearMatchDrafts();
  busy = false;
  online = false;
  streamEdited = false;
  el('stream').value = '';
  el('key').value = '';
  el('session-controls').hidden = true;
  el('admin-panel').hidden = true;
  el('login-panel').hidden = false;
  showMessage('login-status', text, error);
  el('key').focus();
}

async function refresh(activeSession) {
  if (session !== activeSession) return;
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
    if ([401, 403].includes(error.status)) logout('Доступ завершён. Войдите снова.', true);
    else if (online) { online = false; render(state); }
  } finally {
    if (session === activeSession) activeSession.timer = setTimeout(() => refresh(activeSession), document.hidden ? 4000 : 1800);
  }
}

async function send(payload, success) {
  if (busy || !online || !session) return;
  const activeSession = session;
  activeSession.change++;
  busy = true;
  showMessage('toast', 'Сохраняем…');
  render(state);
  try {
    const data = await requestControl(activeSession.key, payload);
    if (session !== activeSession) return;
    if (payload.action === 'stream') streamEdited = false;
    if (payload.action === 'broadcast' || payload.action === 'start') {
      broadcastDrafts.delete(payload.match);
      broadcastSignature = '';
      if (payload.action === 'start') el('settings').open = false;
    }
    if (payload.action === 'result') resultDrafts.delete(payload.match);
    if (payload.action === 'map-result' || payload.action === 'map-undo') resultDrafts.delete(payload.match);
    if (payload.action === 'match-reset') {
      clearMatchDrafts();
      selectedId = payload.match;
      filter = 'all';
      el('settings').open = true;
    }
    if (payload.action === 'reset') {
      clearMatchDrafts();
      streamEdited = false;
      el('tournament-reset').closest('details').open = false;
    }
    if (payload.action === 'round') {
      filter = 'current';
      selectedId = data.rounds.at(-1)?.[0]?.id ?? '';
    }
    const seriesEnded = payload.action === 'map-result' && data.results[payload.match];
    state = data;
    showMessage('toast', seriesEnded ? 'Серия завершена. Итог опубликован.' : success);
  } catch (error) {
    if (session !== activeSession) return;
    if ([401, 403].includes(error.status)) logout('Доступ завершён. Войдите снова.', true);
    else showMessage('toast', error.message, true);
  } finally {
    if (session === activeSession) { busy = false; render(state); }
  }
}

function updateScoreDraft() {
  resultDrafts.set(selectedId, [el('left').value, el('right').value]);
  const match = matches.find(item => item.id === selectedId);
  if (match) renderResult(match, false);
}

function selectedMaps() {
  return [...el('broadcast-maps').querySelectorAll('select')].map(select => select.value);
}

function updateBroadcastDraft() {
  broadcastDrafts.set(selectedId, { maps: selectedMaps(), ctTeam: el('broadcast-ct').value });
}

el('overlay-link').hidden = !local;
try {
  event = await readEvent();
  el('login-button').disabled = false;
} catch {
  showMessage('login-status', 'Данные турнира недоступны. Обновите страницу.', true);
}

el('login').addEventListener('submit', async submit => {
  submit.preventDefault();
  const key = el('key').value.trim();
  if (!key || el('login-button').disabled) return;
  el('login-button').disabled = true;
  showMessage('login-status', 'Проверяем ключ…');
  try {
    const next = await requestControl(key);
    const activeSession = { key, change: 0, timer: null };
    session = activeSession;
    online = true;
    el('key').value = '';
    showMessage('login-status', '');
    showMessage('toast', '');
    el('login-panel').hidden = true;
    el('admin-panel').hidden = false;
    el('session-controls').hidden = false;
    if (next.active) {
      selectedId = next.active;
      const currentRound = `G${next.rounds.length}.`;
      if (selectedId.startsWith('G') && !selectedId.startsWith(currentRound)) filter = 'all';
    }
    render(next);
    activeSession.timer = setTimeout(() => refresh(activeSession), 1800);
    el('admin-title').focus();
  } catch (error) {
    showMessage('login-status', [401, 403].includes(error.status) ? 'Неверный ключ организатора.' : 'Панель временно недоступна. Попробуйте снова.', true);
  } finally { el('login-button').disabled = false; }
});
el('logout').addEventListener('click', () => logout());
el('event').addEventListener('click', () => send({ action: 'event' }, 'Турнир начат. Пары первого тура опубликованы.'));
el('round').addEventListener('click', () => send({ action: 'round', round: state.rounds.length }, 'Следующий тур опубликован.'));
el('open-next').addEventListener('click', () => selectMatch(overviewMatch?.id, true));
el('pause').addEventListener('click', () => {
  if (selectedId === state.active) send({ action: 'pause' }, 'Матч убран из эфира.');
});
el('match-list').addEventListener('click', e => {
  const button = e.target.closest('button[data-match]');
  if (button) selectMatch(button.dataset.match);
});
for (const button of document.querySelectorAll('.admin-filter')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    selectVisibleMatch();
    renderQueue();
    renderDetail();
  });
}
el('map-winner-buttons').addEventListener('click', e => {
  const choice = e.target.closest('button[data-map-winner]')?.dataset;
  if (!choice || e.detail > 1 || selectedId !== state.active) return;
  const saved = state.broadcast?.[selectedId];
  const expectedIndex = saved?.mapResults?.length ?? 0;
  const mapId = saved?.maps?.[expectedIndex];
  if (!mapId || Number(choice.mapIndex) !== expectedIndex) return;
  send({ action: 'map-result', match: selectedId, mapId, winner: choice.mapWinner, expectedIndex, expectedRevision: saved?.mapRevision ?? 0 }, 'Победитель карты записан.');
});
el('map-undo').addEventListener('click', () => {
  const saved = state.broadcast?.[selectedId];
  const expectedIndex = saved?.mapResults?.length ?? 0;
  if (selectedId !== state.active || !expectedIndex || !window.confirm('Отменить результат последней карты?')) return;
  send({ action: 'map-undo', match: selectedId, expectedIndex, expectedRevision: saved?.mapRevision ?? 0 }, 'Результат карты отменён.');
});
el('match-reset').addEventListener('click', () => {
  const match = matches.find(item => item.id === selectedId);
  if (!match) return;
  const affected = match.id.startsWith('G') ? ' Связанные следующие туры и плей-офф тоже будут сброшены.'
    : match.id.startsWith('S') ? ' Итог финала тоже будет сброшен.' : '';
  if (window.confirm(`Сбросить счёт матча ${matchTags(match)}?${affected}`)) {
    send({ action: 'match-reset', match: match.id, confirm: true }, 'Матч сброшен. Его можно сыграть заново.');
  }
});
el('tournament-reset').addEventListener('click', () => {
  if (window.confirm('Сбросить весь турнир? Результаты, туры и настройки эфира будут удалены.')) {
    send({ action: 'reset', confirm: true }, 'Турнир сброшен.');
  }
});
for (const id of ['left', 'right']) el(id).addEventListener('input', updateScoreDraft);
el('stream').addEventListener('input', () => { streamEdited = true; });
el('broadcast-maps').addEventListener('change', () => {
  const match = matches.find(item => item.id === selectedId);
  if (!match) return;
  updateBroadcastDraft();
  renderBroadcast(match, false);
});
el('broadcast-ct').addEventListener('change', () => {
  const match = matches.find(item => item.id === selectedId);
  if (!match) return;
  updateBroadcastDraft();
  renderBroadcast(match, false);
});
el('stream-form').addEventListener('submit', e => {
  e.preventDefault();
  send({ action: 'stream', url: el('stream').value.trim() }, 'Ссылка на Twitch сохранена.');
});
el('broadcast-settings').addEventListener('submit', e => {
  e.preventDefault();
  const match = matches.find(item => item.id === selectedId);
  const maps = selectedMaps();
  const ctTeam = el('broadcast-ct').value;
  if (!match || !maps.every(Boolean) || !ctTeam) return;
  const isLive = match.id === state.active;
  send({ action: isLive ? 'broadcast' : 'start', match: match.id, maps, ctTeam },
    isLive ? 'Карты и сторона CT сохранены.' : 'Матч в эфире.');
});
el('result').addEventListener('submit', e => {
  e.preventDefault();
  const match = matches.find(item => item.id === selectedId);
  if (!match) return;
  const score = [el('left').valueAsNumber, el('right').valueAsNumber];
  if (Math.max(...score) !== (match.bestOf + 1) / 2 || score[0] === score[1]) {
    showMessage('toast', match.bestOf === 1 ? 'Укажите победителя со счётом 1 : 0 или 0 : 1.' : 'Проверьте число выигранных карт у победителя.', true);
    return;
  }
  send({ action: 'result', match: selectedId, score }, 'Результат опубликован.');
});
