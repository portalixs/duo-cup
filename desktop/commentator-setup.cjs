const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync, statSync, constants } = require('node:fs');
const { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } = require('node:fs/promises');
const { basename, delimiter, dirname, isAbsolute, join, normalize } = require('node:path');
const { promisify } = require('node:util');

const cs2FolderName = 'Counter-Strike Global Offensive';
const cfgFiles = ['gamestate_integration_duocup.cfg', 'duocup_match_hud.cfg'];
const programFolders = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
const run = promisify(execFile);
const obsTemplates = [
  ['DUO CUP · CS2', 'DUO-CUP.json'],
  ['DUO CUP · CS2 4K', 'DUO-CUP-4K.json'],
];
const requiredScenes = ['01 · Ожидание и перерыв', '02 · Матч CS2', '03 · Ожидание матча', '04 · Смена карты', '05 · Повтор'];

function isFile(path) {
  try { return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false; }
  catch { return false; }
}

function isDirectory(path) {
  try { return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false; }
  catch { return false; }
}

function windowsPath(path) {
  if (typeof path !== 'string') return null;
  const cleaned = path.trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (token, key) => process.env[key] ?? token);
  return isAbsolute(cleaned) ? normalize(cleaned) : null;
}

function registryValue(key, name) {
  if (process.platform !== 'win32') return null;
  try {
    const args = ['query', key, ...(name ? ['/v', name] : ['/ve'])];
    const output = execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 1200, stdio: ['ignore', 'pipe', 'ignore'] });
    return output.match(/^\s*[^\r\n]+?\s+REG_(?:EXPAND_)?SZ\s+([^\r\n]+)/m)?.[1] ?? null;
  } catch { return null; }
}

function readOptional(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

function vdfString(value) {
  return value.replace(/\\([\\"])/g, '$1');
}

function steamLibraries() {
  const roots = [
    registryValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    registryValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    registryValue('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'),
    ...programFolders.map(path => join(path, 'Steam')),
  ].map(windowsPath).filter(Boolean);
  const libraries = new Set(roots);
  for (const root of libraries) {
    const folders = readOptional(join(root, 'steamapps', 'libraryfolders.vdf'));
    for (const match of folders.matchAll(/^\s*"(?:path|\d+)"\s+"((?:\\.|[^"\\])*)"/gim)) {
      const path = windowsPath(vdfString(match[1]));
      if (path) libraries.add(path);
    }
  }
  return [...libraries];
}

function steamFolder(library, appId, fallback) {
  const manifest = readOptional(join(library, 'steamapps', `appmanifest_${appId}.acf`));
  const fromManifest = manifest.match(/"installdir"\s+"((?:\\.|[^"\\])*)"/i)?.[1];
  const name = fromManifest ? vdfString(fromManifest) : fallback;
  return join(library, 'steamapps', 'common', name === basename(name) && !['.', '..'].includes(name) ? name : fallback);
}

function normalizeCs2Path(value) {
  const path = windowsPath(value);
  if (!path) return null;
  const candidates = [join(path, 'game', 'csgo', 'cfg'), join(path, 'csgo', 'cfg'), join(path, 'cfg'), path];
  return candidates.find(candidate => basename(candidate).toLowerCase() === 'cfg'
    && basename(dirname(candidate)).toLowerCase() === 'csgo' && isDirectory(candidate)) ?? null;
}

function findCs2() {
  for (const library of steamLibraries()) {
    const folder = steamFolder(library, 730, cs2FolderName);
    if (!isFile(join(folder, 'game', 'bin', 'win64', 'cs2.exe'))) continue;
    const cfg = normalizeCs2Path(folder);
    if (cfg) return cfg;
  }
  return null;
}

function findObs() {
  const appPath = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\obs64.exe';
  const folders = [
    registryValue('HKLM\\SOFTWARE\\OBS Studio'),
    registryValue('HKLM\\SOFTWARE\\WOW6432Node\\OBS Studio'),
    ...programFolders.map(path => join(path, 'obs-studio')),
  ].map(windowsPath).filter(Boolean);
  const candidates = [
    ...folders.map(path => join(path, 'bin', '64bit', 'obs64.exe')),
    registryValue(`HKCU\\${appPath}`), registryValue(`HKLM\\${appPath}`),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, 'obs64.exe')),
  ];
  for (const value of candidates) {
    const path = windowsPath(value);
    if (path && isFile(path)) return path;
  }
  for (const library of steamLibraries()) {
    const path = join(steamFolder(library, 1905180, 'OBS Studio'), 'bin', '64bit', 'obs64.exe');
    if (isFile(path)) return path;
  }
  return null;
}

async function previousFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function hasCurrentGameConfig(cfgDir, generatedCfg, hudCfg) {
  const destination = normalizeCs2Path(cfgDir);
  if (!destination) return false;
  try {
    return [generatedCfg, hudCfg].every((path, i) => readFileSync(path).equals(readFileSync(join(destination, cfgFiles[i]))));
  } catch { return false; }
}

async function installGameConfigs({ cfgDir, generatedCfg, hudCfg }) {
  const destination = normalizeCs2Path(cfgDir);
  if (!destination) throw new Error('Выберите папку установки CS2 или game\\csgo\\cfg.');
  const changes = [];
  const installed = [];
  const backups = [];
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  const sources = [generatedCfg, hudCfg];
  try {
    for (const [index, input] of sources.entries()) {
      const data = await readFile(input);
      const target = join(destination, cfgFiles[index]);
      installed.push(target);
      const previous = await previousFile(target);
      if (previous?.equals(data)) continue;
      const temporary = `${target}.${id}.tmp`;
      const backup = previous ? `${target}.${id}.bak` : null;
      changes.push({ target, temporary, backup, written: false });
      await writeFile(temporary, data, { flag: 'wx' });
    }
    for (const change of changes) {
      if (change.backup) {
        await copyFile(change.target, change.backup, constants.COPYFILE_EXCL);
        backups.push(change.backup);
      }
      await rename(change.temporary, change.target);
      change.written = true;
    }
  } catch (error) {
    const rollback = await Promise.allSettled(changes.filter(change => change.written)
      .map(change => change.backup ? copyFile(change.backup, change.target) : unlink(change.target)));
    const failed = rollback.some(result => result.status === 'rejected');
    const reason = ['EACCES', 'EPERM'].includes(error.code) ? 'Windows запретила запись в папку CS2.'
      : 'Не удалось скопировать конфигурацию CS2. Проверьте, запущен ли локальный сервер DUO CUP.';
    throw new Error(`${reason}${failed ? ' Проверьте резервные копии .bak в папке игры.' : ''}`);
  } finally {
    await Promise.allSettled(changes.map(change => unlink(change.temporary)));
  }
  return { cfgDir: destination, installed, backups };
}

function sceneFolder(configDir = process.env.APPDATA && join(process.env.APPDATA, 'obs-studio')) {
  const root = windowsPath(configDir);
  if (!root) throw new Error('Папка конфигурации OBS недоступна.');
  return join(root, 'basic', 'scenes');
}

function obsTemplateName({ name, sources }) {
  if (typeof name !== 'string' || !Array.isArray(sources)) return null;
  const baseName = name.replace(/ \(Комментаторы(?: \d+)?\)$/i, '');
  const template = obsTemplates.find(([known]) => known.toLowerCase() === baseName.toLowerCase())?.[0];
  if (!template) return null;
  const scenes = new Map(sources.filter(source => source?.id === 'scene').map(source => [source.name, source]));
  const replaySource = sources.find(source => source?.id === 'ffmpeg_source' && source.name === 'DUO CUP · клип повтора');
  const replayItems = scenes.get('05 · Повтор')?.settings?.items;
  if (!replaySource || !Array.isArray(replayItems) || !requiredScenes.every(scene => scenes.has(scene))) return null;
  return replayItems.some(item => item?.name === replaySource.name
    || (replaySource.uuid && item?.source_uuid === replaySource.uuid)) ? template : null;
}

async function findObsCollections(configDir) {
  const folder = sceneFolder(configDir);
  let files;
  try { files = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const collections = await Promise.all(files.filter(file => file.isFile() && /\.json$/i.test(file.name)).map(async file => {
    const path = join(folder, file.name);
    try {
      const collection = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
      if (typeof collection.name === 'string' && collection.name) {
        return { name: collection.name, path, templateName: obsTemplateName(collection) };
      }
    } catch { return null; }
    return null;
  }));
  return collections.filter(Boolean);
}

async function obsRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
      timeout: 2500,
    });
    return /(?:^|\r?\n)"obs64\.exe",/i.test(stdout);
  } catch {
    throw new Error('Не удалось проверить, закрыт ли OBS. Импортируйте коллекцию через OBS.');
  }
}

async function prepareObsCollections({ sourceDir, configDir }) {
  const destination = sceneFolder(configDir);
  const templates = await Promise.all(obsTemplates.map(async ([name, filename]) => {
    const path = join(sourceDir, filename);
    const collection = JSON.parse(await readFile(path, 'utf8'));
    if (obsTemplateName(collection) !== name || collection.name !== name) throw new Error('Файл коллекции DUO CUP повреждён.');
    return { name, collection, filename };
  }));
  const existing = await findObsCollections(configDir);
  const existingNames = new Set(existing.map(collection => collection.name.toLowerCase()));
  const running = await obsRunning();
  const collections = [];
  for (const template of templates) {
    const installed = existing.find(collection => collection.templateName === template.name && collection.name === template.name)
      ?? existing.find(collection => collection.templateName === template.name);
    if (installed) collections.push({ ...installed, installed: false });
    else if (!running) {
      await mkdir(destination, { recursive: true });
      let suffix = 1;
      let name = template.name;
      while (existingNames.has(name.toLowerCase())) {
        name = `${template.name} (Комментаторы${suffix > 1 ? ` ${suffix}` : ''})`;
        suffix++;
      }
      suffix = 1;
      for (;;) {
        const filename = suffix === 1 ? template.filename : template.filename.replace(/\.json$/, `-${suffix}.json`);
        const path = join(destination, filename);
        try {
          await writeFile(path, `${JSON.stringify({ ...template.collection, name }, null, 2)}\n`, { flag: 'wx' });
          collections.push({ name, path, templateName: template.name, installed: true });
          existingNames.add(name.toLowerCase());
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          suffix++;
        }
      }
    }
  }
  return { ready: collections.length === templates.length, running, collections };
}

module.exports = {
  findCs2, normalizeCs2Path, hasCurrentGameConfig, installGameConfigs,
  findObs, obsRunning, findObsCollections, prepareObsCollections,
};
