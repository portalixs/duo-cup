import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Arch, build, Platform } from 'electron-builder';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Для сборки установщика используйте Windows x64 и Node.js x64.');
}

const desktop = dirname(fileURLToPath(import.meta.url));
const project = resolve(desktop, '..');
const require = createRequire(import.meta.url);
const { version: electronVersion } = require('electron/package.json');

await build({
  projectDir: desktop,
  targets: Platform.WINDOWS.createTarget(process.argv.includes('--dir') ? 'dir' : 'nsis', Arch.x64),
  publish: 'never',
  config: {
    appId: 'ru.duocup.commentator',
    productName: 'DUO CUP Комментатор',
    electronVersion,
    electronDist: resolve(desktop, 'node_modules/electron/dist'),
    npmRebuild: false,
    directories: { output: resolve(project, 'outputs/commentator') },
    files: ['*.cjs', '*.js', '*.html', '*.css'],
    asar: false,
    extraResources: [
      {
        from: project,
        to: 'duo-cup',
        filter: [
          'dist/**/*', '!dist/server/**', 'obs/DUO-CUP*.json', 'obs/duocup_match_hud.cfg',
          'server.mjs', 'hud-data.mjs', 'obs-replay.mjs', 'obs-websocket.mjs', 'observer-bridge.mjs',
          'replay-selection.mjs', 'steam-avatars.mjs', 'tournament-control.mjs',
        ],
      },
      { from: resolve(desktop, 'installer/obs-install.ps1'), to: 'duo-cup/obs-install.ps1' },
    ],
    win: { executableName: 'DUO-CUP-Commentator', icon: 'installer/icon.ico', signExecutable: false },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      deleteAppDataOnUninstall: false,
      installerLanguages: ['ru_RU'],
      artifactName: 'DUO-CUP-Commentator-Setup-${version}-x64.exe',
      include: resolve(desktop, 'installer/finish.nsh'),
    },
  },
});
