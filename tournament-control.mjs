import { emptyState, nextRound, resolveMatches } from './dist/model.mjs';

export function error(status, message) {
  return Object.assign(new Error(message), { status });
}

export function updateMatch(event, state, body, mapId = null) {
  if (body.action === 'reset') {
    if (body.confirm !== true) throw error(400, 'Подтвердите полный сброс турнира');
    return { ...emptyState, results: {}, rounds: [], broadcast: {} };
  }
  if (body.action === 'event') {
    return state.started ? state : { ...state, started: true, rounds: [nextRound(event, state)] };
  }
  if (body.action === 'stream') {
    const value = body.url;
    if (typeof value !== 'string' || value.length > 500) throw error(400, 'Укажите ссылку HTTPS');
    if (value) {
      try { if (new URL(value).protocol !== 'https:') throw new Error(); }
      catch { throw error(400, 'Укажите ссылку HTTPS'); }
    }
    return { ...state, streamUrl: value };
  }
  if (body.action === 'pause') {
    return { ...state, active: null };
  }

  if (!state.started) throw error(409, 'Сначала запустите турнир');
  if (body.action === 'round') {
    if (body.round !== state.rounds.length) throw error(409, 'Обновите панель перед созданием тура');
    const matches = nextRound(event, state);
    if (!matches.length) throw error(409, 'Нет следующего тура. Проверьте результаты текущего');
    return { ...state, rounds: [...state.rounds, matches] };
  }
  const matches = resolveMatches(event, state);
  const match = matches.find(item => item.id === body.match);
  if (!match || match.teams.some(team => !team)) throw error(409, 'Обе команды должны определиться');
  if (body.action === 'broadcast') {
    const maps = body.maps;
    if (!Array.isArray(maps) || maps.length > match.bestOf || new Set(maps).size !== maps.length ||
      maps.some(map => typeof map !== 'string' || !/^(de|cs)_[a-z0-9_]{1,48}$/.test(map))) {
      throw error(400, `Укажите до ${match.bestOf} карт в формате de_mirage`);
    }
    const ctTeam = body.ctTeam || null;
    if (ctTeam && !match.teams.some(team => team.id === ctTeam)) throw error(400, 'Выберите команду CT из текущей пары');
    const sideMap = match.id === state.active ? mapId : null;
    const saved = state.broadcast?.[match.id];
    return { ...state, broadcast: { ...state.broadcast, [match.id]: { ...saved, maps, ctTeam, sideMap, sideRevision: (saved?.sideRevision ?? 0) + 1 } } };
  }
  if (body.action === 'start') {
    if (match.winner) throw error(409, 'Матч уже завершён');
    if (state.active === match.id) return state;
    return { ...state, active: match.id };
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
  const rounds = match.id.startsWith('G') && !match.score
    ? state.rounds.map(round => round.map(item => item.id === match.id ? { ...item, bestOf: match.bestOf } : item))
    : state.rounds;
  return { ...state, rounds, results: { ...state.results, [match.id]: score }, active: wasActive ? null : state.active };
}
