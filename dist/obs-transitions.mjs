import { recordedSeriesScore } from './model.mjs';

const broadcastPhases = new Set(['freezetime', 'halftime', 'intermission']);
const midBreakPhases = new Set(['halftime', 'intermission']);
const displayMs = 2350;
const exitMs = 220;

const teamLabels = team => ({ tag: team.tag, names: team.players.join(' / ') });

function completedRounds(game) {
  return Number.isSafeInteger(game?.ct) && Number.isSafeInteger(game?.t) ? game.ct + game.t : null;
}

function roundAnnouncement(game, match, options, score, name, sideChangeShown, sidesChanged) {
  const total = completedRounds(game);
  if (total == null) return null;

  if (total === 0 && game.phase === 'freezetime') {
    const index = options?.maps?.indexOf(game.mapId) ?? -1;
    if (match && options?.maps?.length && index !== (options.mapResults?.length ?? 0)) return null;
    const deciding = match?.bestOf > 1 && score?.every(wins => wins === Math.floor(match.bestOf / 2));
    const label = deciding ? 'Решающая карта' : index < 0 ? 'Начало карты' : `Карта ${index + 1} из ${match.bestOf}`;
    return { kind: 'opening', label, title: name, detail: 'Пистолетный раунд', score, context: score ? 'Счёт серии' : '' };
  }

  const overtimeSwap = total >= 27 && (total - 27) % 6 === 0;
  if ((total === 12 || overtimeSwap) && midBreakPhases.has(game.phase)) {
    return { kind: `swap-${total}`, label: name, title: 'Смена сторон', score: [game.ct, game.t], context: 'Счёт по раундам' };
  }
  if (total === 12 && game.phase === 'freezetime') {
    return { kind: 'pistol', label: `${name} · Раунд 13`, title: 'Пистолетный раунд',
      detail: sideChangeShown ? 'Начало второй половины' : 'После смены сторон',
      score: [game.ct, game.t], context: 'Счёт по раундам' };
  }
  if (overtimeSwap && sidesChanged && game.phase === 'freezetime') {
    return { kind: `swap-${total}`, label: name, title: 'Смена сторон', score: [game.ct, game.t], context: 'Счёт по раундам' };
  }
  if (total >= 24 && (total - 24) % 6 === 0 && game.ct === game.t && game.phase === 'freezetime') {
    const overtime = (total - 24) / 6 + 1;
    return { kind: `ot-${overtime}`, label: `${name} · Раунд ${total + 1}`, title: `Овертайм №${overtime}`,
      score: [game.ct, game.t], context: 'Счёт по раундам' };
  }
  return null;
}

function sideNames(match, game) {
  const ct = match?.teams.find(team => team?.id === game?.ctTeam);
  const t = ct && match.teams.find(team => team && team !== ct);
  return ['CT', 'T'].map((side, i) => {
    const playerNames = (game?.players ?? []).filter(player => player.side === side).slice(0, 2).map(player => player.name);
    const team = i === 0 ? ct : t;
    return { tag: team?.tag ?? side, names: playerNames.length ? playerNames.join(' / ') : team?.players.join(' / ') ?? '' };
  });
}

function makeTransition() {
  const node = document.createElement('aside');
  node.className = 'obs-transition';
  node.setAttribute('aria-label', 'Событие матча');
  node.hidden = true;
  node.innerHTML = `<div class="obs-transition-card">
    <div class="obs-transition-hero">
      <div class="obs-transition-overline"></div>
      <div class="obs-transition-title"></div>
      <div class="obs-transition-detail"></div>
    </div>
    <div class="obs-transition-score">
      <div class="obs-transition-team obs-transition-blue"><b></b><span></span></div>
      <div class="obs-transition-count"><strong></strong><span></span></div>
      <div class="obs-transition-team obs-transition-red"><b></b><span></span></div>
    </div>
  </div>`;
  document.body.append(node);
  return node;
}

export function createObsTransitions({ onFinish, mapName }) {
  const node = makeTransition();
  const label = node.querySelector('.obs-transition-overline');
  const title = node.querySelector('.obs-transition-title');
  const detail = node.querySelector('.obs-transition-detail');
  const panel = node.querySelector('.obs-transition-score');
  const count = panel.querySelector('.obs-transition-count');
  const teams = [...panel.querySelectorAll('.obs-transition-team')];
  const seen = new Set();
  let identity;
  let previous;
  let current;
  let active;
  let pendingFinish;
  let knife;
  let timer;
  let exitTimer;

  function hide(notify = false) {
    const wasFinish = active === 'finish';
    clearTimeout(timer);
    clearTimeout(exitTimer);
    exitTimer = null;
    node.hidden = true;
    active = null;
    if (notify && wasFinish) onFinish?.();
  }

  function leave() {
    if (!active || exitTimer) return;
    node.classList.add('is-leaving');
    exitTimer = setTimeout(() => {
      exitTimer = null;
      hide(true);
    }, exitMs);
  }

  function show(announcement, sides, duration = displayMs) {
    hide();
    active = announcement.kind;
    label.textContent = announcement.label;
    title.textContent = announcement.title;
    detail.textContent = announcement.detail ?? '';
    detail.hidden = !announcement.detail;
    panel.hidden = !sides;
    if (sides) {
      count.querySelector('strong').textContent = announcement.score?.join(' : ') ?? 'VS';
      count.querySelector('span').textContent = announcement.context ?? '';
      count.querySelector('span').hidden = !announcement.context;
      teams.forEach((team, i) => {
        team.querySelector('b').textContent = sides[i].tag;
        team.querySelector('span').textContent = sides[i].names;
      });
    }
    node.dataset.kind = announcement.kind;
    node.classList.remove('is-leaving');
    node.hidden = false;
    timer = setTimeout(leave, duration);
  }

  function update(state, match, options, game, replaying = false) {
    current = { match, game, replaying };
    if (!game?.mapId) {
      if (active !== 'knife' || replaying || !match) hide();
      pendingFinish = null;
      previous = null;
      return false;
    }

    const matchId = game.matchId ?? match?.id;
    const nextIdentity = `${matchId ?? ''}/${game.mapId}`;
    const total = completedRounds(game);
    const changed = nextIdentity !== identity;
    const restarted = !changed && total === 0 && completedRounds(previous) > 0
      && (game.phase === 'warmup' || game.phase === 'freezetime');
    if (changed || restarted) {
      seen.clear();
      pendingFinish = null;
      if (knife?.matchId !== matchId || restarted) knife = null;
      if (active !== 'knife' || !knife) hide();
    }
    const prior = previous;
    previous = game;
    identity = nextIdentity;
    const name = mapName(game.mapId, game.map);

    if (game.phase === 'gameover') {
      const finishesNow = !changed && prior?.phase !== 'gameover' && completedRounds(prior) != null;
      if (finishesNow && !seen.has('finish')) {
        seen.add('finish');
        pendingFinish = { kind: 'finish', label: name, title: 'Карта завершена', score: [game.ct, game.t],
          context: 'Финальный счёт', detail: game.ct === game.t ? 'Ничья' : undefined };
        const sides = sideNames(match, game);
        const confirmed = match?.winner;
        if (confirmed) pendingFinish.detail = `Победа в серии · ${confirmed.players.join(' / ')}`;
        else if (game.ct !== game.t) pendingFinish.detail = `Победа на карте · ${sides[Number(game.t > game.ct)].tag}`;
      }
      if (replaying) {
        hide();
        return false;
      }
      if (pendingFinish) {
        show(pendingFinish, sideNames(match, game), 2100);
        pendingFinish = null;
      }
      return active === 'finish';
    }

    pendingFinish = null;
    if (replaying) {
      hide();
      return false;
    }
    if (knife && game.phase === 'live') knife.played = true;
    if (knife?.played && ['warmup', 'freezetime'].includes(game.phase)) {
      knife = null;
      if (active === 'knife') hide();
    }
    if (!broadcastPhases.has(game.phase)) {
      if (active && active !== 'knife') leave();
      return false;
    }

    const score = match && (state.seriesScores?.[match.id] ?? recordedSeriesScore(match, options));
    const sidesChanged = !changed && game.ctTeam && prior?.ctTeam && game.ctTeam !== prior.ctTeam;
    const announcement = roundAnnouncement(game, match, options, score, name, seen.has('swap-12'), sidesChanged);
    if (!announcement || seen.has(announcement.kind) || (announcement.kind === 'opening' && knife)) return false;
    const remaining = game.clockEnd == null || midBreakPhases.has(game.phase) ? displayMs : game.clockEnd - Date.now() - exitMs;
    if (remaining < 600) return false;
    seen.add(announcement.kind);
    let sides = sideNames(match, game);
    if (announcement.kind === 'opening' && match) {
      const ctIndex = match.teams.findIndex(team => team.id === game.ctTeam);
      const sideOrder = ctIndex === 1 ? [1, 0] : [0, 1];
      sides = sideOrder.map(index => teamLabels(match.teams[index]));
      announcement.score = sideOrder.map(index => score[index]);
    }
    show(announcement, sides, Math.min(displayMs, remaining));
    return false;
  }

  function showKnife() {
    const { match, game, replaying } = current ?? {};
    if (replaying || !match || (game && (game.phase === 'gameover' || completedRounds(game) > 0))) return false;
    knife = { matchId: match.id, played: game?.phase === 'live' };
    if (active === 'opening') seen.delete('opening');
    const name = game?.mapId ? mapName(game.mapId, game.map) : '';
    show({ kind: 'knife', label: name, title: 'Ножевой раунд', detail: 'Выбор стороны' },
      match.teams.map(teamLabels));
    return true;
  }

  return { update, showKnife };
}
