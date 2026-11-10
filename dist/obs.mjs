import { emptyState, readEvent, resolveMatches, stageName, watchState } from './model.mjs';

const el = id => document.getElementById(id);
const standby = new URLSearchParams(location.search).get('scene') === 'standby';
el('standby').hidden = !standby;
el('match-graphic').hidden = standby;
const event = await readEvent();

function render(state) {
  const matches = resolveMatches(event, state);
  const match = matches.find(match => match.id === state.active);
  const final = matches.find(match => match.id === 'F1');
  if (standby) {
    el('standby-message').textContent = final.winner ? 'Турнир завершён' : state.started ? 'Перерыв в эфире' : 'Скоро начнём';
    el('standby-detail').textContent = final.winner ? `Победители · ${final.winner.players.join(' и ')}`
      : match ? `${stageName(match.id)} · ${match.teams.map(team => team.tag).join(' vs ')}` : state.started ? 'Следите за сеткой турнира' : event.dateLabel;
    return;
  }
  el('duel').hidden = !match;
  el('stage').textContent = match ? `${stageName(match.id)} · BO${match.bestOf}` : 'CS2 / 2×2';
  if (match) {
    for (const [i, id] of ['team-left', 'team-right'].entries()) {
      el(id).textContent = match.teams[i].tag;
      el(id).style.color = match.teams[i].color;
    }
  }
  const game = match && state.game;
  el('round-score').hidden = !game;
  if (game) {
    el('map').textContent = game.phase === 'warmup' ? `${game.map} · Разминка` : game.map;
    el('ct').textContent = `CT ${game.ct}`;
    el('t').textContent = `T ${game.t}`;
  }
}

render(emptyState);
watchState(render, failed => { if (failed) el('round-score').hidden = true; });
