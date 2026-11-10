import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const size = { x: 1920, y: 1080 };
const port = Number(process.env.PORT || 8787);
const browser = name => ({ is_local_file: false, url: `http://127.0.0.1:${port}/obs${name}`, width: size.x, height: size.y, shutdown: false, restart_when_active: false });
const source = (name, id, settings) => ({ name, uuid: randomUUID(), id, versioned_id: id, settings, enabled: true, muted: false, volume: 1, mixers: 255 });
const capture = source('CS2 · окно наблюдателя', 'window_capture', { window: 'Counter-Strike 2:SDL_app:cs2.exe', priority: 2, method: 2, cursor: false, client_area: true, capture_audio: true });
const overlay = source('DUO CUP · графика матча', 'browser_source', browser(''));
const standby = source('DUO CUP · заставка', 'browser_source', browser('?scene=standby'));
const microphone = source('Комментатор · микрофон', 'wasapi_input_capture', { device_id: 'default' });

function scene(name, sources) {
  const items = sources.map((input, index) => ({
    name: input.name, source_uuid: input.uuid, id: index + 1, visible: true, locked: false,
    pos: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rot: 0, align: 5, bounds_align: 0,
    bounds_type: input === microphone ? 'OBS_BOUNDS_NONE' : 'OBS_BOUNDS_SCALE_INNER', bounds: size,
  }));
  return source(name, 'scene', { id_counter: items.length, custom_size: false, items });
}

const start = scene('01 · Ожидание и перерыв', [standby, microphone]);
const match = scene('02 · Матч CS2', [capture, overlay, microphone]);
const collection = {
  name: 'DUO CUP · CS2', resolution: size, current_scene: start.name, current_program_scene: start.name,
  scene_order: [start, match].map(({ name }) => ({ name })), sources: [capture, overlay, standby, microphone, start, match],
  groups: [], transitions: [], quick_transitions: [], transition_duration: 250,
};
writeFileSync(new URL('DUO-CUP.json', import.meta.url), `${JSON.stringify(collection, null, 2)}\n`);
