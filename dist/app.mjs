import { emptyState, nextRound, readEvent, recordedSeriesScore, resolveMatches, safe, slotName, stageName, standings, watchState } from './model.mjs';

const byId = id => document.getElementById(id);
const badge = team => `<span class="badge" data-team="${safe(team.id)}">${safe(team.tag)}</span>`;
const duo = team => team.players.map(safe).join(' / ');
const event = await readEvent();
const deferredPair = event.qualifierSchedule?.deferredOpeningPair;
const rendered = new Map();
let latestRound = 0;

byId('date').textContent = event.dateLabel;
byId('team-count').textContent = event.teams.length;
byId('qualifier-format').textContent = `BO${event.qualifierBestOf}`;
byId('playoff-format').textContent = `Полуфиналы BO${event.semifinalBestOf} · Финал BO${event.finalBestOf}`;
byId('qualifier-rules').hidden = event.qualifierFormat !== 'score-groups-v1';

function paint(id, markup) {
  if (rendered.get(id) === markup) return;
  byId(id).innerHTML = markup;
  rendered.set(id, markup);
}

function publicMatchScore(match, state) {
  const options = state.broadcast?.[match.id];
  return match.score ?? state.seriesScores?.[match.id] ??
    (options?.mapResults?.length ? recordedSeriesScore(match, options) : null);
}

function matchCard(match, state, label = '', scheduleNote = '') {
  const active = match.id === state.active;
  const score = publicMatchScore(match, state);
  return `<article class="match${active ? ' featured-match' : ''}">
    ${label || active || scheduleNote ? `<div class="match-meta">${label ? `<span class="match-name">${safe(label)}</span><span class="match-format">BO${match.bestOf}</span>` : ''}
      ${scheduleNote ? `<span class="match-day">${safe(scheduleNote)}</span>` : ''}${active ? '<span class="chip live">В эфире</span>' : ''}</div>` : ''}
    ${match.teams.map((team, i) => `<div class="match-line${team && match.winner?.id === team.id ? ' winner' : ''}">
      ${team ? `<span class="team">${badge(team)}<span class="players">${duo(team)}</span></span>` : `<span>${safe(match.id === 'F1' ? `Победитель полуфинала ${i + 1}` : slotName(match.slots[i]))}</span>`}
      <b aria-label="${score?.[i] == null ? 'Нет счёта' : `Выиграно карт: ${score[i]}`}">${score?.[i] ?? '–'}</b></div>`).join('')}
  </article>`;
}

function renderSchedule(state, matches) {
  const list = byId('schedule');
  const open = new Map([...list.querySelectorAll('details')].map(item => [Number(item.dataset.round), item.open]));
  const focusedRound = document.activeElement?.closest('#schedule summary')?.parentElement.dataset.round;
  const planned = !state.started && !state.rounds.length && deferredPair?.length === 2;
  const rounds = planned ? [nextRound(event, emptyState)] : state.rounds;
  if (latestRound !== rounds.length && open.get(latestRound)) open.set(latestRound, false);
  latestRound = rounds.length;

  if (!latestRound) {
    paint('schedule', '<div class="empty"><h3>Матчей пока нет</h3><p>Пары первого тура появятся после старта турнира.</p></div>');
    return;
  }

  const displayMatches = planned ? resolveMatches(event, { ...state, rounds }) : matches;
  const byMatch = new Map(displayMatches.map(match => [match.id, match]));
  const hasDeferred = deferredPair?.length === 2 && rounds[0]?.some(match => deferredPair.every(team => match.slots.includes(team)));
  const noteFor = match => {
    if (!hasDeferred || match.score || match.id === state.active || !match.id.startsWith('G1.')) return '';
    return deferredPair.every(team => match.slots.includes(team)) ? 'Позже' : 'Первый день';
  };
  const markup = rounds.map((round, i) => {
    const number = i + 1;
    const completed = round.filter(match => state.results[match.id]).length;
    const inProgress = round.some(match => match.id === state.active);
    const detail = planned ? 'Запланирован' : inProgress ? '<span class="chip live">В эфире</span>' : `${completed} из ${round.length} сыграно`;
    return `<details class="round" data-round="${number}">
      <summary><span class="round-name">Тур ${number}</span><span class="round-progress">${detail}</span><span class="chevron" aria-hidden="true"></span></summary>
      <div class="match-grid">${round.map(({ id }) => {
        const match = byMatch.get(id);
        return matchCard(match, state, '', noteFor(match));
      }).join('')}</div></details>`;
  }).reverse().join('');
  if (rendered.get('schedule') === markup) return;
  paint('schedule', markup);
  for (const item of list.querySelectorAll('details')) {
    const number = Number(item.dataset.round);
    item.open = open.get(number) ?? (number === latestRound);
    if (item.dataset.round === focusedRound) item.querySelector('summary').focus({ preventScroll: true });
  }
}

function render(state) {
  const matches = resolveMatches(event, state);
  const active = matches.find(match => match.id === state.active && match.teams.every(Boolean));
  const semis = matches.filter(match => match.id.startsWith('S'));
  const final = matches.find(match => match.id === 'F1');
  const teamStatus = row => row.wins >= 3 ? ['pass', 'Плей-офф'] : row.losses >= 3 ? ['out', 'Выбыла'] : ['', state.started ? 'В игре' : 'Ожидает'];
  paint('standings', standings(event, state).map(row => {
    const [color, label] = teamStatus(row);
    return `<tr><th scope="row"><span class="team">${badge(row)}<span class="players">${duo(row)}</span></span></th>
      <td>${row.wins}</td><td>${row.losses}</td><td><span class="chip ${color}">${label}</span></td></tr>`;
  }).join(''));

  renderSchedule(state, matches);
  paint('bracket', `<div class="semis">${semis.map((match, i) => matchCard(match, state, `Полуфинал ${i + 1}`)).join('')}</div>
    <div class="bracket-line" aria-hidden="true"></div><div class="final">${matchCard(final, state, 'Финал')}
    ${final.winner ? `<p class="champion">Чемпионы · ${final.winner.players.map(safe).join(' и ')}</p>` : ''}</div>`);

  byId('status').classList.toggle('live', state.started && !final.winner);
  paint('status', `<i></i><span>${final.winner ? 'Завершён' : state.started ? 'Идёт турнир' : 'До старта'}</span>`);
  byId('event-note').textContent = final.winner ? `Чемпионы · ${final.winner.players.join(' и ')}`
    : state.started ? (semis.every(match => match.teams.every(Boolean)) ? 'Идёт плей-офф' : 'Идёт отбор') : 'Старт по команде организатора.';

  const stream = state.streamUrl || event.streamUrl;
  const watch = byId('watch');
  watch.hidden = !stream;
  byId('twitch-label').textContent = stream ? 'Twitch' : 'Трансляция';
  byId('twitch-arrow').textContent = stream ? '↗' : '↓';
  for (const link of [byId('twitch'), watch]) {
    link.href = stream || '#broadcast';
    link.target = stream ? '_blank' : '_self';
    link.rel = 'noopener noreferrer';
  }
  byId('broadcast').classList.toggle('has-match', Boolean(active));
  const activeScore = active && publicMatchScore(active, state);
  paint('featured-info', active
    ? `<p class="broadcast-match"><strong>${duo(active.teams[0])}</strong>${activeScore ? `<b aria-label="Счёт по картам">${activeScore.join(':')}</b>` : '<span>vs</span>'}<strong>${duo(active.teams[1])}</strong></p><p class="subtle">${safe(stageName(active.id))} · BO${active.bestOf}${stream ? '' : ' · Ссылка на Twitch ещё не добавлена'}</p>`
    : `<p>${stream ? 'Эфир турнира на Twitch' : 'Ссылка на эфир появится перед началом.'}</p>`);
}

render(emptyState);
watchState(render, failed => { byId('connection').hidden = !failed; });
