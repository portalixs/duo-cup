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

function scoreGroupPairs(teams) {
  if (!teams.length) return [[]];
  const [first, ...others] = teams;
  return others.flatMap((second, index) =>
    scoreGroupPairs(others.filter((_, i) => i !== index)).map(rest => [[first, second], ...rest]));
}

function qualifierPairings(pool, round) {
  const group = (wins, losses) => pool.filter(team => team.wins === wins && team.losses === losses);
  if (round === 2) {
    const leaders = group(1, 0);
    const trailers = group(0, 1);
    if (leaders.length !== 4 || trailers.length !== 4) return [];
    return scoreGroupPairs(leaders).flatMap(upper => scoreGroupPairs(trailers).map(lower => [...upper, ...lower]));
  }
  if (round === 3) {
    const leaders = group(2, 0);
    const middle = group(1, 1);
    const trailers = group(0, 2);
    if (leaders.length !== 2 || middle.length !== 4 || trailers.length !== 2) return [];
    return scoreGroupPairs(middle).map(pairs => [leaders, ...pairs, trailers]);
  }
  if (round === 4) {
    const upper = group(2, 1);
    const lower = group(1, 2);
    if (upper.length !== 3 || lower.length !== 3) return [];
    return upper.flatMap(first => lower.map(second => [
      upper.filter(team => team !== first), lower.filter(team => team !== second), [first, second],
    ]));
  }
  if (round === 5) return scoreGroupPairs(group(2, 2));
  return [];
}

const opponentsKey = (first, second) => [first, second].sort().join('/');
const pairKey = ([first, second]) => opponentsKey(first.id, second.id);

function chooseQualifierPairs(pool, pastPairs, round) {
  let best = { pairs: [], repeats: Infinity, future: Infinity };
  for (const pairs of qualifierPairings(pool, round)) {
    const keys = pairs.map(pairKey);
    const repeats = keys.filter(key => pastPairs.has(key)).length;
    if (repeats > best.repeats) continue;

    // All round-two draws have the same worst case by symmetry. Only rounds
    // three and four need a look ahead to break ties in the current draw.
    let future = 0;
    if (round === 3 || round === 4) {
      const played = new Set([...pastPairs, ...keys]);
      for (let outcome = 0; outcome < 2 ** pairs.length; outcome++) {
        const remaining = pairs.flatMap((pair, index) => pair.map((team, side) => {
          const won = side === ((outcome >> index) & 1);
          return { ...team, wins: team.wins + Number(won), losses: team.losses + Number(!won) };
        })).filter(team => team.wins < 3 && team.losses < 3);
        const next = chooseQualifierPairs(remaining, played, round + 1);
        future = Math.max(future, next.repeats + next.future);
        if (repeats === best.repeats && future >= best.future) break;
      }
    }
    if (repeats < best.repeats || future < best.future) best = { pairs, repeats, future };
  }
  return best;
}

function seededPairs(teams) {
  return teams.slice(0, teams.length / 2).map((team, i) => [team, teams.at(-1 - i)]);
}

function openingPairs(event, pool) {
  const deferredIds = event.qualifierSchedule?.deferredOpeningPair;
  const deferred = pool.filter(team => deferredIds?.includes(team.id));
  if (deferred.length !== 2) return seededPairs(pool);
  return [...seededPairs(pool.filter(team => !deferred.includes(team))), deferred];
}

function legacyQualifierPairs(pool, past) {
  const meetings = new Map();
  for (const { slots } of past) {
    const key = opponentsKey(...slots);
    meetings.set(key, (meetings.get(key) ?? 0) + 1);
  }
  let best = { cost: Infinity, pairs: [] };
  for (const pairs of scoreGroupPairs(pool)) {
    const cost = pairs.reduce((sum, pair) => sum + (meetings.get(pairKey(pair)) ?? 0) * 100 +
      Math.abs(pair[0].wins - pair[1].wins), 0);
    if (cost < best.cost) best = { pairs, cost };
  }
  return best.pairs;
}

export function nextRound(event, state) {
  const past = state.rounds.flat();
  if (past.some(match => !state.results[match.id])) return [];
  const pool = standings(event, state).filter(team => team.wins < 3 && team.losses < 3);
  if (!pool.length || pool.length % 2) return [];
  const round = state.rounds.length + 1;
  const pairs = round === 1 ? openingPairs(event, pool)
    : event.qualifierFormat === 'score-groups-v1'
      ? chooseQualifierPairs(pool, new Set(past.map(({ slots }) => opponentsKey(...slots))), round).pairs
      : legacyQualifierPairs(pool, past);
  return pairs.map((pair, i) => ({ id: `G${round}.${i + 1}`, slots: pair.map(team => team.id), bestOf: event.qualifierBestOf }));
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
    const bestOf = match.id.startsWith('G') && !score ? event.qualifierBestOf : match.bestOf;
    return { ...match, bestOf, teams: slots, score, winner: winner || null };
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
