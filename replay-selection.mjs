const livePhases = new Set(['live', 'bomb', 'defuse']);
const endPhases = new Set(['over', 'halftime', 'intermission', 'gameover']);
const multiKillWindow = 4500;
const maxGsiGap = 15_000;

function observerKey(player) {
  return player ? `${player.side}/${player.slot ?? ''}/${player.name}` : null;
}

function clutchOpponents(frag, players) {
  const observer = players.find(player => player.observed);
  if (observerKey(observer) !== observerKey(frag) || !(observer?.health > 0)) return 0;
  const allies = players.filter(player => player.side === frag.side);
  const enemies = players.filter(player => player.side !== frag.side);
  if (allies.length < 2 || enemies.length < 2 || players.some(player => !Number.isInteger(player.health))) return 0;
  if (allies.filter(player => player.health > 0).length !== 1) return 0;
  const opponents = enemies.filter(player => player.health > 0).length;
  return opponents >= 2 ? opponents : 0;
}

function selectHighlights(candidates, result, players) {
  const opposition = players.filter(player => player.side !== result.side);
  const eliminated = result.reason === 'elimination'
    || (result.reason == null && opposition.length > 0 && opposition.every(player => player.health === 0));
  return candidates.map(candidate => {
    const closesRound = candidate.side === result.side && Math.abs(result.at - candidate.at) <= 1200;
    const clutch = closesRound && eliminated && candidate.clutch >= 2;
    return {
      ...candidate,
      title: clutch ? `Клатч 1×${candidate.clutch}`
        : closesRound && eliminated && candidate.count === 1 ? 'Последний фраг' : candidate.title,
      priority: candidate.priority + (clutch ? 28 : 0) + (closesRound ? 8 : 0),
    };
  }).sort((a, b) => b.priority - a.priority || b.at - a.at);
}

export function createReplaySelector() {
  let round = null;
  let previousPlayers = [];
  let previousAt = null;
  let previousObserver = null;
  let pov = 0;

  function reset() {
    round = null;
    previousPlayers = [];
    previousAt = null;
    previousObserver = null;
    pov = 0;
  }

  function ingest(game, now = Date.now()) {
    const response = { capture: null, roundEnd: null };
    if (!game?.matchId || !game.mapId || game.phase === 'warmup') {
      reset();
      return response;
    }

    const { matchId, mapId, phase, roundResult, players = [], frags = [] } = game;
    const live = livePhases.has(phase);
    const ended = endPhases.has(phase);
    const number = ended ? roundResult?.round : game.round;
    const stale = previousAt != null && (now - previousAt > maxGsiGap || now < previousAt);
    if (round && (stale || matchId !== round.matchId || mapId !== round.mapId || (live && number < round.number))) reset();

    if (live && Number.isSafeInteger(number) && number > 0 && round?.number !== number) {
      round = { matchId, mapId, number, began: now, ended: false, frags: [], seen: new Set(), candidates: [] };
    }

    const observer = observerKey(players.find(player => player.observed));
    if (observer !== previousObserver) pov += 1;
    const before = previousPlayers;
    previousPlayers = players;
    previousObserver = observer;
    previousAt = now;
    if (!round || round.ended || (!live && !ended) || (number != null && number !== round.number)) return response;

    for (const frag of frags) {
      if (!frag.id || round.seen.has(frag.id) || !Number.isFinite(frag.at) || frag.at > now || frag.at < round.began ||
          now - frag.at > 1700 || !Number.isSafeInteger(frag.count) || frag.count < 1) continue;
      round.seen.add(frag.id);
      round.frags = round.frags.filter(item => frag.at - item.at <= multiKillWindow);
      const recent = round.frags.filter(item => item.pov === pov && observerKey(item) === observerKey(frag));
      const clutch = Math.max(clutchOpponents(frag, before), ...recent.map(item => item.clutch));
      const count = recent.reduce((total, item) => total + item.count, frag.count);
      const headshot = frag.headshots > 0;
      round.frags.push({ ...frag, clutch, pov });

      const candidate = {
        id: frag.id, at: frag.at, startAt: recent[0]?.at ?? frag.at,
        matchId, mapId, round: round.number, name: frag.name, side: frag.side, count, clutch,
        title: count > 1 ? `${count} ${count < 5 ? 'фрага' : 'фрагов'}` : headshot ? 'Хедшот' : 'Фраг',
        priority: count * 20 + (headshot ? 3 : 0),
      };
      // Only request one save per GSI packet. The last clip normally contains the earlier frags too.
      if (!response.capture || candidate.priority >= response.capture.priority) response.capture = candidate;
    }
    if (response.capture) round.candidates.push(response.capture);

    if (ended && roundResult && round.candidates.length && (roundResult.side === 'CT' || roundResult.side === 'T')) {
      round.ended = true;
      const result = { ...roundResult, at: Number.isFinite(roundResult.at) ? roundResult.at : now };
      response.roundEnd = {
        id: result.id, at: result.at, round: round.number, matchId, mapId,
        side: result.side, candidates: selectHighlights(round.candidates, result, players),
      };
    }
    return response;
  }

  return { ingest, reset };
}
