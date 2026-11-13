export const emptyState = { results: {}, rounds: [], active: null, game: null, started: false, streamUrl: '' };

export function stageName(id) {
  if (id.startsWith('F')) return 'Финал';
  if (id.startsWith('S')) return 'Полуфинал';
  return `Отбор · Тур ${id.split('.')[0].slice(1)}`;
}

export function standings(event, state) {
  const rows = event.teams.map((team, seed) => ({ ...team, seed, wins: 0, losses: 0 }));
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const match of state.rounds.flat()) {
    const score = state.results[match.id];
    if (!score) continue;
    const winner = Number(score[1] > score[0]);
    byId.get(match.slots[winner]).wins++;
    byId.get(match.slots[1 - winner]).losses++;
  }
  return rows.sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.seed - b.seed);
}

export function nextRound(event, state) {
  if (state.rounds.flat().some(match => !state.results[match.id])) return [];
  const pool = standings(event, state).filter(team => team.wins < 3 && team.losses < 3);
  if (!pool.length || pool.length % 2) return [];
  const past = state.rounds.flat();
  let best = { cost: Infinity, pairs: [] };
  function pair(remaining, pairs, cost) {
    if (cost >= best.cost) return;
    if (!remaining.length) { best = { pairs, cost }; return; }
    const [first, ...others] = remaining;
    for (const [index, second] of others.entries()) {
      const rematches = past.filter(match => match.slots.includes(first.id) && match.slots.includes(second.id)).length;
      const gap = Math.abs(first.wins - second.wins);
      pair(others.filter((_, i) => i !== index), [...pairs, [first.id, second.id]], cost + rematches * 100 + gap);
    }
  }
  if (state.rounds.length) pair(pool, [], 0);
  else best.pairs = pool.slice(0, pool.length / 2).map((team, i) => [team.id, pool.at(-1 - i).id]);
  return best.pairs.map((slots, i) => ({ id: `G${state.rounds.length + 1}.${i + 1}`, slots, bestOf: event.qualifierBestOf }));
}

export function resolveMatches(event, state) {
  const teams = new Map(event.teams.map(team => [team.id, team]));
  const advancing = standings(event, state).filter(team => team.wins === 3);
  const winners = new Map();
  if (advancing.length === 4 && state.rounds.flat().every(match => state.results[match.id])) {
    advancing.forEach((team, i) => winners.set(`#${i + 1}`, teams.get(team.id)));
  }
  const playoffs = [
    { id: 'S1', slots: ['#1', '#4'], bestOf: event.semifinalBestOf },
    { id: 'S2', slots: ['#2', '#3'], bestOf: event.semifinalBestOf },
    { id: 'F1', slots: ['S1', 'S2'], bestOf: event.finalBestOf },
  ];
  return [...state.rounds.flat(), ...playoffs].map(match => {
    const slots = match.slots.map(id => teams.get(id) ?? winners.get(id) ?? null);
    const score = state.results[match.id] ?? null;
    const winner = score && slots[Number(score[1] > score[0])];
    if (winner) winners.set(match.id, winner);
    return { ...match, teams: slots, score, winner: winner || null };
  });
}

export async function readEvent() {
  const response = await fetch('/event.json');
  if (!response.ok) throw new Error('Данные турнира недоступны');
  return response.json();
}

export function watchState(render, onError = () => {}, interval = 1800) {
  let previous = '';
  async function refresh() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error('Связь потеряна');
      const state = await response.json();
      const signature = JSON.stringify(state);
      if (signature !== previous) { render(state); previous = signature; }
      onError(false);
    } catch { previous = ''; onError(true); }
    setTimeout(refresh, document.hidden ? 4000 : interval);
  }
  refresh();
}

export const safe = text => String(text ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export const slotName = slot => slot.startsWith('#') ? `Посев ${slot}` : `Победитель ${slot}`;
