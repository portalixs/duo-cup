import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import obsSetup from '../desktop/commentator-obs-setup.cjs';

test('loads the persisted local OBS port and respects the authentication checkbox', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'duo-obs-config-'));
  const pluginDir = join(configDir, 'plugin_config', 'obs-websocket');
  const configPath = join(pluginDir, 'config.json');
  const read = () => obsSetup.readLocalObsWebSocket({ configDir });
  const settings = { server_enabled: true, server_port: 4460, auth_required: true, server_password: ',pässword ' };
  try {
    await assert.rejects(read, { code: 'OBS_CONFIG_MISSING' });
    await mkdir(pluginDir, { recursive: true });
    await writeFile(configPath, '\uFEFF' + JSON.stringify(settings));
    assert.deepEqual(await read(), { port: 4460, password: settings.server_password });

    await writeFile(configPath, JSON.stringify({ ...settings, auth_required: false }));
    assert.deepEqual(await read(), { port: 4460, password: '' });

    await writeFile(configPath, JSON.stringify({ ...settings, server_enabled: false }));
    await assert.rejects(read, { code: 'OBS_WEBSOCKET_DISABLED' });

    for (const invalid of [{ server_port: 65536 }, { server_password: '' }, { auth_required: 1 }]) {
      await writeFile(configPath, JSON.stringify({ ...settings, ...invalid }));
      await assert.rejects(read, { code: 'OBS_CONFIG_INVALID' });
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
