import { currentSeriesScores, resolveMatches } from './dist/model.mjs';

const phases = new Set(['warmup', 'live', 'freezetime', 'over', 'intermission', 'halftime', 'paused',
  'timeout_ct', 'timeout_t', 'bomb', 'defuse', 'gameover']);
const validMap = value => typeof value === 'string' && /^[a-z0-9_]{1,64}$/.test(value);
const boundedInt = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;

export function spectatorView(event, state) {
  const { started, rounds, results, active, streamUrl } = state;
  const seriesScores = currentSeriesScores(event, state);
  return { started, rounds, results, active, streamUrl, ...(Object.keys(seriesScores).length && { seriesScores }) };
}

export function organizerView(event, state, bridge, now = Date.now()) {
  const online = Boolean(bridge && now - bridge.seen < 15_000);
  const snapshot = online ? bridge.game : null;
  const game = snapshot?.matchId && snapshot.matchId !== state.active
    ? { ...snapshot, matchId: null, ctTeam: null } : snapshot;
  return { ...spectatorView(event, state), broadcast: state.broadcast ?? {}, game, gsi: online && bridge.gsi,
    service: online, publishStatus: online ? 'ПК наблюдателя подключён' : 'ПК наблюдателя не на связи' };
}

export function observerUpdate(event, state, telemetry, now = Date.now()) {
  const active = telemetry.active === state.active ? state.active : null;
  const match = active && resolveMatches(event, state).find(item => item.id === active);
  const raw = telemetry.game;
  const linked = Boolean(match && (!Object.hasOwn(raw ?? {}, 'matchId') || raw.matchId === active));
  const game = validMap(raw?.mapId) ? {
    mapId: raw.mapId, matchId: linked ? active : null,
    ctTeam: linked && match.teams.some(team => team?.id === raw.ctTeam) ? raw.ctTeam : null,
    ct: boundedInt(raw.ct, 1000), t: boundedInt(raw.t, 1000), round: boundedInt(raw.round, 2000),
    phase: phases.has(raw.phase) ? raw.phase : null, clockEnd: boundedInt(raw.clockEnd, now + 3_600_000),
  } : null;
  const completed = telemetry.completed;
  if (match && completed?.match === active && validMap(completed.mapId) && match.teams.some(team => team?.id === completed.winner)) {
    const options = state.broadcast?.[active];
    if (options?.mapWinners?.[completed.mapId] !== completed.winner) {
      const mapWinners = { ...options?.mapWinners, [completed.mapId]: completed.winner };
      state = { ...state, broadcast: { ...state.broadcast, [active]: { ...options, mapWinners } } };
    }
  }
  return { state, bridge: { seen: now, active, gsi: telemetry.gsi === true, game } };
}
