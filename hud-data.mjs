const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const side = value => value === 'CT' || value === 'T';
const normalized = name => name.normalize('NFKC').trim().toLowerCase();
const opposite = value => value === 'CT' ? 'T' : 'CT';
const bombStates = ['carried', 'dropped', 'planting', 'planted', 'defusing', 'defused', 'exploded'];
const playablePhases = ['live', 'bomb', 'defuse', 'over', 'gameover'];
const roundEndPhases = ['over', 'intermission', 'halftime', 'gameover'];
const roundReasons = { elimination: 'elimination', time: 'time', bomb: 'exploded', defuse: 'defused', rescue: 'rescue' };

function countdownEnd(value, now) {
  const seconds = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? now + seconds * 1000 : null;
}

function vector(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const points = value.split(',').map(Number);
  return points.length === 3 && points.every(Number.isFinite) ? points : null;
}

function loadout(weapons) {
  if (!weapons || typeof weapons !== 'object') return null;
  const items = { primary: null, pistol: null, grenades: [], bomb: false, active: null };
  for (const weapon of Object.values(weapons)) {
    if (typeof weapon?.name !== 'string' || !/^weapon_[a-z0-9_]{1,40}$/.test(weapon.name)) continue;
    const id = weapon.name.slice(7);
    if (weapon.state === 'active' || weapon.state === 'reloading') {
      items.active = { id, clip: count(weapon.ammo_clip), reserve: count(weapon.ammo_reserve), reloading: weapon.state === 'reloading' };
    }
    if (id === 'c4') items.bomb = true;
    else if (weapon.type === 'Grenade') {
      const amount = count(weapon.ammo_reserve) ?? 1;
      if (amount) items.grenades.push({ id, count: amount });
    } else if (weapon.type === 'Pistol') items.pistol = id;
    else if (count(weapon.ammo_clip) != null && !items.primary) items.primary = id;
  }
  return items;
}

function readBomb(payload, players, phase, clockEnd, previous, now, eventId) {
  const raw = payload.bomb;
  const roundBomb = payload.round?.bomb;
  let state = bombStates.includes(raw?.state) ? raw.state : null;
  if (['over', 'gameover'].includes(phase) && ['exploded', 'defused'].includes(roundBomb)) state = roundBomb;
  if (!state) state = phase === 'defuse' ? 'defusing' : roundBomb === 'planted' || phase === 'bomb' ? 'planted' : null;
  if (!state || (phase === 'freezetime' && ['planting', 'planted', 'defusing', 'defused', 'exploded'].includes(state))) return null;

  const player = raw?.player && players.find(player => player.key === raw.player)?.name;
  const sameAction = previous?.state === state && (previous.player == null || player == null || previous.player === player);
  const armed = ['planted', 'defusing', 'defused', 'exploded'].includes(state);
  const previousPlant = armed ? previous?.plantedAt ?? null : null;
  const countdown = countdownEnd(raw?.countdown, now);
  const actionEnd = state === 'planting' || state === 'defusing'
    ? countdown ?? (phase === 'defuse' ? clockEnd : null) ?? (sameAction ? previous.actionEnd : null) : null;
  const fuseEnd = state === 'planted' ? countdown ?? (phase === 'bomb' ? clockEnd : null) ?? previous?.fuseEnd ?? null
    : state === 'defusing' ? (phase === 'bomb' ? clockEnd : null) ?? previous?.fuseEnd ?? null : null;
  const site = typeof raw?.site === 'string' && /^[ab]$/i.test(raw.site) ? raw.site.toUpperCase() : null;
  return {
    state, id: sameAction ? previous.id : eventId(), at: sameAction ? previous.at : now,
    site: site ?? (armed ? previous?.site ?? null : null),
    position: vector(raw?.position) ?? (armed ? previous?.position ?? null : null),
    player: player || (sameAction ? previous.player : null), actionEnd, fuseEnd,
    plantedAt: armed ? previousPlant ?? now : null,
  };
}

function readRoundResult(payload, score, phase, bomb, previous, current, now, eventId) {
  if (!roundEndPhases.includes(phase) || (phase !== 'over' && !previous)) return null;
  const justEnded = previous && !roundEndPhases.includes(previous.phase);
  const round = current?.round ?? Math.max(1, score.total + (justEnded && previous.total === score.total ? 1 : 0));
  const outcome = /^(ct|t)_win_(elimination|time|bomb|defuse|rescue)$/.exec(payload.map?.round_wins?.[round]);
  const roundWinner = payload.round?.win_team;
  const scoreWinner = previous && score.total === previous.total + 1
    ? score.ct === previous.ct + 1 && score.t === previous.t ? 'CT'
      : score.t === previous.t + 1 && score.ct === previous.ct ? 'T' : null
    : null;
  const winner = side(roundWinner) ? roundWinner : outcome?.[1].toUpperCase() ?? scoreWinner ?? current?.side;
  if (!winner) return null;

  const reason = outcome ? roundReasons[outcome[2]]
    : ['defused', 'exploded'].includes(bomb?.state) ? bomb.state : current?.reason ?? null;
  return { id: current?.id ?? eventId(), at: current?.at ?? now, round, side: winner, reason };
}

function killDelta(player, previous) {
  if (player.roundKills != null && previous.roundKills != null) return player.roundKills - previous.roundKills;
  return player.kills != null && previous.kills != null ? player.kills - previous.kills : 0;
}

function readFrag(players, previous, now, eventId) {
  const observed = players.find(player => player.observed);
  const before = observed && previous.find(player => player.key === observed.key);
  if (!before?.observed || before.side !== observed.side) return null;

  const amount = killDelta(observed, before);
  if (amount < 1) return null;

  // GSI reports counters. Name a victim only when one enemy death matches one scoring player in this update.
  const deaths = [];
  let scorers = 0;
  for (const player of players) {
    const old = previous.find(candidate => candidate.key === player.key);
    if (!old || old.side !== player.side) continue;
    if (killDelta(player, old) > 0) scorers += 1;
    if ((player.deaths != null && old.deaths != null && player.deaths > old.deaths) ||
        (old.health > 0 && player.health === 0)) deaths.push(player);
  }
  const victim = amount === 1 && scorers === 1 && deaths.length === 1 && deaths[0].side !== observed.side ? deaths[0].name : null;
  const headshots = observed.roundHeadshots != null && before.roundHeadshots != null
    ? observed.roundHeadshots - before.roundHeadshots : null;
  return {
    id: eventId(), at: now, name: observed.name, side: observed.side, slot: observed.slot,
    count: amount, roundKills: observed.roundKills, victim,
    headshots: headshots != null && headshots >= 0 && headshots <= amount ? headshots : null,
  };
}

function createHudEvents() {
  let previous = null;
  let bomb = null;
  let roundResult = null;
  let frags = [];
  let sequence = 0;

  return (payload, players, identity, phase, clockEnd, now) => {
    const ct = payload.map?.team_ct?.score ?? 0;
    const t = payload.map?.team_t?.score ?? 0;
    const total = ct + t;
    const sameMap = previous?.identity === identity && now - previous.at < 15_000 && total >= previous.total && phase !== 'warmup';
    const sameRound = sameMap && (total === previous.total ||
      (['over', 'gameover'].includes(phase) && total === previous.total + 1));
    const eventId = () => `${now}-${++sequence}`;

    // A new round can start before GSI reports the first freeze-time packet.
    const startsRound = phase === 'freezetime' || (roundEndPhases.includes(previous?.phase) && !roundEndPhases.includes(phase));
    const keepRound = sameRound && !startsRound;
    const keepBomb = keepRound || (sameMap && previous.phase === phase && phase === 'freezetime');
    bomb = readBomb(payload, players, phase, clockEnd, keepBomb ? bomb : null, now, eventId);
    roundResult = readRoundResult(payload, { ct, t, total }, phase, bomb, sameMap ? previous : null,
      keepRound ? roundResult : null, now, eventId);
    frags = keepRound ? frags.filter(frag => now - frag.at < 7000) : [];
    if (keepRound && playablePhases.includes(previous.phase) && playablePhases.includes(phase)) {
      const frag = readFrag(players, previous.players, now, eventId);
      if (frag) frags = [...frags.slice(-4), frag];
    }
    previous = { identity, ct, t, total, phase, players, at: now };
    return { bomb, roundResult, frags };
  };
}

const matchStatNames = ['kills', 'assists', 'deaths', 'mvps', 'score'];

function createMatchStats() {
  let map = null;
  let previous = null;
  let roster = new Map();

  return (players, mapId, phase, completed, avatarFor) => {
    if (map !== mapId || phase === 'warmup' || (previous && completed < previous.completed)) {
      map = mapId;
      previous = null;
      roster = new Map();
    }
    const ended = roundEndPhases.includes(phase);
    // CS2 can switch the phase before updating the score, or send both in one packet.
    const round = ended ? Math.max(1, completed, previous?.round ?? 0) : completed + 1;
    for (const player of phase === 'warmup' ? [] : players) {
      const entry = roster.get(player.key) ?? { player: null, damage: new Map() };
      const stats = Object.fromEntries(matchStatNames.map(name => [name, player[name] ?? entry.player?.[name] ?? null]));
      entry.player = { ...player, ...stats };
      if (player.roundDamage != null) {
        const sample = entry.damage.get(round) ?? { value: 0, final: false };
        sample.final ||= ended && completed >= round && player.roundDamage >= sample.value;
        sample.value = Math.max(sample.value, player.roundDamage);
        entry.damage.set(round, sample);
      }
      roster.set(player.key, entry);
    }
    if (phase !== 'warmup') previous = { completed, round };

    const source = phase === 'gameover' ? [...roster.values()].map(entry => entry.player)
      : players.map(player => roster.get(player.key)?.player ?? player);
    return source.map(({ key, roundHeadshots, ...player }) => {
      const samples = [...(roster.get(key)?.damage.values() ?? [])];
      return {
        ...player, avatar: avatarFor(key),
        totalDamage: samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) : null,
        damagePartial: completed > samples.filter(sample => sample.final).length || !samples.length,
      };
    });
  };
}

export function createObserverHud(avatarFor = () => null) {
  let previousMatch = '';
  let previousMapping = '';
  let anchors = new Map();
  const hudEvents = createHudEvents();
  const matchStats = createMatchStats();

  return function observerHud(payload, match, options, mapId, now = Date.now()) {
    const allPlayers = payload.allplayers ?? {};
    const target = [payload.player?.spectarget, payload.player?.steamid].find(key => key && Object.hasOwn(allPlayers, key));
    const players = [];
    for (const [key, player] of Object.entries(allPlayers)) {
      if (!side(player?.team) || typeof player.name !== 'string' || !player.name.trim()) continue;
      const stats = player.state;
      players.push({
        key, name: player.name.trim().slice(0, 80), side: player.team, slot: count(player.observer_slot),
        health: count(stats?.health), armor: count(stats?.armor), money: count(stats?.money),
        equipmentValue: count(stats?.equip_value),
        kills: count(player.match_stats?.kills), assists: count(player.match_stats?.assists), deaths: count(player.match_stats?.deaths),
        mvps: count(player.match_stats?.mvps), score: Number.isSafeInteger(player.match_stats?.score) ? player.match_stats.score : null,
        roundKills: count(stats?.round_kills), roundHeadshots: count(stats?.round_killhs), roundDamage: count(stats?.round_totaldmg),
        helmet: stats?.helmet === true, kit: stats?.defusekit === true,
        loadout: loadout(player.weapons), position: vector(player.position), forward: vector(player.forward),
        observed: key === target || (!target && player.name === payload.player?.name && player.team === payload.player?.team),
      });
    }
    players.sort((a, b) => (a.slot ?? Infinity) - (b.slot ?? Infinity) || a.name.localeCompare(b.name));

    const identity = `${match?.id ?? ''}/${mapId}`;
    const mapping = `${options?.ctTeam ?? ''}/${options?.sideMap ?? ''}/${options?.sideRevision ?? ''}`;
    if (identity !== previousMatch || mapping !== previousMapping) {
      previousMatch = identity;
      previousMapping = mapping;
      anchors = new Map();
    }
    const manual = (!options?.sideMap || options.sideMap === mapId) ? options?.ctTeam : null;
    const [first, second] = match?.teams ?? [];
    let ctTeam = null;
    if (first && second) {
      if (manual && players.some(player => player.side === 'CT') && players.some(player => player.side === 'T') &&
          !players.some(player => anchors.has(player.key))) {
        for (const member of players) anchors.set(member.key, member.side === 'CT' ? manual : (manual === first.id ? second.id : first.id));
      }
      for (const player of manual ? [] : players) {
        const known = [first, second].find(team => team.players.some(name => normalized(name) === normalized(player.name)));
        if (known) anchors.set(player.key, known.id);
      }
      const votes = players.flatMap(player => {
        const team = anchors.get(player.key);
        return team ? [player.side === 'CT' ? team : (team === first.id ? second.id : first.id)] : [];
      });
      if (votes.length && votes.every(team => team === votes[0])) ctTeam = votes[0];
      else if (!votes.length && manual) ctTeam = manual;
    }

    const timing = payload.phase_countdowns;
    const timedPhase = ['live', 'freezetime', 'bomb', 'defuse', 'over', 'paused', 'timeout_ct', 'timeout_t', 'warmup', 'halftime'].includes(timing?.phase)
      ? timing.phase : null;
    const roundPhase = ['live', 'freezetime', 'over'].includes(payload.round?.phase) ? payload.round.phase : null;
    const phase = roundPhase === 'over' && ['live', 'bomb', 'defuse'].includes(timedPhase) ? roundPhase : timedPhase ?? roundPhase;
    const clockEnd = phase && phase === timedPhase ? countdownEnd(timing?.phase_ends_in, now) : null;
    const eventPhase = timing?.phase === 'gameover' ? 'gameover'
      : ['warmup', 'intermission', 'gameover'].includes(payload.map?.phase) ? payload.map.phase : phase;
    const completed = (payload.map?.team_ct?.score ?? 0) + (payload.map?.team_t?.score ?? 0);
    const displayPlayers = matchStats(players, mapId, eventPhase, completed, avatarFor);
    return {
      players: displayPlayers, ctTeam, phase, clockEnd,
      damagePartial: !displayPlayers.length || displayPlayers.some(player => player.damagePartial),
      timeouts: { ct: count(payload.map?.team_ct?.timeouts_remaining), t: count(payload.map?.team_t?.timeouts_remaining) },
      ...hudEvents(payload, players, identity, eventPhase, clockEnd, now),
      grenades: Object.values(payload.grenades ?? {}).flatMap(grenade => {
        const position = vector(grenade?.position);
        return position && ['smoke', 'fire', 'inferno'].includes(grenade.type) ? [{ type: grenade.type, position }] : [];
      }),
    };
  };
}
