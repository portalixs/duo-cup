const { app, BrowserWindow, Menu, Tray, globalShortcut, screen } = require('electron');
const { getCs2Bounds, keepOverlayOnTop } = require('./cs2-window.cjs');

const hudUrl = 'http://127.0.0.1:8787/obs?surface=desktop';
const toggleShortcut = 'CommandOrControl+Shift+F10';
let overlay;
let tray;
let timer;
let enabled = true;
let loaded = false;
let loading = false;
let refreshRequested = false;
let nextLoad = 0;
let lastBounds;

async function loadHud(refresh) {
  loading = true;
  refreshRequested = false;
  try {
    if (refresh) await overlay.webContents.session.clearCache();
    if (overlay.isDestroyed()) return;
    const options = refresh ? { extraHeaders: 'Cache-Control: no-cache\nPragma: no-cache\n' } : undefined;
    await overlay.loadURL(hudUrl, options);
    loaded = true;
    if (refresh) console.log('HUD обновлён.');
  } catch {
    loaded = false;
    refreshRequested ||= refresh;
    nextLoad = Date.now() + 3000;
  } finally {
    loading = false;
  }
}

function refreshOverlay() {
  refreshRequested = true;
  nextLoad = 0;
  updateOverlay();
}

function updateOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  if (!loading && Date.now() >= nextLoad && (refreshRequested || (enabled && !loaded))) {
    void loadHud(refreshRequested);
  }

  const physical = enabled && loaded ? getCs2Bounds() : null;
  if (!physical) {
    if (overlay.isVisible()) overlay.hide();
    return;
  }
  const bounds = screen.screenToDipRect(null, physical);
  if (!lastBounds || Object.keys(bounds).some(key => bounds[key] !== lastBounds[key])) {
    overlay.setBounds(bounds);
    lastBounds = bounds;
  }
  const newlyShown = !overlay.isVisible();
  if (newlyShown) overlay.showInactive();
  const onTop = keepOverlayOnTop(overlay.getNativeWindowHandle());
  if (newlyShown) console.log(onTop
    ? `HUD закреплён над окном CS2 ${physical.width}×${physical.height}`
    : 'Windows не удалось закрепить HUD поверх игры.');
}

function toggleOverlay() {
  enabled = !enabled;
  updateOverlay();
  updateTrayMenu();
}

function updateTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Показывать HUD в CS2', type: 'checkbox', checked: enabled, click: toggleOverlay },
    { label: 'Обновить HUD', click: refreshOverlay },
    { label: 'Выход', click: () => app.quit() },
  ]));
}

async function start() {
  overlay = new BrowserWindow({
    title: 'DUO CUP · HUD CS2', show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', focusable: false, skipTaskbar: true, alwaysOnTop: true,
    movable: false, minimizable: false, maximizable: false, hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  overlay.setMenu(null);
  overlay.setIgnoreMouseEvents(true);
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlay.webContents.on('will-navigate', (event, url) => { if (url !== hudUrl) event.preventDefault(); });
  overlay.webContents.session.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  overlay.webContents.session.setPermissionCheckHandler(() => false);
  overlay.webContents.on('render-process-gone', () => { loaded = false; });
  overlay.on('closed', () => app.quit());

  tray = new Tray(await app.getFileIcon(process.execPath));
  tray.setToolTip('DUO CUP · HUD CS2');
  updateTrayMenu();
  if (!globalShortcut.register(toggleShortcut, toggleOverlay)) console.log('Горячая клавиша занята. Переключатель доступен в трее.');
  updateOverlay();
  timer = setInterval(updateOverlay, 200);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', refreshOverlay);
  app.whenReady().then(start).catch(cause => { console.error(cause); app.exit(1); });
}
app.on('will-quit', () => {
  clearInterval(timer);
  globalShortcut.unregisterAll();
  tray?.destroy();
});
