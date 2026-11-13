import { emptyState, nextRound, recordedSeriesScore, resolveMatches } from './dist/model.mjs';

export function error(status, message) {
  return Object.assign(new Error(message), { status });
}

function configureBroadcast(state, match, body, mapId, requireComplete) {
  const { maps, ctTeam: selectedCT } = body;
  if (!Array.isArray(maps) || maps.length > match.bestOf || new Set(maps).size !== maps.length ||
      maps.some(map => typeof map !== 'string' || !/^(de|cs)_[a-z0-9_]{1,48}$/.test(map))) {
    throw error(400, `Выберите до ${match.bestOf} разных карт`);
  }
  const ctTeam = selectedCT || null;
  if (ctTeam && !match.teams.some(team => team.id === ctTeam)) throw error(400, 'Выберите команду CT из текущей пары');
  if (requireComplete && (maps.length !== match.bestOf || !ctTeam)) {
    throw error(400, `Перед эфиром выберите ${match.bestOf} карт и стартовую команду CT`);
  }
  const saved = state.broadcast?.[match.id];
  if (saved?.mapResults?.some((result, i) => maps[i] !== result.mapId)) {
    throw error(409, 'Сначала отмените результаты карт, которые хотите заменить');
  }
  const plannedMap = maps[saved?.mapResults?.length ?? 0] ?? null;
  const sideMap = match.id === state.active ? mapId ?? plannedMap : plannedMap;
  const sideChanged = saved?.ctTeam !== ctTeam || saved?.sideMap !== sideMap;
  const settings = { ...saved, maps, ctTeam, sideMap, sideRevision: (saved?.sideRevision ?? 0) + Number(sideChanged) };
  if (requireComplete) settings.mapResults ??= [];
  return { ...state, broadcast: { ...state.broadcast, [match.id]: settings } };
}

function finishSeries(state, match, score) {
  const rounds = match.id.startsWith('G') && !match.score
    ? state.rounds.map(round => round.map(item => item.id === match.id ? { ...item, bestOf: match.bestOf } : item))
    : state.rounds;
  return { ...state, rounds, results: { ...state.results, [match.id]: score }, active: state.active === match.id ? null : state.active };
}

function replayMatch(state, match, body) {
  if (body.confirm !== true) throw error(400, 'Подтвердите сброс матча');
  const roundIndex = state.rounds.findIndex(round => round.some(item => item.id === match.id));
  const isQualifier = roundIndex >= 0;
  const removed = new Set(isQualifier
    ? [...state.rounds.slice(roundIndex + 1).flat().map(item => item.id), 'S1', 'S2', 'F1']
    : match.id.startsWith('S') ? ['F1'] : []);
  const results = { ...state.results };
  const broadcast = { ...state.broadcast };
  for (const id of [match.id, ...removed]) {
    delete results[id];
    delete broadcast[id];
  }
  const saved = state.broadcast?.[match.id];
  const { mapResults, mapWinners, ...setup } = saved ?? {};
  broadcast[match.id] = { ...setup, sideMap: setup.maps?.[0] ?? null, mapResults: [], mapRevision: (setup.mapRevision ?? 0) + 1 };
  const active = state.active === match.id || removed.has(state.active) ? null : state.active;
  return { ...state, rounds: isQualifier ? state.rounds.slice(0, roundIndex + 1) : state.rounds, results, broadcast, active };
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
  if (body.action === 'broadcast') return configureBroadcast(state, match, body, mapId, false);
  if (body.action === 'start') {
    if (match.winner) throw error(409, 'Матч уже завершён');
    const configured = Object.hasOwn(body, 'maps') || Object.hasOwn(body, 'ctTeam');
    const next = configured ? configureBroadcast(state, match, body, mapId, true) : state;
    return next === state && state.active === match.id ? state : { ...next, active: match.id };
  }
  if (body.action === 'match-reset') return replayMatch(state, match, body);
  if (body.action === 'map-result' || body.action === 'map-undo') {
    if (match.id !== state.active || match.score) throw error(409, 'Откройте незавершённый матч в эфире');
    const saved = state.broadcast?.[match.id];
    const history = saved?.mapResults ?? [];
    const mapRevision = saved?.mapRevision ?? 0;
    if (body.expectedIndex !== history.length ||
        (Object.hasOwn(body, 'expectedRevision') && body.expectedRevision !== mapRevision)) {
      throw error(409, 'Счёт уже изменился. Проверьте текущую карту');
    }
    let mapResults;
    if (body.action === 'map-undo') {
      if (!history.length) throw error(409, 'Нет результата карты для отмены');
      mapResults = history.slice(0, -1);
    } else {
      const nextMap = saved?.maps?.[history.length];
      if (!nextMap) throw error(409, 'Сначала выберите карты серии');
      if (body.mapId !== nextMap || !match.teams.some(team => team.id === body.winner)) {
        throw error(400, 'Проверьте текущую карту и победителя');
      }
      mapResults = [...history, { mapId: nextMap, winner: body.winner }];
    }
    const options = { ...saved, mapResults, mapRevision: mapRevision + 1 };
    const next = { ...state, broadcast: { ...state.broadcast, [match.id]: options } };
    const score = recordedSeriesScore(match, options);
    return Math.max(...score) >= (match.bestOf + 1) / 2 ? finishSeries(next, match, score) : next;
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
  const saved = state.broadcast?.[match.id];
  const recorded = recordedSeriesScore({ ...match, score: null }, saved);
  if (!recorded.some((wins, index) => wins > score[index])) return finishSeries(state, match, score);

  // A series total does not identify which recorded map result needs correction.
  const options = { ...saved, mapResults: [], mapWinners: {}, mapRevision: (saved?.mapRevision ?? 0) + 1 };
  return finishSeries({ ...state, broadcast: { ...state.broadcast, [match.id]: options } }, match, score);
}
