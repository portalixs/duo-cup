const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');

const base = 'http://127.0.0.1:8787';

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

async function fetchJson(path, init, timeout = 850) {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeout) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || `Служба вернула HTTP ${response.status}`);
  return result;
}

function createService({ runtime, payload }) {
  mkdirSync(runtime, { recursive: true });
  const logs = join(runtime, 'observer.log');
  const instance = randomUUID();
  let child;
  let error = '';
  let restartRequired = false;

  async function requestControl(body) {
    const { admin } = readJson(join(runtime, 'keys.json'), {});
    if (!admin) throw new Error('Ключ локальной панели ещё не создан. Запустите службу.');
    return fetchJson('/api/control', {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${admin}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    }, body ? 8000 : 900);
  }

  async function getStatus() {
    try {
      const data = await fetchJson('/api/state');
      const identity = await fetchJson('/api/observer-info').catch(() => null);
      const compatible = identity?.app === 'DUO CUP';
      const running = compatible || data.service === true;
      const owned = compatible && identity.instance === instance;
      const control = owned ? await requestControl().catch(() => null) : null;
      return {
        running, owned, occupied: !running, compatible, restartRequired, gsi: data.gsi === true, port: 8787,
        active: data.active ?? null,
        publishStatus: running ? data.publishStatus : '',
        game: data.game && { map: data.game.map, phase: data.game.phase, ct: data.game.ct, t: data.game.t },
        obs: control?.obs, error: running ? '' : 'Порт 8787 занят другим приложением.',
      };
    } catch {
      return { running: Boolean(child), owned: Boolean(child), gsi: false, port: 8787, error, restartRequired };
    }
  }

  async function start({ publication, obs }) {
    const current = await getStatus();
    if (current.running) return { message: current.owned ? 'Служба уже запущена.' : 'Порт 8787 обслуживает другой экземпляр DUO CUP. Закройте старое окно start.cmd, чтобы управлять службой здесь.' };
    if (current.occupied) throw new Error(current.error);
    error = '';
    if (existsSync(logs) && statSync(logs).size > 2_000_000) {
      renameSync(logs, `${logs}.previous`);
    }
    const output = createWriteStream(logs, { flags: 'a' });
    output.on('error', () => { error = 'Не удалось записать журнал службы.'; });
    const processEnv = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1', PORT: '8787',
      TOURNAMENT_SERVER: '0', TOURNAMENT_DATA_DIR: runtime, DUOCUP_INSTANCE: instance,
      DUOCUP_PUBLICATION: JSON.stringify(publication), DUOCUP_OBS: JSON.stringify(obs),
    };
    const launched = spawn(process.execPath, [join(payload, 'server.mjs')], {
      cwd: payload, env: processEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = launched;
    launched.stdout.pipe(output, { end: false });
    launched.stderr.pipe(output, { end: false });
    launched.once('error', () => { error = 'Не удалось запустить службу DUO CUP.'; });
    launched.once('close', code => {
      if (child === launched) child = undefined;
      if (code && !launched.killed && !error) error = 'Служба завершилась. Проверьте журнал.';
      output.end();
    });
    for (let attempt = 0; attempt < 26 && child === launched; attempt++) {
      const identity = await fetchJson('/api/observer-info', {}, 400).catch(() => null);
      if (identity?.instance === instance) {
        restartRequired = false;
        return { message: 'Служба DUO CUP запущена.' };
      }
      await wait(110);
    }
    launched.kill();
    throw new Error(error || 'Служба не ответила на порту 8787. Откройте журнал.');
  }

  async function stop() {
    const launched = child;
    if (!launched) throw new Error('Этот экземпляр службы нужно остановить в окне start.cmd.');
    const status = await getStatus();
    if (status.obs?.enabled) await requestControl({ action: 'obs-replay', enabled: false }).catch(() => {});
    const closed = new Promise(resolve => launched.once('close', resolve));
    if (child === launched) {
      launched.kill();
      await Promise.race([closed, wait(1200)]);
    }
    return { message: 'Служба DUO CUP остановлена.' };
  }

  return { base, logs, getStatus, requestControl, start, stop, ownsProcess: () => Boolean(child),
    markRestart: () => { restartRequired = true; }, kill: () => child?.kill() };
}

module.exports = { createService, readJson, writeJson };
