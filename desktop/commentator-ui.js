'use strict';

const api = window.commentator;
const element = id => document.getElementById(id);
const form = element('settings');
const views = [...document.querySelectorAll('.view')];
const buttons = [...document.querySelectorAll('[data-action]')];
const sourceList = element('source-list');
const scenes = new Map([
  ['sceneStandby', '01 · Ожидание и перерыв'],
  ['sceneMatch', '02 · Матч CS2'],
  ['sceneWait', '03 · Ожидание матча'],
  ['sceneChange', '04 · Смена карты'],
]);
const phaseNames = {
  warmup: 'разминка', freezetime: 'закуп', live: 'идёт раунд', over: 'конец раунда', gameover: 'карта завершена',
};
let snapshot;
let pending = '';
let changed = false;
let refreshing;
let sourcePort;

function notice(message, tone = 'good') {
  const node = element('notice');
  node.textContent = message;
  node.dataset.tone = tone;
  node.hidden = !message;
}

function status(id, message, tone = 'idle') {
  const node = element(id);
  node.dataset.tone = tone;
  node.textContent = message;
}

function selectView(id, focus) {
  for (const view of views) view.hidden = view.id !== id;
  for (const button of document.querySelectorAll('.nav button')) {
    if (button.dataset.view === id) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
  if (focus) element(focus).focus();
}

function fillForm(settings, cs2) {
  element('site-url').value = settings.siteUrl || '';
  element('publish-key').value = '';
  element('publish-key').placeholder = settings.hasPublishKey ? 'Ключ сохранён' : 'Ключ publish';
  element('obs-port').value = settings.obsPort || 4455;
  element('obs-password').value = '';
  element('obs-password').placeholder = settings.hasObsPassword ? 'Пароль сохранён' : 'Пароль из OBS';
  element('obs-collection').value = settings.obsCollection === 'DUO CUP · CS2 4K' ? settings.obsCollection : 'DUO CUP · CS2';
  element('clear-obs').checked = false;
  element('clear-publish').checked = false;
  element('cs2-path').value = settings.cs2Path || cs2.detectedPath || '';
}

function settingsValues() {
  return {
    siteUrl: element('site-url').value.trim(),
    publishKey: element('publish-key').value.trim(),
    obsPort: Number(element('obs-port').value),
    obsPassword: element('obs-password').value,
    obsCollection: element('obs-collection').value,
    cs2Path: element('cs2-path').value.trim(),
    clearObsPassword: element('clear-obs').checked,
    clearPublishKey: element('clear-publish').checked,
  };
}

function renderSources(port) {
  if (port === sourcePort) return;
  sourcePort = port;
  const sources = [
    ['Графика матча', ''], ['Заставка', '?scene=standby'], ['Ожидание матча', '?scene=match-wait'],
    ['Смена карты', '?scene=map-change'], ['Плашка повтора', '?scene=replay'],
  ];
  sourceList.replaceChildren(...sources.map(([title, query]) => {
    const url = `http://127.0.0.1:${port}/obs${query}`;
    const row = document.createElement('div');
    const label = document.createElement('dt');
    const copy = document.createElement('dd');
    const code = document.createElement('code');
    const button = document.createElement('button');
    label.textContent = title;
    code.textContent = url;
    button.type = 'button';
    button.className = 'text-button';
    button.textContent = 'Копировать';
    button.setAttribute('aria-label', `Копировать адрес «${title}»`);
    button.addEventListener('click', () => copyValue(url, 'Адрес источника скопирован.'));
    copy.append(code, button);
    row.append(label, copy);
    return row;
  }));
}

function renderFirstRun({ settings, service, obs, cs2, appControl, hasCs2Path, siteConnected, siteRejected }) {
  const serviceBlocked = service.occupied || (service.running && !service.owned) || service.restartRequired;
  const profileNeeded = obs.profileReady === false;
  const collectionNeedsSelection = obs.scenesReady && Array.isArray(obs.availableScenes) && !obs.availableScenes.includes('05 · Повтор');
  const localReady = appControl && cs2.configured && obs.installed && obs.scenesReady && !profileNeeded;
  status('check-service', appControl ? 'Работает' : service.restartRequired ? 'Нужен перезапуск' : serviceBlocked ? 'Порт 8787 занят' : 'Остановлена',
    appControl ? 'good' : serviceBlocked ? 'warning' : 'idle');
  status('check-game', cs2.configured ? 'Установлены' : hasCs2Path ? 'Нужна установка' : 'Игра не найдена',
    cs2.configured ? 'good' : 'warning');
  status('check-obs', obs.installed ? 'Установлен' : 'Нужна установка', obs.installed ? 'good' : 'warning');
  status('check-scenes', collectionNeedsSelection ? 'Нужно выбрать' : obs.scenesReady ? 'Добавлены' : 'Нужна подготовка',
    obs.scenesReady && !collectionNeedsSelection ? 'good' : 'warning');
  status('check-websocket', obs.connected ? 'Подключено' : 'Ожидает связи', obs.connected ? 'good' : 'idle');
  status('check-buffer', obs.bufferActive ? 'Запущен' : obs.bufferAvailable === false ? 'Выключен в OBS' : 'Ожидает запуска',
    obs.bufferActive ? 'good' : obs.bufferAvailable === false ? 'warning' : 'idle');
  element('check-site-row').hidden = !settings.siteUrl;
  status('check-site', siteConnected ? 'Подключён' : siteRejected ? 'Ключ отклонён' : settings.hasPublishKey ? 'Ожидает связи' : 'Нужен ключ',
    siteConnected ? 'good' : siteRejected || !settings.hasPublishKey ? 'warning' : 'idle');

  const needsPreparation = !cs2.configured || !obs.installed || !obs.scenesReady || profileNeeded;
  element('first-run-entry').hidden = !needsPreparation;
  element('launch-broadcast').classList.toggle('primary', !needsPreparation);
  element('first-run-action').textContent = pending === 'setupFirstRun' ? 'Подготавливаем…'
    : !obs.installed ? 'Подготовить и установить OBS' : 'Подготовить рабочее место';
  element('first-run-hint').textContent = localReady ? 'Служба, конфиги CS2 и коллекции готовы.'
    : 'Запустим службу, установим конфиги игры и подготовим сцены OBS. Если OBS ещё нет, откроется его установщик.';

  const next = [];
  if (changed) next.push('Сохраните изменения ниже, чтобы запустить подготовку.');
  if (serviceBlocked) next.push('Закройте отдельный экземпляр start.cmd, если он занимает порт 8787.');
  if (!hasCs2Path) next.push('Установите CS2 через Steam или укажите папку игры ниже.');
  if (obs.running && (!obs.scenesReady || profileNeeded)) {
    next.push('Закройте OBS и повторите подготовку, чтобы применить настройки и добавить сцены.');
  } else if (obs.installed && !obs.running && obs.scenesReady) {
    next.push('Запустите OBS из пульта.');
  } else if (obs.running && !obs.connected) {
    next.push('Включите WebSocket в OBS и сохраните его пароль ниже.');
  } else if (collectionNeedsSelection) {
    next.push('Выберите коллекцию DUO CUP в OBS или перезапустите OBS из пульта.');
  } else if (obs.connected && !obs.bufferActive) {
    next.push(obs.bufferAvailable === false ? 'Включите буфер повтора в настройках вывода OBS.'
      : 'На вкладке «Эфир» нажмите «Запустить буфер».');
  }
  if (cs2.configured && !service.gsi) next.push('После установки конфигов перезапустите CS2 и зайдите наблюдателем.');
  if (settings.siteUrl && (!settings.hasPublishKey || siteRejected)) next.push('Сохраните ключ publish, выданный организатором.');
  element('first-run-next').hidden = !next.length;
  element('first-run-next').textContent = next.join(' ');
}

function render() {
  if (!snapshot) return;
  const { settings = {}, service = {}, obs = {}, cs2 = {}, hud = {}, paths = {} } = snapshot;
  const appControl = service.running && service.owned && service.compatible !== false && !service.restartRequired;
  const hasCs2Path = Boolean(settings.cs2Path || cs2.detectedPath);
  const availableScenes = Array.isArray(obs.availableScenes) ? new Set(obs.availableScenes) : null;
  const hasReplayScene = !availableScenes || availableScenes.has('05 · Повтор');
  const detected = service.gsi && service.game;
  const port = service.port || 8787;
  const mayKnife = !service.game || (service.game.phase !== 'gameover' && Number(service.game.ct || 0) + Number(service.game.t || 0) === 0);

  const externalService = service.running && !service.owned;
  status('top-status', service.occupied ? 'Порт занят' : service.restartRequired ? 'Нужен перезапуск' : service.running ? 'Служба работает' : 'Служба остановлена',
    service.occupied ? 'error' : service.restartRequired ? 'warning' : service.running ? 'good' : 'idle');
  element('hero-detail').textContent = service.restartRequired || externalService ? 'Закройте старое окно start.cmd и запустите службу здесь.'
    : service.running ? 'Откройте CS2, зайдите наблюдателем и выберите сцену.' : service.error || 'Запустите локальную службу для HUD и источников OBS.';
  const serviceButton = element('service-control');
  serviceButton.dataset.action = service.running ? 'stopService' : 'startService';
  serviceButton.textContent = service.running ? (service.owned ? 'Остановить службу' : 'Служба запущена отдельно') : 'Запустить службу';
  status('cs2-tone', detected ? 'Сигнал есть' : cs2.configured ? 'Готово' : 'Настройка', detected ? 'good' : cs2.configured ? 'idle' : 'warning');
  element('cs2-state').textContent = detected ? [service.game.map || 'Карта загружена', phaseNames[service.game.phase]].filter(Boolean).join(' · ')
    : cs2.configured ? 'Конфиги установлены. Ожидаем матч.' : 'Установите конфиги в разделе «Настройка».';

  status('obs-tone', obs.connected ? 'Подключено' : obs.installed ? 'Ожидание' : 'Установка', obs.connected ? 'good' : 'idle');
  element('obs-state').textContent = obs.connected ? (obs.bufferActive ? 'Буфер повтора работает.'
    : obs.bufferAvailable === false ? 'WebSocket подключён. Буфер повтора выключен в настройках OBS.' : 'WebSocket подключён. Буфер остановлен.')
    : obs.installed ? (obs.running ? 'Проверьте WebSocket и пароль.' : 'Откройте OBS и включите WebSocket.') : 'Установите OBS Studio для захвата игры.';
  const obsButton = element('obs-launch');
  obsButton.dataset.action = obs.installed ? 'launchObs' : 'installObs';
  obsButton.textContent = obs.installed ? 'Открыть OBS' : 'Установить OBS';

  const siteConnected = service.publishStatus === 'Сайт синхронизирован';
  const siteMissingKey = settings.siteUrl && !settings.hasPublishKey;
  const siteRejected = service.publishStatus?.includes('Неверный ключ наблюдателя');
  renderFirstRun({ settings, service, obs, cs2, appControl, hasCs2Path, siteConnected, siteRejected });
  status('site-tone', siteConnected ? 'Подключён' : siteRejected ? 'Ключ отклонён' : siteMissingKey ? 'Нужен ключ' : settings.siteUrl ? 'Ожидание' : 'Локально',
    siteConnected ? 'good' : siteRejected || siteMissingKey ? 'warning' : 'idle');
  element('site-state').textContent = !settings.siteUrl ? 'Локальная проверка без сайта.'
    : siteMissingKey ? 'Укажите ключ publish с сервера турнира.' : service.publishStatus || settings.siteUrl;
  element('scenes-hint').textContent = !obs.connected ? 'Для переключения сцен подключите OBS WebSocket.'
    : availableScenes && [...scenes.values()].some(scene => !availableScenes.has(scene)) ? 'Откройте коллекцию DUO CUP со всеми сценами.'
      : 'Выбранная сцена сразу появится в программе OBS.';
  element('hud-state').textContent = hud.running ? 'HUD включён. Сочетание Ctrl+Shift+F10 управляет видимостью.' : 'Графика поверх окна игры на экране наблюдателя.';
  element('hud-toggle').textContent = hud.running ? 'Закрыть HUD' : 'Запустить HUD';

  const replayButton = element('replay-toggle');
  replayButton.dataset.action = obs.replayEnabled ? 'replayDisable' : 'replayEnable';
  replayButton.setAttribute('aria-pressed', String(Boolean(obs.replayEnabled)));
  replayButton.textContent = obs.replayEnabled ? 'Выключить' : 'Включить';
  element('replay-state').textContent = obs.replayPlaying ? 'Повтор в эфире.' : obs.error || (!hasReplayScene ? 'Откройте коллекцию DUO CUP со сценой «05 · Повтор».'
    : obs.replayEnabled ? 'Лучший фраг раунда будет показан автоматически.'
      : obs.bufferActive ? 'Буфер готов к автоматическим повторам.' : 'Запустите буфер повтора перед матчем.');

  element('clear-publish-label').hidden = !settings.hasPublishKey;
  element('clear-obs-label').hidden = !settings.hasObsPassword;
  for (const input of form.querySelectorAll('input, select')) input.disabled = Boolean(pending);
  element('publish-key').disabled = Boolean(pending) || element('clear-publish').checked;
  element('obs-password').disabled = Boolean(pending) || element('clear-obs').checked;
  element('cs2-detected').textContent = cs2.detectedPath ? `Steam нашёл игру: ${cs2.detectedPath}` : 'Укажите папку, в которой находятся файлы игры.';
  element('obs-setup-hint').textContent = obs.scenesReady ? 'Коллекции DUO CUP готовы.' : 'Для добавления коллекций закройте OBS.';
  element('save-settings').disabled = Boolean(pending) || !changed;
  element('choose-cs2').disabled = Boolean(pending);
  element('copy-hud-command').disabled = Boolean(pending);
  element('service-diagnostic').textContent = service.error || (service.running ? `Локальная служба отвечает на порту ${port}.` : 'Локальная служба остановлена.');
  element('runtime-path').textContent = paths.runtime || '';
  renderSources(port);

  for (const button of buttons) {
    const action = button.dataset.action;
    let permitted;
    if (scenes.has(action)) {
      permitted = obs.connected && (!availableScenes || availableScenes.has(scenes.get(action)));
      button.setAttribute('aria-pressed', String(obs.currentScene === scenes.get(action)));
    } else {
      permitted = {
        launchBroadcast: obs.installed && !service.occupied && !externalService && !service.restartRequired,
        setupFirstRun: !service.occupied && !externalService && !service.restartRequired && !changed,
        startService: !service.running && !service.occupied, stopService: service.owned, openControl: true,
        launchCs2: true, launchObs: obs.installed, installObs: true, toggleHud: hud.running || service.running,
        replayEnable: appControl && obs.connected && obs.bufferActive && hasReplayScene, replayDisable: appControl,
          startReplayBuffer: obs.connected && obs.bufferAvailable !== false && !obs.bufferActive,
          knife: appControl && Boolean(service.active) && mayKnife && !obs.replayPlaying,
        installCs2: appControl && hasCs2Path && !changed,
        setupObsScenes: obs.installed && obs.running !== true && !obs.connected, openObsScenes: true,
        openLogs: true, openRuntime: true, openObsGuide: true,
      }[action];
    }
    button.disabled = Boolean(pending) || !permitted;
  }
}

async function refresh({ fill = false, showError = false } = {}) {
  if (refreshing) {
    await refreshing;
    if (!fill && !showError) return;
  }
  const request = (async () => {
    try {
      const next = await api.getStatus();
      if (!snapshot || fill) fillForm(next.settings || {}, next.cs2 || {});
      snapshot = next;
      render();
    } catch (error) {
      if (showError || !snapshot) notice(error.message, 'error');
    }
  })();
  refreshing = request;
  await request;
  if (refreshing === request) refreshing = null;
}

async function run(name, operation, { save = false, success = '' } = {}) {
  if (pending) return;
  pending = name;
  render();
  try {
    const result = await operation();
    if (save) changed = false;
    notice(result?.message || success);
    await refresh({ fill: save, showError: true });
  } catch (error) {
    notice(error.message, 'error');
  } finally {
    pending = '';
    render();
  }
}

async function copyValue(value, message) {
  try { await api.copy(value); notice(message); }
  catch (error) { notice(error.message, 'error'); }
}

for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => selectView(button.dataset.view, button.dataset.focus));
}
for (const button of buttons) {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    return run(action, () => api.action(action), { save: action === 'setupFirstRun' });
  });
}
form.addEventListener('input', () => { changed = true; render(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  void run('settings', () => api.saveSettings(settingsValues()), { save: true, success: 'Настройки сохранены.' });
});
element('choose-cs2').addEventListener('click', () => run('chooseCs2', async () => {
  const path = await api.chooseCs2();
  if (!path) return;
  element('cs2-path').value = path;
  changed = true;
  return { message: 'Сохраните путь, чтобы установить конфиги.' };
}));
element('copy-hud-command').addEventListener('click', () => copyValue('exec duocup_match_hud', 'Команда скопирована.'));

if (api) {
  void refresh();
  setInterval(() => { if (!pending && !document.hidden) void refresh(); }, 1600);
  document.addEventListener('visibilitychange', () => { if (!pending && !document.hidden) void refresh(); });
} else {
  notice('Откройте пульт из приложения DUO CUP.', 'error');
  element('choose-cs2').disabled = true;
}
