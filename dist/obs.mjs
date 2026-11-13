import { emptyState, readEvent, recordedSeriesScore, resolveMatches, safe, stageName, watchState } from './model.mjs';
import { paintResults } from './hud-results.mjs';

const el = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const standby = params.get('scene') === 'standby';
const desktop = params.get('surface') === 'desktop';
const phases = { warmup: 'Разминка', freezetime: 'Закуп', intermission: 'Смена сторон', halftime: 'Смена сторон',
  paused: 'Пауза', timeout_ct: 'Тайм-аут CT', timeout_t: 'Тайм-аут T', gameover: 'Карта завершена' };
const icons = {
  cross: '<path d="M6 0h4v6h6v4h-6v6H6v-6H0V6h6z"/>',
  aim: '<path d="M7 0h2v3h3v2h2v2h2v2h-2v2h-2v2H9v3H7v-3H4v-2H2V9H0V7h2V5h2V3h3zm1 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6"/>',
  skull: '<path d="M8 1c4 0 7 3 7 7 0 3-1 4-3 5v2H4v-2c-2-1-3-2-3-5 0-4 3-7 7-7M5 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4m6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4"/>',
  ammo: '<path d="M1 5l2-4 2 4v10H1zm5 0 2-4 2 4v10H6zm5 0 2-4 2 4v10h-4z"/>',
};
const icon = id => `<svg class="card-icon" viewBox="0 0 16 16" aria-hidden="true">${icons[id]}</svg>`;
const equipmentIcon = (id, cls = '') => `<img class="card-icon equipment-icon${cls ? ` ${cls}` : ''}" src="/hud/weapons/${id}.svg" alt="">`;
const dollars = value => `$${value.toLocaleString('en-US')}`;
const value = number => number ?? '–';
const roundResultMs = 4300;
const fragMs = 4100;
const exitMs = 280;
const bombLabels = { planting: 'Закладывают бомбу', planted: 'Бомба заложена', defusing: 'Обезвреживают',
  defused: 'Бомба обезврежена', exploded: 'Бомба взорвалась' };
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

async function optionalJson(url, fallback) {
  try {
    const response = await fetch(url);
    return response.ok ? await response.json() : fallback;
  } catch { return fallback; }
}

el('standby').hidden = !standby;
el('match-graphic').hidden = standby || desktop;
const [event, assets, media] = await Promise.all([
  readEvent(), optionalJson('/hud/assets.json', { maps: {}, weapons: [] }), optionalJson('/api/hud-media', {}),
]);
const weapons = new Set(assets.weapons);
let clockEnd = null;
let lastCamera = '';
let roundResult = null;
let previousGame = null;
let bombStatus = null;
let latestFrag = null;
let fragCard = null;
const cardNodes = new Map();
const radarNodes = new Map();
const avatarMarkup = new WeakMap();

function setText(node, text) {
  const next = String(text);
  if (node.textContent !== next) node.textContent = next;
}

function setMarkup(node, markup) {
  if (node.rendered === markup) return;
  node.innerHTML = markup;
  node.rendered = markup;
}

function pulse(node, name) {
  if (node.classList.contains(name)) {
    node.classList.remove(name);
    void node.offsetWidth;
  }
  node.classList.add(name);
}

function imagePath(path) {
  return typeof path === 'string' && /^\/hud-media\/[a-zA-Z0-9_-]+\.(png|jpe?g|webp)$/.test(path) ? path : '';
}

function cameraUrl(path) {
  try {
    const url = new URL(path);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function steamAvatarUrl(path) {
  if (typeof path !== 'string') return '';
  try {
    const url = new URL(path);
    const steamCdn = /^avatars(?:\.(?:akamai|cloudflare|fastly))?\.steamstatic\.com$/.test(url.hostname);
    return url.origin === `https://${url.hostname}` && !url.username && !url.password && steamCdn &&
      /^\/[a-f0-9]{40}(?:_medium|_full)?\.jpg$/i.test(url.pathname) ? url.origin + url.pathname : '';
  } catch { return ''; }
}

function avatar(player) {
  const cached = avatarMarkup.get(player);
  if (cached) return cached;
  const configured = Object.hasOwn(media, player.name) ? media[player.name] : null;
  const file = imagePath(configured?.avatar) || imagePath(configured?.portrait) || imagePath(player.avatar) || steamAvatarUrl(player.avatar);
  const seed = [...playerKey(player)].reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 0);
  const hue = seed % 360;
  const name = player.name.normalize('NFKC').trim();
  const words = name.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const first = value => graphemes.segment(value)[Symbol.iterator]().next().value?.segment ?? '';
  const monogram = words.length > 1 ? first(words[0]) + first(words[1])
    : [...graphemes.segment(words[0] ?? name)].slice(0, words.length ? 2 : 1).map(part => part.segment).join('');
  const initials = [...graphemes.segment(monogram.toUpperCase())].slice(0, 2).map(part => part.segment).join('') || '?';
  const markup = `<span class="player-avatar" aria-hidden="true">
    <svg class="avatar-fallback" viewBox="0 0 64 64">
      <path fill="hsl(${hue} 54% 24%)" d="M0 0h64v64H0z"/>
      <path fill="hsl(${hue} 57% 38%)" d="M0 45 45 0h19v10L10 64H0zm38 19 26-26v18l-8 8z"/>
      <path fill="none" stroke="#fff" opacity=".24" d="M4 4h12m44 56H48"/>
      <text x="32" y="42" fill="#fff" font-family="Segoe UI, sans-serif" font-size="27" font-weight="600" text-anchor="middle">${safe(initials)}</text>
    </svg>${file ? `<img class="avatar-image" src="${safe(file)}" referrerpolicy="no-referrer" alt="">` : ''}
  </span>`;
  avatarMarkup.set(player, markup);
  return markup;
}

el('match-graphic').addEventListener('error', event => {
  if (event.target instanceof HTMLImageElement && event.target.classList.contains('avatar-image')) event.target.hidden = true;
}, true);

function weapon(id, cls) {
  if (!id) return '';
  return weapons.has(id) ? `<img class="${cls}" src="/hud/weapons/${safe(id)}.svg" alt="${safe(id)}">`
    : `<span class="weapon-text">${safe(id.toUpperCase().replaceAll('_', '-'))}</span>`;
}

function armorMarkup(player, cls) {
  const vest = `<span class="armor-vest" aria-label="Бронежилет: ${value(player.armor)}">${equipmentIcon('kevlar')}${value(player.armor)}</span>`;
  const helmet = `<span class="armor-helmet${player.helmet ? '' : ' is-missing'}" aria-label="${player.helmet ? 'Шлем надет' : 'Шлема нет'}">${equipmentIcon('helmet')}</span>`;
  return `<span class="${cls}">${vest}${helmet}</span>`;
}

function paintCard(node, player) {
  const dead = player.health === 0;
  const hit = player.health != null && node.health != null && player.health < node.health;
  node.health = player.health;
  node.classList.toggle('is-out', dead);
  node.classList.toggle('is-observed', player.observed && !dead);
  node.classList.toggle('is-low', !dead && player.health != null && player.health <= 25);
  if (hit && !dead) pulse(node, 'is-hit');
  if (dead || (!hit && player.health === 100)) node.classList.remove('is-hit');
  const items = player.loadout;
  const gun = items?.primary || items?.pistol;
  const utility = items?.grenades.flatMap(grenade => Array(Math.min(2, grenade.count)).fill(grenade.id)).slice(0, 4) ?? [];
  const gear = utility.map(id => weapon(id, 'gear-icon')).join('');
  const status = items?.bomb ? `<span class="card-status carries-bomb">${weapon('c4', 'gear-icon')}</span>`
    : player.kit ? `<span class="card-status carries-kit" aria-label="Набор сапёра">${equipmentIcon('defuser', 'defuse-icon')}</span>` : '';
  const [head, stats, equipment] = node.children;
  const art = head.firstElementChild;
  setMarkup(art, avatar(player));
  const details = `${dead ? '' : `${status}<strong class="card-health" aria-label="${value(player.health)} HP">${value(player.health)}</strong>${armorMarkup(player, 'card-armor')}`}
    ${!dead && player.roundKills > 0 ? `<b class="card-streak" aria-label="Убийства в раунде">${player.roundKills}</b>` : ''}
    <b class="card-name">${safe(player.name)}</b>`;
  if (head.rendered !== details) {
    while (art.nextSibling) art.nextSibling.remove();
    art.insertAdjacentHTML('afterend', details);
    head.rendered = details;
  }
  setMarkup(stats, `<span aria-label="Убийства">${icon('aim')}</span><b>${value(player.kills)}</b><span aria-label="Смерти">${icon('skull')}</span><b>${value(player.deaths)}</b><b class="card-money" aria-label="Деньги">${value(player.money)}</b>`);
  setMarkup(equipment, dead ? `<span class="card-damage">Урон за раунд <b>${value(player.roundDamage)}</b></span>`
    : `${weapon(gun, 'weapon-icon')}<div class="card-utility">${gear}</div>`);
}

const playerKey = player => `${player.slot ?? player.side}:${player.name}`;

function paintCards(players, buying) {
  const visible = new Set();
  for (const side of ['CT', 'T']) {
    const roster = players.filter(player => player.side === side).slice(0, 5);
    const target = el(`cards-${side.toLowerCase()}`);
    target.dataset.size = roster.length;
    let economy = target.querySelector('.side-economy');
    if (!economy) {
      economy = document.createElement('div');
      economy.className = 'side-economy';
      target.prepend(economy);
    }
    economy.hidden = !buying || !roster.length || roster.some(player => player.equipmentValue == null);
    if (!economy.hidden) {
      const total = roster.reduce((sum, player) => sum + player.equipmentValue, 0);
      setMarkup(economy, `ЗАКУП ${side} <span>${dollars(total)}</span>`);
    }
    let previous = economy;
    for (const player of roster) {
      const key = playerKey(player);
      visible.add(key);
      let node = cardNodes.get(key);
      if (!node) {
        node = document.createElement('article');
        node.className = 'player-card';
        node.innerHTML = '<div class="card-head"><div class="card-art"></div></div><div class="card-kd"></div><div class="card-gear"></div><div class="player-frag" hidden></div>';
        cardNodes.set(key, node);
      }
      if (previous.nextElementSibling !== node) previous.after(node);
      paintCard(node, player);
      previous = node;
    }
  }
  for (const [key, node] of cardNodes) {
    if (visible.has(key)) continue;
    node.remove();
    cardNodes.delete(key);
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
  el('observer-art').hidden = Boolean(camera);
  if (!player) return;
  el('observer').className = `observer side-${player.side.toLowerCase()}`;
  const art = el('observer-art');
  const image = avatar(player);
  if (art.rendered !== image) {
    setMarkup(art, image);
    pulse(art, 'is-switching');
  }
  setText(el('observer-name'), player.name);
  setMarkup(el('observer-hp'), `<span aria-label="${value(player.health)} HP">${value(player.health)}</span>${armorMarkup(player, 'observer-armor')}`);
  const active = player.loadout?.active;
  setMarkup(el('observer-ammo'), active?.clip == null ? '' : `${active.clip}/${value(active.reserve)} ${icon('ammo')}`);
  const partial = player.totalDamage != null && player.damagePartial;
  const metrics = [
    ['У', 'Убийства', value(player.kills)], ['Асс.', 'Ассисты', value(player.assists)], ['С', 'Смерти', value(player.deaths)],
    ['Урон', partial ? 'Урон за раунды с доступными данными' : 'Урон за карту', partial ? `≥${player.totalDamage}` : value(player.totalDamage)],
  ];
  setMarkup(el('observer-match-stats'), metrics.map(([label, title, amount]) =>
    `<span title="${title}" aria-label="${title}: ${amount}"><b>${label}</b> <strong>${amount}</strong></span>`).join(''));
}

const formatClock = seconds => seconds == null ? '–:––' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

function updateClock() {
  const seconds = clockEnd == null ? null : Math.max(0, Math.ceil((clockEnd - Date.now()) / 1000));
  setText(el('clock'), formatClock(seconds));
  el('clock').classList.toggle('is-urgent', seconds != null && seconds <= 10 && !el('clock').classList.contains('is-bomb'));
}

function paintScoreboard(state, match, game) {
  const options = match && state.broadcast?.[match.id];
  const ctTeam = match?.teams.find(team => team.id === (game ? game.ctTeam : options?.ctTeam));
  const tTeam = ctTeam && match.teams.find(team => team !== ctTeam);
  const recorded = match && (match.score || Array.isArray(options?.mapResults));
  const seriesScore = recorded ? recordedSeriesScore(match, options) : null;
  const legacyWinners = recorded ? [] : Object.values(options?.mapWinners ?? {});
  const target = match ? (match.bestOf + 1) / 2 : 0;
  const namesBySide = {};
  for (const [side, team] of [['ct', ctTeam], ['t', tTeam]]) {
    const playing = (game?.players ?? []).filter(player => player.side.toLowerCase() === side).map(player => player.name);
    const names = playing.length ? playing.slice(0, 2) : team?.players ?? [side.toUpperCase()];
    namesBySide[side] = names;
    setMarkup(el(`team-${side}`), names.map(name => `<b title="${safe(name)}">${safe(name)}</b>`).join(''));
    const score = el(side);
    const next = game?.[side];
    if (next != null && score.roundScore != null && next > score.roundScore) pulse(score, 'is-updated');
    score.roundScore = next;
    setText(score, value(next));

    const marks = el(`${side}-wins`);
    marks.hidden = !target;
    marks.dataset.mapped = Boolean(team);
    const wins = team ? seriesScore?.[match.teams.indexOf(team)] ?? legacyWinners.filter(id => id === team.id).length : 0;
    marks.setAttribute('aria-label', team ? `BO${match.bestOf} · выиграно карт ${wins} из ${target}` : 'Счёт по картам ожидает привязки сторон');
    if (marks.children.length !== target) {
      marks.replaceChildren(...Array.from({ length: target }, () => document.createElement('i')));
    }
    for (const [i, mark] of [...marks.children].entries()) mark.classList.toggle('won', i < wins);
  }
  return namesBySide;
}

const percent = value => `${(value * 100).toFixed(2)}%`;
function showRadar(mapId, game) {
  const overview = Object.hasOwn(assets.maps, mapId) ? assets.maps[mapId] : null;
  el('radar').hidden = !overview;
  if (!overview) {
    el('radar-marks').replaceChildren();
    radarNodes.clear();
    return;
  }
  const players = game.players ?? [];
  const observed = players.find(player => player.observed && player.position);
  const lower = overview.lower && overview.lowerMax != null && observed?.position[2] < overview.lowerMax;
  const coordinate = position => position ? [(position[0] - overview.x) / (1024 * overview.scale), (overview.y - position[1]) / (1024 * overview.scale)] : null;
  const onLevel = position => !overview.lower || overview.lowerMax == null || (position[2] < overview.lowerMax) === Boolean(lower);
  const path = `/hud/radar/${mapId}${lower ? '_lower' : ''}.png`;
  if (el('radar-img').getAttribute('src') !== path) {
    el('radar-img').src = path;
    el('radar-marks').replaceChildren();
    radarNodes.clear();
  }
  const visible = new Set();
  function place(key, position, css, markup = '') {
    if (!position || position.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return null;
    visible.add(key);
    let node = radarNodes.get(key);
    if (!node) {
      node = document.createElement('span');
      el('radar-marks').append(node);
      radarNodes.set(key, node);
    }
    if (node.className !== css) node.className = css;
    node.style.left = percent(position[0]);
    node.style.top = percent(position[1]);
    setMarkup(node, markup);
    return node;
  }
  place('A', overview.a, 'radar-site', 'A');
  place('B', overview.b, 'radar-site', 'B');
  for (const [i, grenade] of (game.grenades ?? []).entries()) {
    if (onLevel(grenade.position)) place(`grenade:${i}`, coordinate(grenade.position), `radar-grenade${grenade.type === 'smoke' ? '' : ' fire'}`);
  }
  for (const player of players) {
    if (!player.position || !player.health || !onLevel(player.position)) continue;
    const angle = player.forward ? 90 + Math.atan2(-player.forward[1], player.forward[0]) * 180 / Math.PI : null;
    const marker = place(`player:${playerKey(player)}`, coordinate(player.position),
      `radar-dot side-${player.side.toLowerCase()}${player.observed ? ' is-observed' : ''}`,
      `<span class="radar-heading"></span><span class="radar-face">${avatar(player)}</span>`);
    if (marker) {
      marker.firstElementChild.hidden = angle == null;
      if (angle != null) marker.firstElementChild.style.setProperty('--heading', `${angle.toFixed(1)}deg`);
    }
  }
  const bomb = game.bomb;
  if (bomb?.position && ['planted', 'defusing', 'dropped'].includes(bomb.state) && onLevel(bomb.position)) {
    const marker = place('bomb', coordinate(bomb.position), 'radar-dot radar-bomb', 'C4');
    if (marker) marker.dataset.state = bomb.state;
  }
  for (const [key, marker] of radarNodes) {
    if (visible.has(key)) continue;
    marker.remove();
    radarNodes.delete(key);
  }
}

const roundReasons = { elimination: 'Все соперники устранены', time: 'Время вышло', exploded: 'Взрыв бомбы',
  defused: 'Бомба обезврежена', rescue: 'Заложники спасены' };

function paintEvents(now = Date.now()) {
  const roundPanel = el('round-result');
  const roundLeft = roundResult ? roundResultMs - (now - roundResult.at) : 0;
  roundPanel.hidden = roundLeft <= 0;
  if (!roundPanel.hidden) {
    if (roundPanel.eventId !== roundResult.id) {
      roundPanel.eventId = roundResult.id;
      roundPanel.className = `round-result side-${roundResult.side.toLowerCase()}`;
      pulse(roundPanel, 'is-entering');
    }
    const reason = roundReasons[roundResult.reason];
    setText(el('round-result-label'), `Победа в раунде ${roundResult.round}${reason ? ` · ${reason}` : ''}`);
    setText(el('round-result-name'), roundResult.names.join(' / '));
  }
  roundPanel.classList.toggle('is-leaving', roundLeft > 0 && roundLeft <= exitMs);

  const bombPanel = el('bomb-status');
  const terminal = ['defused', 'exploded'].includes(bombStatus?.state);
  const bombLeft = terminal ? roundResultMs - (now - bombStatus.at) : Infinity;
  bombPanel.hidden = !Object.hasOwn(bombLabels, bombStatus?.state) || bombLeft <= 0;
  if (!bombPanel.hidden) {
    const { id, state, site, player, actionEnd, fuseEnd, plantedAt, at } = bombStatus;
    const doing = state === 'planting' || state === 'defusing';
    const end = doing ? actionEnd : state === 'planted' ? fuseEnd : null;
    const start = doing ? at : plantedAt;
    if (bombPanel.eventId !== id) {
      bombPanel.eventId = id;
      bombPanel.dataset.state = state;
      pulse(bombPanel, 'is-entering');
    }
    setText(el('bomb-label'), bombLabels[state]);
    const detail = [site ? `Точка ${site}` : '', doing ? player : ''].filter(Boolean).join(' · ');
    setText(el('bomb-detail'), detail);
    el('bomb-detail').hidden = !detail;
    el('bomb-time').hidden = end == null;
    if (end != null) {
      const remaining = Math.max(0, end - now);
      setText(el('bomb-time'), doing ? `${(Math.ceil(remaining / 100) / 10).toFixed(1)} с` : formatClock(Math.ceil(remaining / 1000)));
    }
    const hasProgress = Number.isFinite(end) && Number.isFinite(start) && end > start;
    bombPanel.querySelector('.bomb-progress').hidden = !hasProgress;
    if (hasProgress) bombPanel.style.setProperty('--bomb-progress', Math.max(0, Math.min(1, (end - now) / (end - start))));
  }
  bombPanel.classList.toggle('is-leaving', bombLeft > 0 && bombLeft <= exitMs);

  if (!fragCard) return;
  const fragLeft = latestFrag ? fragMs - (now - latestFrag.at) : 0;
  fragCard.hidden = fragLeft <= 0;
  fragCard.classList.toggle('is-leaving', fragLeft > 0 && fragLeft <= exitMs);
  if (fragCard.hidden || fragCard.eventId === latestFrag.id) return;
  fragCard.eventId = latestFrag.id;
  const headshot = latestFrag.count === 1 && latestFrag.headshots === 1;
  const label = latestFrag.count > 1 ? `${latestFrag.count} фрага` : headshot ? 'Хедшот' : 'Фраг';
  const detail = latestFrag.victim || (latestFrag.roundKills > 1 ? `За раунд: ${latestFrag.roundKills}` : '');
  setMarkup(fragCard, `<span class="frag-count">${icon(headshot ? 'aim' : 'skull')}</span><span class="frag-copy"><b class="frag-label">${label}</b>${detail ? `<span class="frag-target">${safe(detail)}</span>` : ''}</span>`);
  pulse(fragCard, 'is-entering');
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

  const game = state.game;
  const observed = game?.players?.find(player => player.observed);
  if (!game || !previousGame || game.mapId !== previousGame.mapId || game.phase === 'warmup' ||
      game.ct + game.t < previousGame.ct + previousGame.t) roundResult = null;
  previousGame = game;
  const resultMatch = game?.matchId ? matches.find(item => item.id === game.matchId && item.teams.every(Boolean)) : match;
  const showingResults = paintResults(el('map-results'), game, resultMatch, state.broadcast?.[resultMatch?.id]);
  el('match-graphic').hidden = showingResults || (desktop && !game?.players?.length);
  if (el('match-graphic').hidden) {
    if (lastCamera) showObserved(null);
    return;
  }
  const mapId = game?.mapId ?? (game?.map ? `de_${game.map.toLowerCase().replaceAll(' ', '_')}` : '');
  const names = paintScoreboard(state, match, game);
  const total = game ? game.ct + game.t : 0;
  const round = game ? game.round ?? Math.max(1, game.roundResult?.round ?? (total + (game.phase === 'over' ? 0 : 1))) : 0;
  bombStatus = game?.bomb;
  const bomb = ['planted', 'defusing'].includes(bombStatus?.state) || ['bomb', 'defuse'].includes(game?.phase);
  const roundText = round ? `Раунд ${round}${round <= 24 ? ' / 24' : ''}` : '';
  const phase = phases[game?.phase];
  const showRound = Boolean(roundText) && game?.phase !== 'warmup';
  el('round-label').hidden = !showRound && Boolean(phase);
  setText(el('round-label'), showRound ? roundText : 'Ожидание');
  el('phase-label').hidden = !phase;
  setText(el('phase-label'), phase ?? '');
  clockEnd = bomb && bombStatus?.fuseEnd ? bombStatus.fuseEnd : game?.clockEnd ?? null;
  el('clock').classList.toggle('is-bomb', bomb);
  el('bomb-icon').innerHTML ||= weapon('c4', 'gear-icon');
  updateClock();
  showRadar(mapId, game);
  paintCards(game?.players ?? [], game?.buying ?? game?.phase === 'freezetime');
  showObserved(observed);

  if (game?.roundResult) roundResult = { ...game.roundResult, names: names[game.roundResult.side.toLowerCase()] };
  const nextCard = observed && cardNodes.get(playerKey(observed))?.querySelector('.player-frag');
  if (fragCard && fragCard !== nextCard) fragCard.hidden = true;
  fragCard = nextCard;
  latestFrag = observed && game?.frags?.findLast(frag => frag.side === observed.side && frag.slot === observed.slot && frag.name === observed.name);
  paintEvents();
}

render(emptyState);
if (!standby) setInterval(() => { updateClock(); paintEvents(); }, 100);
watchState(render, failed => { if (failed && !standby) render(emptyState); }, standby ? 1800 : 240);
