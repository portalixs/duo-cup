import { emptyState, nextRound, readEvent, resolveMatches, stageName, watchState } from './model.mjs';

const el = id => document.getElementById(id);
const event = await readEvent();
let state = emptyState;
let matches = [];
let busy = false;
let online = false;
let streamEdited = false;
el('key').value = sessionStorage.getItem('duocup.admin') || '';
el('key').addEventListener('input', () => sessionStorage.setItem('duocup.admin', el('key').value.trim()));
el('stream').addEventListener('input', () => { streamEdited = true; });

function updateMatchFields() {
  const match = matches.find(item => item.id === el('match').value);
  el('start').disabled = !online || busy || !match || !!match.winner || match.id === state.active;
  el('save').disabled = !online || busy || !match;
  el('first').textContent = match?.teams[0].tag ?? 'Первая команда';
  el('second').textContent = match?.teams[1].tag ?? 'Вторая команда';
  el('score-note').textContent = match ? `BO${match.bestOf}. Введите выигранные карты, до ${(match.bestOf + 1) / 2}.` : 'Выберите матч.';
  el('left').value = match?.score?.[0] ?? '';
  el('right').value = match?.score?.[1] ?? '';
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
  el('service').textContent = online
    ? `CS2 GSI ${state.gsi ? 'подключён' : 'ожидается'} · ${state.publishStatus ?? ''}`
    : 'Связь с локальным сервисом потеряна.';
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

async function send(payload) {
  if (busy) return;
  const key = el('key').value.trim();
  if (!key) { message('Вставьте ключ организатора.', true); el('key').focus(); return; }
  busy = true;
  render(state);
  try {
    const response = await fetch('/api/control', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (payload.action === 'stream') streamEdited = false;
    state = data;
    message('Сохранено');
  } catch (cause) { message(cause.message, true); }
  finally { busy = false; render(state); }
}

el('match').addEventListener('change', updateMatchFields);
el('event').addEventListener('click', () => send({ action: 'event' }));
el('round').addEventListener('click', () => send({ action: 'round', round: state.rounds.length }));
el('start').addEventListener('click', () => send({ action: 'start', match: el('match').value }));
el('pause').addEventListener('click', () => send({ action: 'pause' }));
el('stream-form').addEventListener('submit', e => { e.preventDefault(); send({ action: 'stream', url: el('stream').value.trim() }); });
el('result').addEventListener('submit', e => {
  e.preventDefault();
  send({ action: 'result', match: el('match').value, score: [el('left').valueAsNumber, el('right').valueAsNumber] });
});

watchState(next => { online = true; render(next); }, failed => {
  if (online === !failed) return;
  online = !failed;
  render(state);
});
