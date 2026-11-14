const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createService, readJson, writeJson } = require('./commentator-service.cjs');
const setup = require('./commentator-setup.cjs');
const obsSetup = require('./commentator-obs-setup.cjs');

const collectionDefault = 'DUO CUP · CS2';
const collection4k = 'DUO CUP · CS2 4K';
const tournamentSite = 'https://cup.inf54.ru';
const sceneNames = {
  sceneStandby: '01 · Ожидание и перерыв', sceneMatch: '02 · Матч CS2',
  sceneWait: '03 · Ожидание матча', sceneChange: '04 · Смена карты',
};

async function openCommentator(overlay) {
  const payload = app.isPackaged ? join(process.resourcesPath, 'duo-cup') : join(__dirname, '..');
  const runtime = join(app.getPath('userData'), 'runtime');
  const settingsFile = join(runtime, 'commentator.json');
  const obsDir = join(payload, 'obs');
  const service = createService({ runtime, payload });
  const { createObsConnection } = await import(pathToFileURL(join(payload, 'obs-websocket.mjs')).href);
  const defaults = { siteUrl: tournamentSite, publishSecret: '', obsPort: 4455, obsSecret: '', obsCollection: collectionDefault, cs2Path: '' };
  let settings = { ...defaults, ...readJson(settingsFile, {}) };
  let detectedPath;
  let obsExe;
  let obs;
  let lastProbe = 0;
  let obsState = {};
  let obsProbe;
  let installer;
  let busy = false;

  const reveal = value => value ? safeStorage.decryptString(Buffer.from(value, 'base64')) : '';
  const obsOptions = () => ({ port: settings.obsPort, password: reveal(settings.obsSecret) });
  function hasObsPassword(password) {
    try { return obsOptions().password === password; } catch { return false; }
  }
  function protect(value) {
    if (!value) return '';
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows не удалось защитить ключи профиля.');
    return safeStorage.encryptString(value).toString('base64');
  }

  function serviceOptions() {
    return {
      publication: settings.siteUrl && settings.publishSecret ? { url: settings.siteUrl, key: reveal(settings.publishSecret) } : null,
      obs: obsOptions(),
    };
  }

  function refreshLocations() {
    detectedPath = setup.findCs2();
    obsExe = setup.findObs();
  }

  async function requestObs(type, fields) {
    obs ??= createObsConnection(obsOptions(), () => {});
    return obs.request(type, fields, 950);
  }

  function collectionName() {
    return settings.obsCollection === collection4k ? collection4k : collectionDefault;
  }

  async function probeObs() {
    if (obsProbe) return obsProbe;
    if (Date.now() - lastProbe < 3000) return obsState;
    obsProbe = (async () => {
      if (!obsExe) obsExe = setup.findObs();
      const collections = await setup.findObsCollections();
      const scenesReady = collections.some(item => item.templateName === collectionName());
      const running = await setup.obsRunning().catch(() => null);
      const profile = await obsSetup.readObsProfile().catch(() => null);
      const next = { connected: false, bufferActive: false, running, installed: Boolean(obsExe || running), scenesReady, profileReady: Boolean(profile?.ready) };
      try {
        const scene = await requestObs('GetSceneList');
        next.connected = true;
        next.running = true;
        next.installed = true;
        next.currentScene = scene.currentProgramSceneName ?? scene.sceneName;
        next.availableScenes = scene.scenes?.map(item => item.sceneName) ?? [];
      } catch (error) {
        if (running !== false || error.code !== 'OBS_UNREACHABLE') {
          next.connectionError = error.code?.startsWith('OBS_') ? error.message
            : `Не удалось подключиться к OBS на порту ${settings.obsPort}. Проверьте настройки WebSocket.`;
        }
      }
      if (next.connected) {
        // Older OBS versions reject this request when Replay Buffer is disabled in the profile.
        const buffer = await requestObs('GetReplayBufferStatus').catch(() => null);
        next.bufferAvailable = Boolean(buffer);
        next.bufferActive = buffer?.outputActive === true;
        if (!buffer) next.error = 'В OBS включите буфер повтора в разделе «Настройки → Вывод».';
      }
      obsState = next;
      lastProbe = Date.now();
      return obsState;
    })();
    try { return await obsProbe; }
    finally { obsProbe = null; }
  }

  async function getStatus() {
    const [status, obsStatus] = await Promise.all([service.getStatus(), probeObs()]);
    const cfgDir = settings.cs2Path || detectedPath;
    const generated = join(runtime, 'gamestate_integration_duocup.cfg');
    const configured = cfgDir && setup.hasCurrentGameConfig(cfgDir, generated, join(obsDir, 'duocup_match_hud.cfg'));
    return {
      settings: { siteUrl: settings.siteUrl, hasPublishKey: Boolean(settings.publishSecret), obsPort: settings.obsPort,
        hasObsPassword: Boolean(settings.obsSecret), cs2Path: settings.cs2Path, obsCollection: collectionName() },
      service: status,
      obs: { ...obsStatus, replayEnabled: Boolean(status.obs?.enabled), replayPlaying: Boolean(status.obs?.playing),
        error: obsStatus.connectionError || status.obs?.error || obsStatus.error },
      hud: { running: overlay.isEnabled() }, cs2: { configured: Boolean(configured), detectedPath }, paths: { runtime },
    };
  }

  async function saveSettings(form) {
    let siteUrl = String(form.siteUrl ?? '').trim();
    if (siteUrl) {
      let url;
      try { url = new URL(siteUrl); } catch { throw new Error('Укажите полный адрес сайта, например https://cup.inf54.ru.'); }
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port === '123'
          || !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
        throw new Error('Укажите адрес сайта HTTPS без пути. Для локального туннеля допустим HTTP.');
      }
      siteUrl = url.origin;
    }
    const publishKey = String(form.publishKey ?? '').trim();
    if (publishKey && !/^[a-f0-9]{48,64}$/.test(publishKey)) throw new Error('Скопируйте ключ publish из настроек сервера.');
    const obsPort = Number(form.obsPort);
    if (!Number.isInteger(obsPort) || obsPort < 1 || obsPort > 65535) throw new Error('Порт OBS должен быть числом от 1 до 65535.');
    const chosen = String(form.cs2Path ?? '').trim();
    const cs2Path = chosen ? setup.normalizeCs2Path(chosen) : '';
    if (chosen && !cs2Path) throw new Error('Выберите папку установленной CS2 или её папку game/csgo/cfg.');
    const previousOrigin = settings.siteUrl ? new URL(settings.siteUrl).origin : '';
    const next = { ...settings, siteUrl, obsPort, cs2Path, obsCollection: form.obsCollection === collection4k ? collection4k : collectionDefault,
      publishSecret: form.clearPublishKey ? '' : publishKey ? protect(publishKey) : previousOrigin === siteUrl ? settings.publishSecret : '',
      obsSecret: form.clearObsPassword ? '' : form.obsPassword ? protect(String(form.obsPassword)) : settings.obsSecret,
    };
    if (siteUrl && publishKey && !form.clearPublishKey) {
      try {
        const response = await fetch(new URL('/api/bridge', siteUrl), {
          headers: { Authorization: `Bearer ${publishKey}` }, redirect: 'error', signal: AbortSignal.timeout(3500),
        });
        if (response.status === 401 || response.status === 403) throw new Error('Сервер отклонил ключ наблюдателя. Нужен ключ publish именно этого сервера.');
        if (!response.ok) throw new Error(`Сервер не принял проверку ключа (HTTP ${response.status}).`);
      } catch (cause) {
        if (cause.name === 'TimeoutError' || cause instanceof TypeError) throw new Error('Связь с сайтом недоступна. Проверьте адрес и повторите сохранение.');
        throw cause;
      }
    }
    return applySettings(next);
  }

  async function applySettings(next) {
    if (JSON.stringify(next) === JSON.stringify(settings)) return { message: 'Настройки уже сохранены.' };
    const restart = ['siteUrl', 'publishSecret', 'obsPort', 'obsSecret'].some(key => next[key] !== settings[key]);
    await obsProbe?.catch(() => {});
    writeJson(settingsFile, next);
    settings = next;
    obs?.close();
    obs = undefined;
    lastProbe = 0;
    if (restart && service.ownsProcess()) {
      await service.stop();
      await service.start(serviceOptions());
      return { message: 'Настройки сохранены, служба перезапущена. При необходимости снова включите автоповтор.' };
    }
    if (restart && (await service.getStatus()).running) service.markRestart();
    return { message: 'Настройки сохранены.' };
  }

  function execute(exe, args, options = {}) {
    return new Promise((resolve, reject) => {
      const process = spawn(exe, args, { windowsHide: true, detached: true, stdio: 'ignore', ...options });
      process.once('error', reject);
      process.once('spawn', () => { process.unref(); resolve(process); });
    });
  }

  async function launchObs() {
    if (await setup.obsRunning()) return { message: 'OBS уже открыт.' };
    if (!obsExe) obsExe = setup.findObs();
    if (!obsExe) throw new Error('Сначала установите OBS Studio.');
    const collections = await setup.findObsCollections();
    const name = collectionName();
    const collection = collections.find(item => item.templateName === name && item.name === name)
      ?? collections.find(item => item.templateName === name);
    const profile = await obsSetup.readObsProfile().catch(() => null);
    const profileArgs = profile?.profileName ? ['--profile', profile.profileName] : [];
    await execute(obsExe, [...profileArgs, ...(collection ? ['--collection', collection.name] : [])], { cwd: dirname(obsExe) });
    lastProbe = 0;
    return { message: collection ? `OBS запущен с коллекцией «${collection.name}».` : 'OBS запущен. Подготовьте сцены DUO CUP для своей коллекции.' };
  }

  async function revealPath(path) {
    const error = await shell.openPath(path);
    if (error) throw new Error('Не удалось открыть выбранный файл или папку.');
    return {};
  }

  async function installCs2Config(cfgDir) {
    const generatedCfg = join(runtime, 'gamestate_integration_duocup.cfg');
    const hudCfg = join(obsDir, 'duocup_match_hud.cfg');
    if (setup.hasCurrentGameConfig(cfgDir, generatedCfg, hudCfg)) return null;
    return setup.installGameConfigs({ cfgDir, generatedCfg, hudCfg });
  }

  const actions = {
    startService: () => service.start(serviceOptions()), stopService: service.stop,
    async setupFirstRun() {
      refreshLocations();
      const current = await service.getStatus();
      if (current.running && !current.owned) throw new Error('Закройте старое окно start.cmd и повторите подготовку.');
      if (!current.running) await service.start(serviceOptions());

      const messages = ['Служба DUO CUP работает.'];
      const cfgDir = settings.cs2Path || detectedPath;
      if (cfgDir) {
        try {
          const result = await installCs2Config(cfgDir);
          messages.push(result ? 'Конфиги CS2 обновлены. Если игра открыта, перезапустите её.' : 'Конфиги CS2 готовы.');
        } catch (error) { messages.push(error.message); }
      } else messages.push('Установите CS2 через Steam или выберите папку игры.');

      if (await setup.obsRunning()) {
        messages.push('Закройте OBS, чтобы подготовить его профиль и добавить коллекции, затем нажмите кнопку ещё раз.');
      } else {
        const scenes = await setup.prepareObsCollections({ sourceDir: obsDir });
        const canvas = collectionName() === collection4k ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 };
        const profile = await obsSetup.prepareObsProfile({ canvas });
        if (scenes.ready && profile.ready) {
          messages.push('Сцены OBS, диагональный переход, 60 FPS и буфер готовы.');
          if (!readJson(settingsFile, {}).obsCollection && profile.baseWidth === 3840) {
            settings = { ...settings, obsCollection: collection4k };
            writeJson(settingsFile, settings);
          }
        }
        if (!profile.replayAvailable) messages.push('Текущий формат записи OBS не поддерживает буфер. Выберите стандартный формат записи в OBS.');
        if (scenes.running || profile.running) messages.push('Закройте OBS и повторите подготовку.');
      }
      if (!obsExe) messages.push((await actions.installObs())?.message ?? 'Установите OBS Studio.');
      else if (!settings.obsSecret) messages.push('Включите WebSocket в OBS и сохраните его пароль в пульте.');
      lastProbe = 0;
      return { message: messages.join(' ') };
    },
    async launchBroadcast() {
      const cfgDir = settings.cs2Path || detectedPath;
      if (!obsExe || !cfgDir) throw new Error('Сначала подготовьте рабочее место на вкладке «Настройка».');
      const current = await service.getStatus();
      if (current.running && !current.owned) throw new Error('Закройте старое окно start.cmd и повторите запуск.');
      if (!current.running) await service.start(serviceOptions());
      const configsUpdated = await installCs2Config(cfgDir);
      await launchObs();
      await shell.openExternal('steam://rungameid/730');
      return { message: configsUpdated ? 'Служба запущена, конфиги CS2 обновлены. Если игра была открыта, перезапустите её.'
        : 'Служба запущена. OBS и CS2 можно проверить перед трансляцией.' };
    },
    async installCs2() {
      const cfgDir = settings.cs2Path || detectedPath;
      if (!cfgDir) throw new Error('Выберите папку установки CS2.');
      if (!service.ownsProcess()) throw new Error('Запустите службу DUO CUP из приложения.');
      const result = await installCs2Config(cfgDir);
      if (!result) return { message: 'Конфиги CS2 уже установлены.' };
      return { message: `Конфиги CS2 установлены. ${result.backups.length ? 'Старые файлы сохранены рядом. ' : ''}Перезапустите CS2.` };
    },
    async launchCs2() { await shell.openExternal('steam://rungameid/730'); return { message: 'Команда запуска отправлена в Steam.' }; },
    launchObs,
    async installObs() {
      if (installer) return { message: 'Установщик OBS уже запущен.' };
      const script = app.isPackaged ? join(payload, 'obs-install.ps1') : join(__dirname, 'installer', 'obs-install.ps1');
      if (!existsSync(script)) return shell.openExternal('https://obsproject.com/download');
      const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      installer = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]);
      installer.once('exit', code => {
        installer = null;
        obsExe = setup.findObs();
        lastProbe = 0;
        if (code && !obsExe) void dialog.showMessageBox({ type: 'warning', title: 'Установка OBS',
          message: 'Установка OBS не завершилась. Запустите её снова или скачайте OBS на obsproject.com.' });
      });
      return { message: 'Скачивается проверенный установщик OBS. Дождитесь появления окна установки.' };
    },
    async setupObsScenes() {
      const result = await setup.prepareObsCollections({ sourceDir: obsDir });
      if (result.running) throw new Error('Закройте OBS и повторите подготовку сцен.');
      lastProbe = 0;
      return { message: 'Коллекции DUO CUP подготовлены. Запустите OBS из приложения.' };
    },
    async useLocalObsSettings() {
      const { port, password } = await obsSetup.readLocalObsWebSocket();
      const candidate = createObsConnection({ port, password }, () => {});
      try { await candidate.request('GetSceneList'); }
      finally { candidate.close(); }
      const alreadySaved = port === settings.obsPort && hasObsPassword(password);
      const result = await applySettings({ ...settings, obsPort: port,
        obsSecret: alreadySaved ? settings.obsSecret : protect(password) });
      lastProbe = 0;
      const status = await probeObs();
      if (!status.connected) return { message: `${result.message} ${status.connectionError ?? 'Откройте OBS и проверьте связь.'}`, tone: 'warning' };
      return { message: `OBS подключён на порту ${port}. ${result.message}` };
    },
    async toggleHud() { overlay.toggle(); return { message: overlay.isEnabled() ? 'HUD включён.' : 'HUD скрыт.' }; },
    async openControl() {
      await shell.openExternal(new URL('/control', settings.siteUrl || tournamentSite).href);
      return {};
    },
    openRuntime: () => revealPath(runtime), openLogs: () => revealPath(service.logs),
    openObsScenes: () => revealPath(obsDir),
    async openUpdates() { await shell.openExternal('https://github.com/portalixs/duo-cup/releases/latest'); return {}; },
    async openObsGuide() { await shell.openExternal('https://github.com/portalixs/duo-cup/blob/main/README.md#автоповтор-в-конце-раунда'); return {}; },
    async startReplayBuffer() { await requestObs('StartReplayBuffer'); lastProbe = 0; return { message: 'Буфер повтора запущен.' }; },
    async replayEnable() {
      if (!(await requestObs('GetReplayBufferStatus')).outputActive) {
        await requestObs('StartReplayBuffer');
        for (let attempt = 0; attempt < 10; attempt++) {
          if ((await requestObs('GetReplayBufferStatus')).outputActive) break;
          await new Promise(resolve => setTimeout(resolve, 140));
        }
      }
      await service.requestControl({ action: 'obs-replay', enabled: true });
      lastProbe = 0;
      return { message: 'Автоповтор включён.' };
    },
    async replayDisable() { await service.requestControl({ action: 'obs-replay', enabled: false }); return { message: 'Автоповтор выключен.' }; },
    async knife() { await service.requestControl({ action: 'obs-knife' }); return { message: 'Плашка ножевого отправлена в HUD.' }; },
  };
  for (const [key, name] of Object.entries(sceneNames)) {
    actions[key] = async () => {
      await requestObs('SetCurrentProgramScene', { sceneName: name });
      lastProbe = 0;
      return { message: `В программе OBS — «${name}».` };
    };
  }

  const page = new BrowserWindow({
    title: 'DUO CUP · Комментаторы', width: 1180, height: 860, minWidth: 650, minHeight: 620,
    show: false, backgroundColor: '#101522',
    webPreferences: { preload: join(__dirname, 'commentator-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  page.setMenu(null);
  page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  page.webContents.on('will-navigate', event => event.preventDefault());
  function handle(name, callback) {
    ipcMain.handle('commentator:' + name, (event, ...args) => {
      if (event.sender !== page.webContents || event.senderFrame !== page.webContents.mainFrame) throw new Error('Недоступно.');
      return callback(...args);
    });
  }
  async function run(operation) {
    if (busy) throw new Error('Дождитесь завершения текущего действия.');
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  }
  handle('status', getStatus);
  handle('save', form => run(() => saveSettings(form)));
  handle('action', action => run(() => {
    if (!Object.hasOwn(actions, action)) throw new Error('Действие недоступно.');
    return actions[action]();
  }));
  handle('choose-cs2', async () => {
    const result = await dialog.showOpenDialog(page, { title: 'Папка Counter-Strike 2', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const folder = setup.normalizeCs2Path(result.filePaths[0]);
    if (!folder) throw new Error('В выбранной папке не найдена установленная CS2.');
    return folder;
  });
  handle('copy', text => { if (typeof text === 'string' && text.length <= 2048) clipboard.writeText(text); });
  refreshLocations();
  page.once('ready-to-show', () => page.show());
  page.on('close', event => { event.preventDefault(); page.hide(); });
  await page.loadFile(join(__dirname, 'commentator.html'));
  return {
    show() { if (page.isMinimized()) page.restore(); page.show(); page.focus(); },
    async resumeObserver() {
      await actions.startService();
      if (!service.ownsProcess()) return;
      if (!overlay.isEnabled()) overlay.toggle();
      const buffer = await requestObs('GetReplayBufferStatus');
      if (buffer.outputActive) await actions.replayEnable();
    },
    async shutdown() {
      await service.stop().catch(() => {});
      service.kill();
      obs?.close();
      page.destroy();
    },
  };
}

module.exports = { openCommentator };
