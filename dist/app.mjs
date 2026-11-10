import { emptyState, readEvent, resolveMatches, safe, slotName, standings, watchState } from './model.mjs';

const byId = id => document.getElementById(id);
const badge = team => `<span class="badge" style="--team:${safe(team.color)}">${safe(team.tag)}</span>`;
const event = await readEvent();
byId('date').textContent = event.dateLabel;
byId('qualifier-format').textContent = `BO${event.qualifierBestOf}`;
byId('playoff-format').textContent = `Полуфиналы BO${event.semifinalBestOf} · Финал BO${event.finalBestOf}`;

function matchCard(match, state, label = match.id) {
  const active = match.id === state.active;
  return `<article class="match${active ? ' featured-match' : ''}">
    <div class="match-meta"><span>${safe(label)} · BO${match.bestOf}</span>${active ? '<span class="chip live">В эфире</span>' : ''}</div>
    ${match.teams.map((team, i) => `<div class="match-line${team && match.winner?.id === team.id ? ' winner' : ''}">
      <span>${team ? badge(team) : safe(slotName(match.slots[i]))}</span><b>${match.score?.[i] ?? '–'}</b></div>`).join('')}
  </article>`;
}

function render(state) {
  const matches = resolveMatches(event, state);
  const active = matches.find(match => match.id === state.active);
  const semis = matches.filter(match => match.id.startsWith('S'));
  const final = matches.find(match => match.id === 'F1');
  const teamStatus = row => row.wins >= 3 ? ['pass', 'Плей-офф'] : row.losses >= 3 ? ['out', 'Выбыла'] : ['', state.started ? 'В игре' : 'Ожидает'];
  byId('standings').innerHTML = standings(event, state).map(row => {
    const [color, label] = teamStatus(row);
    return `<tr><td><div class="team">${badge(row)}<span class="players">${row.players.map(safe).join(' / ')}</span></div></td>
      <td>${row.wins}</td><td>${row.losses}</td><td><span class="chip ${color}">${label}</span></td></tr>`;
  }).join('');

  byId('schedule').innerHTML = state.rounds.length ? state.rounds.map((round, i) => {
    const cards = round.map(({ id }) => matchCard(matches.find(match => match.id === id), state));
    return `<div class="round"><h3>Тур ${i + 1}</h3><div class="match-grid">${cards.join('')}</div></div>`;
  }).join('') : '<p class="empty">Пары первого тура появятся после старта турнира.</p>';
  byId('bracket').innerHTML = `<div class="semis">${semis.map((match, i) => matchCard(match, state, `Полуфинал ${i + 1}`)).join('')}</div>
    <div class="bracket-line" aria-hidden="true"></div><div>${matchCard(final, state, 'Финал')}
    ${final.winner ? `<p class="champion">Чемпионы · ${final.winner.players.map(safe).join(' и ')}</p>` : ''}</div>`;

  const status = byId('status');
  status.classList.toggle('live', state.started && !final.winner);
  status.innerHTML = `<i></i> ${final.winner ? 'ЗАВЕРШЁН' : state.started ? 'ИДЁТ ТУРНИР' : 'ДО СТАРТА'}`;
  byId('event-note').textContent = final.winner ? 'Турнир завершён.' : state.started ? 'Турнир начался.' : 'В пятницу. Старт по команде организатора.';

  const stream = state.streamUrl || event.streamUrl;
  const twitch = byId('twitch');
  const watch = byId('watch');
  watch.hidden = !stream;
  for (const link of [twitch, watch]) {
    link.href = stream || '#broadcast';
    link.target = stream ? '_blank' : '_self';
    link.rel = 'noopener noreferrer';
  }
  byId('featured-info').innerHTML = active
    ? `<p><strong>${active.teams.map(team => safe(team.tag)).join(' <span class="subtle">vs</span> ')}</strong></p><p class="subtle">Матч в эфире · BO${active.bestOf}</p>`
    : `<p>${stream ? 'Турнирный эфир на Twitch' : 'Эфир откроется по ссылке на Twitch.'}</p>
      <p class="subtle">${stream ? 'Текущий матч появится после выбора организатором.' : 'Организатор добавит канал перед началом.'}</p>`;
}

render(emptyState);
watchState(render, failed => { byId('connection').hidden = !failed; });
