import { emptyState, readEvent, resolveMatches, safe, stageName, watchState } from './model.mjs';

const el = id => document.getElementById(id);
const standby = new URLSearchParams(location.search).get('scene') === 'standby';
const phases = { warmup: 'Разминка', freezetime: 'Закуп', intermission: 'Смена сторон', halftime: 'Смена сторон',
  paused: 'Пауза', timeout_ct: 'Тайм-аут CT', timeout_t: 'Тайм-аут T', gameover: 'Карта завершена' };
const icons = {
  cross: '<path d="M6 0h4v6h6v4h-6v6H6v-6H0V6h6z"/>',
  shield: '<path d="M8 1 15 4v4c0 3-2 5-7 7-5-2-7-4-7-7V4z"/>',
  aim: '<path d="M7 0h2v3h3v2h2v2h2v2h-2v2h-2v2H9v3H7v-3H4v-2H2V9H0V7h2V5h2V3h3zm1 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6"/>',
  skull: '<path d="M8 1c4 0 7 3 7 7 0 3-1 4-3 5v2H4v-2c-2-1-3-2-3-5 0-4 3-7 7-7M5 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4m6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>',
  kit: '<path d="M5 1h6v3h4v11H1V4h4zm1 3h4V2H6zm1 2v3H4v2h3v3h2v-3h3V9H9V6z"/>',
  ammo: '<path d="M1 5l2-4 2 4v10H1zm5 0 2-4 2 4v10H6zm5 0 2-4 2 4v10h-4z"/>',
};
const emblems = {
  ct: '<path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="5" d="m7 11 6 5 7-3 7 3 6-5 1 11c-2 6-7 10-14 14C13 32 8 28 6 22z"/><path fill="currentColor" d="m7 9 6 2-2 5zm26 0-6 2 2 5z"/>',
  t: '<path fill="currentColor" d="M20 3c5 3 9 6 12 12l4 5-5-1 5 5-6 2c2 3 1 6-2 10l-2-7-4-2 3 10c-8-3-12-7-13-13-2 4-2 8 0 11C3 32 2 24 7 17l-3 1c3-8 9-10 14-12l-1 6 7-3z"/><path fill="#17232d" d="m26 16 5 4-6-1z"/>',
};
const icon = id => `<svg class="card-icon" viewBox="0 0 16 16" aria-hidden="true">${icons[id]}</svg>`;
const dollars = value => `$${value.toLocaleString('en-US')}`;
const value = number => number ?? '–';

async function optionalJson(url, fallback) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : fallback;
  } catch { return fallback; }
}

el('standby').hidden = !standby;
el('match-graphic').hidden = standby;
const [event, assets, media] = await Promise.all([
  readEvent(), optionalJson('/hud/assets.json', { maps: {}, weapons: [] }), optionalJson('/api/hud-media', {}),
]);
const weapons = new Set(assets.weapons);
let clockEnd = null;
let lastCamera = '';
let lastPortrait = '';

function imagePath(path) {
  return typeof path === 'string' && /^\/hud-media\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(path) ? path : '';
}

function cameraUrl(path) {
  try {
    const url = new URL(path);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function portrait(player, face = false) {
  const file = imagePath(media[player.name]?.portrait);
  if (file) return `<img src="${safe(file)}" alt="">`;
  const seed = [...player.name].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 0);
  const skin = ['#eeb38e', '#c78563', '#f1c49a', '#9e6049'][seed % 4];
  const shade = ['#af675b', '#884b44', '#b46d53', '#653e44'][seed % 4];
  const hair = ['#17111e', '#583332', '#c19267', '#271c22'][(seed >>> 4) % 4];
  const cut = [
    'M37 53C29 17 64 10 86 21c15 6 19 19 16 39l-12-9-8-20-17 17-19 3-7 13z',
    'M36 58C27 37 38 13 63 13c29-6 45 14 44 44l-12 7-6-18-7-16-13 12-17-3-6 20z',
    'M37 58C26 37 47 13 66 14c30-2 43 12 39 44l-9 4-6-18-16-13-17 11-10 13z',
    'M37 61C25 35 44 12 70 16c27-5 41 15 34 46l-10 7-4-26-12 3-10-14-17 16-5 17z',
  ][(seed >>> 9) % 4];
  return `<svg viewBox="${face ? '30 12 81 81' : '0 0 140 142'}" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
    <path fill="#080e24" stroke="#1a1726" stroke-width="3" d="M0 145c3-24 25-39 55-47h30c30 8 52 22 55 47z"/>
    <path fill="#37577c" d="m0 145 14-27 33-17 20 24 16-25 33 13 24 32H93l-24-12-25 12z"/>
    <path fill="${shade}" stroke="#1a1726" stroke-width="2" d="M54 83h32l4 24-21 14-19-13z"/>
    <path fill="${skin}" stroke="#1a1726" stroke-width="3" d="M40 53c-12-8-11 15 0 18 3 22 17 35 29 35s25-12 29-34c10-3 11-24 1-20l-2-18-29-13-25 12z"/>
    <path fill="${shade}" opacity=".68" d="m91 40 8 12-4 21c-5 22-16 32-26 32l-11-5 14-4 12-12 3-19z"/>
    <path fill="${hair}" stroke="#171322" stroke-width="3" d="${cut}"/>
    <path fill="none" stroke="#171322" stroke-width="2" stroke-linecap="round" d="m49 56 11-2m18 0 11 3M68 60l-3 16 6 1m-10 11 7 1 8-2"/>
    <path fill="#171322" d="M49 61q6-4 12 1-7 4-12-1m29 1q7-4 12 1-7 4-12-1"/>
    ${seed % 3 === 0 ? '<path fill="none" stroke="#292031" stroke-width="2" d="M46 58h18v10H47zm30 0h18l-1 10H76zm-12 3h12"/>' : ''}
    <path fill="none" stroke="#88aacf" stroke-width="2" opacity=".6" d="m13 134 21-15 15-5m40 0 15 5 24 17"/>
  </svg>`;
}

function weapon(id, cls) {
  if (!id) return '';
  return weapons.has(id) ? `<img class="${cls}" src="/hud/weapons/${safe(id)}.svg" alt="${safe(id)}">`
    : `<span class="weapon-text">${safe(id.toUpperCase().replaceAll('_', '-'))}</span>`;
}

function card(player) {
  const dead = player.health === 0;
  const items = player.loadout;
  const gun = items?.primary || items?.pistol;
  const utility = items?.grenades.flatMap(grenade => Array(Math.min(2, grenade.count)).fill(grenade.id)).slice(0, 4) ?? [];
  const gear = utility.map(id => weapon(id, 'gear-icon')).join('');
  const status = items?.bomb ? `<span class="card-status carries-bomb">${weapon('c4', 'gear-icon')}</span>`
    : player.kit ? `<span class="card-status carries-kit">${icon('kit')}</span>` : '';
  const kit = player.kit ? icon('kit') : '';
  return `<article class="player-card${dead ? ' is-out' : ''}${player.observed && !dead ? ' is-observed' : ''}">
    <div class="card-head">
      ${dead ? '' : `<div class="card-art">${portrait(player)}</div>${status}<strong class="card-health" aria-label="${value(player.health)} HP">${player.armor ? icon('shield') : ''}${value(player.health)}</strong>`}
      ${!dead && player.roundKills > 0 ? `<b class="card-streak" aria-label="Убийства в раунде">${player.roundKills}</b>` : ''}
      <b class="card-name">${safe(player.name)}</b>
    </div>
    <div class="card-kd"><span aria-label="Убийства">${icon('aim')}</span><b>${value(player.kills)}</b><span aria-label="Смерти">${icon('skull')}</span><b>${value(player.deaths)}</b><b class="card-money" aria-label="Деньги">${value(player.money)}</b></div>
    <div class="card-gear">${dead
      ? `<span class="card-damage">ROUND DAMAGE <b>${value(player.roundDamage)}</b></span>`
      : `${weapon(gun, 'weapon-icon')}<div class="card-utility">${gear}${kit}</div>`}</div>
  </article>`;
}

function paintCards(players, buying) {
  for (const side of ['CT', 'T']) {
    const roster = players.filter(player => player.side === side).slice(0, 5);
    const target = el(`cards-${side.toLowerCase()}`);
    const equip = buying && roster.length && roster.every(player => player.equipmentValue != null)
      ? `<div class="side-economy">ЗАКУП ${side} <span>${dollars(roster.reduce((total, player) => total + player.equipmentValue, 0))}</span></div>` : '';
    const markup = equip + roster.map(card).join('');
    if (target.rendered !== markup) { target.innerHTML = markup; target.rendered = markup; }
  }
}

function showObserved(player) {
  el('observer').hidden = !player;
  const camera = player ? cameraUrl(media[player.name]?.camera) : '';
  const frame = el('observer-feed');
  if (camera !== lastCamera) {
    lastCamera = camera;
    if (camera) frame.src = camera;
    else frame.removeAttribute('src');
  }
  frame.hidden = !camera;
  if (!player) return;
  el('observer').className = `observer side-${player.side.toLowerCase()}`;
  if (lastPortrait !== player.name) {
    lastPortrait = player.name;
    el('observer-art').innerHTML = portrait(player);
  }
  el('observer-name').textContent = player.name;
  el('observer-hp').innerHTML = value(player.health) + (player.armor ? icon('shield') : '');
  el('observer-hp').setAttribute('aria-label', `${value(player.health)} HP, броня ${value(player.armor)}`);
  const active = player.loadout?.active;
  el('observer-ammo').innerHTML = active?.clip == null ? '' : `${active.clip}/${value(active.reserve)} ${icon('ammo')}`;
}

function updateClock() {
  const seconds = clockEnd == null ? null : Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000));
  el('clock').textContent = seconds == null ? '–:––' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function setTeams(match, game) {
  const ctTeam = match?.teams.find(team => team.id === game?.ctTeam);
  const tTeam = ctTeam && match.teams.find(team => team !== ctTeam);
  for (const [side, team] of [['ct', ctTeam], ['t', tTeam]]) {
    el(`team-${side}`).textContent = team ? team.players.join(' / ') : side === 'ct' ? 'Counter-Terrorists' : 'Terrorists';
    const source = imagePath(media.teams?.[team?.id]?.logo);
    const markup = source ? `<img src="${safe(source)}" alt="">`
      : `<svg viewBox="0 0 40 40" aria-hidden="true">${emblems[side]}</svg>`;
    const emblem = el(`${side}-emblem`);
    if (emblem.rendered !== markup) { emblem.innerHTML = markup; emblem.rendered = markup; }
  }
}

const percent = value => `${(value * 100).toFixed(2)}%`;
function radarMark(position, css, text = '') {
  if (!position || position.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return '';
  return `<span class="${css}" style="left:${percent(position[0])};top:${percent(position[1])}">${text}</span>`;
}

function showRadar(mapId, game) {
  const overview = Object.hasOwn(assets.maps, mapId) ? assets.maps[mapId] : null;
  el('radar').hidden = !overview;
  if (!overview) return;
  const players = game.players ?? [];
  const observed = players.find(player => player.observed && player.position);
  const lower = overview.lower && overview.lowerMax != null && observed?.position[2] < overview.lowerMax;
  const coordinate = position => position ? [(position[0] - overview.x) / (1024 * overview.scale), (overview.y - position[1]) / (1024 * overview.scale)] : null;
  const onLevel = position => !overview.lower || overview.lowerMax == null || (position[2] < overview.lowerMax) === Boolean(lower);
  const path = `/hud/radar/${mapId}${lower ? '_lower' : ''}.png`;
  if (el('radar-img').getAttribute('src') !== path) el('radar-img').src = path;
  const sites = radarMark(overview.a, 'radar-site', 'A') + radarMark(overview.b, 'radar-site', 'B');
  const grenades = (game.grenades ?? []).filter(grenade => onLevel(grenade.position))
    .map(grenade => radarMark(coordinate(grenade.position), `radar-grenade${grenade.type === 'smoke' ? '' : ' fire'}`)).join('');
  const markers = players.map(player => {
    if (!player.position || !player.health || !onLevel(player.position)) return '';
    const angle = player.forward ? 90 + Math.atan2(-player.forward[1], player.forward[0]) * 180 / Math.PI : null;
    const arrow = angle == null ? '' : `<span class="radar-heading" style="--heading:${angle.toFixed(1)}deg"></span>`;
    return radarMark(coordinate(player.position), `radar-dot side-${player.side.toLowerCase()}${player.observed ? ' is-observed' : ''}`,
      `${arrow}<span class="radar-face">${portrait(player, true)}</span>`);
  }).join('');
  const bomb = game.bomb;
  const bombMark = bomb?.position && ['planted', 'dropped'].includes(bomb.state) && onLevel(bomb.position)
    ? radarMark(coordinate(bomb.position), 'radar-dot radar-bomb', 'C4') : '';
  el('radar-marks').innerHTML = sites + grenades + markers + bombMark;
}

function renderStandby(state, match, final) {
  el('standby-message').textContent = final.winner ? 'Турнир завершён' : state.started ? 'Перерыв в эфире' : 'Скоро начнём';
  el('standby-detail').textContent = final.winner ? `Победители · ${final.winner.players.join(' и ')}`
    : match ? `${stageName(match.id)} · BO${match.bestOf}` : state.started ? 'Следите за сеткой турнира' : event.dateLabel;
  el('standby-match').hidden = !match || Boolean(final.winner);
  if (match) {
    for (const [i, id] of ['standby-left', 'standby-right'].entries()) {
      el(id).textContent = match.teams[i].tag;
      el(id).style.color = match.teams[i].color;
    }
  }
}

function render(state) {
  const matches = resolveMatches(event, state);
  const match = matches.find(match => match.id === state.active && match.teams.every(Boolean));
  if (standby) { renderStandby(state, match, matches.find(match => match.id === 'F1')); return; }

  const game = match ? state.game : null;
  const mapId = game?.mapId ?? (game?.map ? `de_${game.map.toLowerCase().replaceAll(' ', '_')}` : '');
  setTeams(match, game);
  el('ct').textContent = value(game?.ct);
  el('t').textContent = value(game?.t);
  const total = game ? game.ct + game.t : 0;
  const round = game ? Math.max(1, total + (['over', 'gameover'].includes(game.phase) ? 0 : 1)) : 0;
  const bomb = game?.bomb?.state === 'planted' || game?.phase === 'bomb';
  el('round-label').textContent = bomb ? 'Бомба установлена' : phases[game?.phase] ?? (round ? `ROUND ${round}${round <= 24 ? ' / 24' : ''}` : 'Ожидание');
  clockEnd = game?.clockEnd ?? null;
  el('clock').classList.toggle('is-bomb', bomb);
  updateClock();
  for (const side of ['ct', 't']) {
    const remaining = game?.timeouts?.[side] ?? 0;
    const marks = el(`${side}-wins`);
    marks.setAttribute('aria-label', `Тайм-ауты ${side.toUpperCase()}: ${remaining}`);
    marks.innerHTML = Array.from({ length: Math.max(3, Math.min(remaining, 5)) }, (_, i) => `<i${i < remaining ? ' class="won"' : ''}></i>`).join('');
  }
  showRadar(mapId, game);
  paintCards(game?.players ?? [], game?.phase === 'freezetime');
  showObserved(game?.players?.find(player => player.observed));
}

render(emptyState);
if (!standby) setInterval(updateClock, 150);
watchState(render, failed => { if (failed && !standby) render(emptyState); }, standby ? 1800 : 240);
