const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const side = value => value === 'CT' || value === 'T';
const normalized = name => name.normalize('NFKC').trim().toLowerCase();
const opposite = value => value === 'CT' ? 'T' : 'CT';

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

export function createObserverHud() {
  let previousMatch = '';
  let previousMapping = '';
  let anchors = new Map();

  return function observerHud(payload, match, options, mapId) {
    const allPlayers = payload.allplayers ?? {};
    const target = [payload.player?.spectarget, payload.player?.steamid].find(key => key && Object.hasOwn(allPlayers, key));
    const players = [];
    for (const [key, player] of Object.entries(allPlayers)) {
      if (!side(player?.team) || typeof player.name !== 'string' || !player.name.trim()) continue;
      const stats = player.state;
      players.push({
        key, name: player.name.trim().slice(0, 80), side: player.team, slot: count(player.observer_slot),
        health: count(stats?.health), armor: count(stats?.armor), money: count(stats?.money),
        equipmentValue: count(stats?.equip_value), kills: count(player.match_stats?.kills), deaths: count(player.match_stats?.deaths),
        roundKills: count(stats?.round_kills), roundDamage: count(stats?.round_totaldmg),
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
    const seconds = typeof timing?.phase_ends_in === 'string' || typeof timing?.phase_ends_in === 'number'
      ? Number(timing.phase_ends_in) : NaN;
    const phase = ['live', 'freezetime', 'bomb', 'over', 'paused', 'timeout_ct', 'timeout_t', 'warmup', 'halftime'].includes(timing?.phase)
      ? timing.phase : null;
    const bombState = ['planted', 'dropped', 'carried', 'defused', 'exploded'].includes(payload.bomb?.state) ? payload.bomb.state : null;
    return {
      players: players.map(({ key, ...player }) => player), ctTeam, phase,
      timeouts: { ct: count(payload.map?.team_ct?.timeouts_remaining), t: count(payload.map?.team_t?.timeouts_remaining) },
      clockEnd: phase && Number.isFinite(seconds) && seconds >= 0 && seconds <= 3600 ? Date.now() + seconds * 1000 : null,
      bomb: bombState ? { state: bombState, position: vector(payload.bomb.position) } : null,
      grenades: Object.values(payload.grenades ?? {}).flatMap(grenade => {
        const position = vector(grenade?.position);
        return position && ['smoke', 'fire', 'inferno'].includes(grenade.type) ? [{ type: grenade.type, position }] : [];
      }),
    };
  };
}
