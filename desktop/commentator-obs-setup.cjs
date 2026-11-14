const { mkdir, readFile, readdir, rename, unlink, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { isAbsolute, join } = require('node:path');
const { obsRunning } = require('./commentator-setup.cjs');

const managedProfile = 'DUO CUP';
const defaultConfig = () => process.env.APPDATA && join(process.env.APPDATA, 'obs-studio');

async function optionalRead(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sectionName(line) {
  return /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1].trim().toLowerCase();
}

function iniValue(text, section, key) {
  let current;
  for (const line of (text ?? '').split(/\r?\n/)) {
    const header = sectionName(line);
    if (header != null) current = header;
    if (current !== section.toLowerCase()) continue;
    const property = /^\s*([^;#=]+?)\s*=\s*(.*)$/.exec(line);
    if (property?.[1].trim().toLowerCase() === key.toLowerCase()) return property[2].trim();
  }
  return undefined;
}

function setIniValue(text, section, key, value) {
  if (iniValue(text, section, key) === value) return text;
  const end = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => sectionName(line) === section.toLowerCase());
  if (start === -1) return `${text}${text.endsWith(end) || !text ? '' : end}${text ? end : ''}[${section}]${end}${key}=${value}${end}`;

  let last = start + 1;
  for (; last < lines.length && sectionName(lines[last]) == null; last++) {
    const property = /^\s*([^;#=]+?)\s*=/.exec(lines[last]);
    if (property?.[1].trim().toLowerCase() === key.toLowerCase()) {
      lines[last] = `${key}=${value}`;
      return lines.join(end);
    }
  }
  while (last > start + 1 && !lines[last - 1].trim()) last--;
  lines.splice(last, 0, `${key}=${value}`);
  return lines.join(end);
}

async function locateProfile(configDir) {
  if (typeof configDir !== 'string' || !isAbsolute(configDir)) throw new Error('Папка настроек OBS недоступна.');
  const profilesDir = join(configDir, 'basic', 'profiles');
  const [user, global, entries] = await Promise.all([
    optionalRead(join(configDir, 'user.ini')),
    optionalRead(join(configDir, 'global.ini')),
    readdir(profilesDir, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }),
  ]);
  const profiles = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async ({ name }) => {
    const profileDir = join(profilesDir, name);
    const file = join(profileDir, 'basic.ini');
    const text = await optionalRead(file);
    return text == null ? null : { directoryName: name, profileDir, file, text, profileName: iniValue(text, 'General', 'Name') || name };
  })).then(items => items.filter(Boolean));
  const selectedDir = iniValue(user, 'Basic', 'ProfileDir') || iniValue(global, 'Basic', 'ProfileDir');
  const selectedName = iniValue(user, 'Basic', 'Profile') || iniValue(global, 'Basic', 'Profile');
  const selected = profiles.find(profile => profile.directoryName.toLowerCase() === selectedDir?.toLowerCase())
    ?? profiles.find(profile => profile.profileName === selectedName)
    ?? profiles.find(profile => profile.profileName === managedProfile)
    ?? (profiles.length === 1 ? profiles[0] : null);
  if (selected) return selected;

  const taken = new Set(entries.map(entry => entry.name.toLowerCase()));
  let directoryName = 'DUO-CUP';
  for (let suffix = 2; taken.has(directoryName.toLowerCase()); suffix++) directoryName = `DUO-CUP-${suffix}`;
  const profileDir = join(profilesDir, directoryName);
  return { profileDir, file: join(profileDir, 'basic.ini'), text: null, profileName: managedProfile };
}

function numberValue(text, section, key) {
  const value = Number(iniValue(text, section, key));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function profileStatus({ profileName, profileDir, text }) {
  const mode = iniValue(text, 'Output', 'Mode')?.toLowerCase() === 'advanced' ? 'advanced' : 'simple';
  const settings = mode === 'advanced' ? 'AdvOut' : 'SimpleOutput';
  const replayAvailable = mode === 'advanced' ? iniValue(text, settings, 'RecType')?.toLowerCase() !== 'ffmpeg'
    : iniValue(text, settings, 'RecQuality')?.toLowerCase() !== 'lossless';
  const replayEnabled = replayAvailable && /^(true|1)$/i.test(iniValue(text, settings, 'RecRB') ?? '');
  const fpsType = Number(iniValue(text, 'Video', 'FPSType') ?? '0');
  const numerator = numberValue(text, 'Video', 'FPSNum');
  const denominator = numberValue(text, 'Video', 'FPSDen');
  const fps = fpsType === 1 ? numberValue(text, 'Video', 'FPSInt')
    : fpsType === 2 ? (numerator && denominator ? numerator / denominator : null)
      : Number(iniValue(text, 'Video', 'FPSCommon')) || null;
  return { profileDir, profileName, mode, replayAvailable, replayEnabled, fps,
    baseWidth: numberValue(text, 'Video', 'BaseCX'), baseHeight: numberValue(text, 'Video', 'BaseCY'),
    exists: text != null, ready: replayEnabled && fps === 60 };
}

async function readObsProfile({ configDir = defaultConfig() } = {}) {
  return profileStatus(await locateProfile(configDir));
}

async function prepareObsProfile({ configDir = defaultConfig(), canvas } = {}) {
  const profile = await locateProfile(configDir);
  const previous = profileStatus(profile);
  if (await obsRunning()) return { ...previous, running: true, changed: false };

  let text = profile.text ?? `[General]\nName=${profile.profileName}\n`;
  if (!previous.exists) {
    const width = Number.isInteger(canvas?.width) && canvas.width > 0 ? canvas.width : 1920;
    const height = Number.isInteger(canvas?.height) && canvas.height > 0 ? canvas.height : 1080;
    for (const [key, value] of [['BaseCX', width], ['BaseCY', height], ['OutputCX', 1920], ['OutputCY', 1080]]) {
      text = setIniValue(text, 'Video', key, String(value));
    }
  }
  if (previous.fps !== 60) {
    text = setIniValue(text, 'Video', 'FPSType', '0');
    text = setIniValue(text, 'Video', 'FPSCommon', '60');
  }
  if (previous.replayAvailable && !previous.replayEnabled) {
    const settings = previous.mode === 'advanced' ? 'AdvOut' : 'SimpleOutput';
    text = setIniValue(text, settings, 'RecRB', 'true');
    text = setIniValue(text, settings, 'RecRBTime', '10');
  }
  if (text === profile.text) return { ...previous, running: false, changed: false };

  await mkdir(profile.profileDir, { recursive: true });
  if (await obsRunning()) return { ...previous, running: true, changed: false };
  if (!previous.exists) await writeFile(profile.file, text, { flag: 'wx' });
  else {
    const temp = `${profile.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, text, { flag: 'wx' });
      await rename(temp, profile.file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  return { ...profileStatus({ ...profile, text }), running: false, changed: true };
}

module.exports = { readObsProfile, prepareObsProfile };
