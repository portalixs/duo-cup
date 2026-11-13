import { recordedSeriesScore, safe } from './model.mjs';

const stat = n => Number.isSafeInteger(n) && n >= 0 ? n : '–';
const statOrder = n => Number.isSafeInteger(n) && n >= 0 ? n : -1;

function roster(players, side, team) {
  const rows = players.filter(player => player.side === side);
  if (rows.length) return rows.sort((a, b) => statOrder(b.kills) - statOrder(a.kills) ||
    statOrder(b.assists) - statOrder(a.assists) || statOrder(b.deaths) - statOrder(a.deaths)).slice(0, 5);
  return (team?.players ?? []).map(name => ({ name }));
}

function teamPanel(side, players, team, score, won) {
  const names = players.slice(0, 2).map(player => player.name);
  const teamName = names.length ? names.join(' / ') : team?.tag ?? side;
  const rows = players.map(player => {
    const damage = stat(player.totalDamage);
    const partial = damage !== '–' && player.damagePartial;
    return `<tr><th scope="row" title="${safe(player.name)}">${safe(player.name)}</th><td>${stat(player.kills)}</td><td>${stat(player.assists)}</td><td>${stat(player.deaths)}</td><td>${damage}${partial ? '<sup aria-label="Неполные данные">*</sup>' : ''}</td></tr>`;
  }).join('');
  const hasTotal = players.length && players.every(player => statOrder(player.totalDamage) >= 0 && !player.damagePartial);
  const total = hasTotal ? `<tfoot><tr><th scope="row" colspan="4">Урон команды</th><td>${players.reduce((sum, player) => sum + player.totalDamage, 0)}</td></tr></tfoot>` : '';
  return `<section class="result-team result-team-${side.toLowerCase()}${won ? ' result-team-won' : ''}">
    <header class="result-team-header">
      <div class="result-team-label"><span>${side}${won ? ' · Победители' : ''}</span><b title="${safe(teamName)}">${safe(teamName)}</b></div>
      <strong class="result-score">${stat(score)}</strong>
    </header>
    <table class="result-stats" aria-label="Статистика ${side}">
      <thead><tr><th scope="col">Игрок</th><th scope="col" aria-label="Убийства" title="Убийства">У</th><th scope="col" aria-label="Помощь" title="Помощь">Асс.</th><th scope="col" aria-label="Смерти" title="Смерти">С</th><th scope="col" title="Урон за карту">Урон</th></tr></thead>
      <tbody>${rows || '<tr><td class="result-no-stats" colspan="5">Статистика недоступна</td></tr>'}</tbody>${total}
    </table>
  </section>`;
}

function seriesSummary(game, match, options, ctTeam, tTeam) {
  if (!ctTeam || !tTeam || match.bestOf <= 1) return '';
  let seriesScore;
  if (match.score || Array.isArray(options?.mapResults)) {
    seriesScore = recordedSeriesScore(match, options);
  } else {
    const wins = { ...options?.mapWinners };
    if (game.mapId && game.ct !== game.t) wins[game.mapId] = game.ct > game.t ? ctTeam.id : tTeam.id;
    const winners = Object.values(wins);
    seriesScore = match.teams.map(team => winners.filter(id => id === team.id).length);
  }
  const ct = seriesScore[match.teams.indexOf(ctTeam)];
  const t = seriesScore[match.teams.indexOf(tTeam)];
  const decidingScore = Math.floor(match.bestOf / 2) + 1;
  const seriesWinner = Math.max(ct, t) >= decidingScore && ct !== t ? (ct > t ? ctTeam : tTeam) : null;
  const label = seriesWinner ? 'Победа в серии' : 'Счёт серии';
  const winnerTag = seriesWinner ? `<span class="result-series-${ct > t ? 'ct' : 't'}" title="${safe(seriesWinner.players.join(' / '))}">${safe(seriesWinner.tag)}</span>` : '';
  return `<span class="result-series">${label}${winnerTag} <b><span class="result-series-ct">${ct}</span><span aria-hidden="true">:</span><span class="result-series-t">${t}</span></b></span>`;
}

export function paintResults(root, game, match, options) {
  if (game?.phase !== 'gameover') {
    root.hidden = true;
    return false;
  }

  const players = game.players ?? [];
  const ctTeam = match?.teams.find(team => team?.id === game.ctTeam);
  const tTeam = ctTeam && match.teams.find(team => team && team !== ctTeam);
  const ctPlayers = roster(players, 'CT', ctTeam);
  const tPlayers = roster(players, 'T', tTeam);
  const series = seriesSummary(game, match, options, ctTeam, tTeam);
  const mapName = game.map || 'CS2';
  const bestOf = match?.bestOf ? `<span class="result-format">BO${stat(match.bestOf)}</span>` : '';
  const damagePartial = game.damagePartial || players.some(player => player.damagePartial);
  const partialNote = damagePartial ? '<p class="result-note">* Урон указан за раунды, по которым получены данные</p>' : '';
  const markup = `<article class="result-board">
    <header class="result-header">
      <div class="result-title"><h1 id="map-results-title">Итоги карты</h1><span>${safe(mapName)}</span></div>
      <div class="result-context">${game.ct === game.t ? '<span class="result-draw">Ничья</span>' : ''}${bestOf}${series}</div>
    </header>
    <div class="result-teams">${teamPanel('CT', ctPlayers, ctTeam, game.ct, game.ct > game.t)}${teamPanel('T', tPlayers, tTeam, game.t, game.t > game.ct)}</div>
    ${partialNote}
  </article>`;
  if (root.rendered !== markup) {
    root.innerHTML = markup;
    root.rendered = markup;
  }
  root.hidden = false;
  return true;
}
