import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import test from 'node:test';
import { createObsReplay } from '../obs-replay.mjs';

const matchScene = '02 · Матч CS2';
const replayScene = '05 · Повтор';
const duration = 9600;

const players = [
  { side: 'CT', name: 'Платон', slot: 1, health: 85, observed: true },
  { side: 'CT', name: 'Матвей', slot: 2, health: 0 },
  { side: 'T', name: 'Лев', slot: 3, health: 100 },
  { side: 'T', name: 'Илья', slot: 4, health: 100 },
];
const game = { matchId: 'G1.1', mapId: 'de_mirage', phase: 'live', round: 1, players };
const frag = id => ({ id, at: Date.now(), name: 'Платон', side: 'CT', slot: 1, count: 1, headshots: 0 });

function fakeObs({ mediaDuration = duration, seekToKeyframe = 7520, preparedDuration } = {}) {
  const calls = [];
  let scene = matchScene;
  let emit;
  let speed = 100;
  let cursor = 0;
  let mediaState = 'OBS_MEDIA_STATE_STOPPED';
  let savedCount = 0;
  let loadedDuration = mediaDuration;
  let updatedAt = Date.now();

  function connect(_config, onEvent) {
    emit = onEvent;
    return { async request(type, fields) {
      const at = Date.now();
      if (mediaState === 'OBS_MEDIA_STATE_PLAYING') cursor += (at - updatedAt) * speed / 100;
      updatedAt = at;
      calls.push({ type, fields, scene, cursor, at });
      switch (type) {
        case 'GetSceneList': return { scenes: [matchScene, replayScene].map(sceneName => ({ sceneName })) };
        case 'GetInputSettings':
        case 'SetInputMute': return {};
        case 'GetReplayBufferStatus': return { outputActive: true };
        case 'GetCurrentProgramScene': return { sceneName: scene };
        case 'GetCurrentSceneTransition': return { transitionDuration: 0 };
        case 'SaveReplayBuffer': {
          const savedReplayPath = `clip-${++savedCount}.mkv`;
          setTimeout(() => emit('ReplayBufferSaved', { savedReplayPath }), 20);
          return {};
        }
        case 'SetInputSettings':
          speed = fields.inputSettings.speed_percent ?? 100;
          cursor = 0;
          mediaState = 'OBS_MEDIA_STATE_PLAYING';
          loadedDuration = fields.inputSettings.local_file === 'trimmed.mp4' ? preparedDuration() : mediaDuration;
          return {};
        case 'GetMediaInputStatus': return { mediaState, mediaDuration: loadedDuration, mediaCursor: Math.floor(cursor) };
        case 'SetMediaInputCursor':
          cursor = seekToKeyframe;
          return {};
        case 'TriggerMediaInputAction':
          mediaState = {
            OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE: 'OBS_MEDIA_STATE_PAUSED',
            OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY: 'OBS_MEDIA_STATE_PLAYING',
            OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP: 'OBS_MEDIA_STATE_STOPPED',
          }[fields.mediaAction];
          assert.ok(mediaState, `Unexpected media action ${fields.mediaAction}`);
          return {};
        case 'SetCurrentProgramScene':
          scene = fields.sceneName;
          emit('CurrentProgramSceneChanged', { sceneName: scene });
          return {};
        default: throw Error(`Unexpected OBS request ${type}`);
      }
    } };
  }

  return { calls, connect };
}

async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await wait(20);
  return predicate();
}

function finishRound(replay, frags) {
  const finalFrag = frags.at(-1);
  replay.ingest({ ...game, phase: 'over', frags,
    players: players.map(player => player.side === 'T' ? { ...player, health: 0 } : player),
    roundResult: { id: 'round-1', at: finalFrag.at, round: 1, side: 'CT', reason: 'elimination' } });
}

test('shows the last frag in a multi-kill at 50% after preparing the keyframe seek off air', async () => {
  const { calls, connect } = fakeObs();
  const replay = createObsReplay({}, connect);
  await replay.setEnabled(true);
  assert.doesNotThrow(() => replay.ingest(null));
  replay.ingest(game);
  const first = frag('first');
  replay.ingest({ ...game, frags: [first], players: players.map(player => player.slot === 3 ? { ...player, health: 0 } : player) });
  await wait(1200);
  const final = frag('final');
  finishRound(replay, [first, final]);

  const played = () => calls.find(call => call.fields?.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY');
  assert.ok(await until(played), 'The selected clip played in OBS');
  const [firstSave, finalSave] = calls.filter(call => call.type === 'SaveReplayBuffer');
  assert.ok(firstSave && finalSave);
  assert.ok(finalSave.at - final.at >= 740, 'Capture includes time after the final kill');
  const settings = calls.find(call => call.type === 'SetInputSettings').fields.inputSettings;
  assert.equal(settings.local_file, 'clip-2.mkv');
  assert.equal(settings.speed_percent, 50);
  assert.equal(settings.restart_on_activate, false);

  const seek = calls.find(call => call.type === 'SetMediaInputCursor');
  const pause = calls.find(call => call.fields?.mediaAction === 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE');
  const aired = calls.find(call => call.type === 'SetCurrentProgramScene' && call.fields.sceneName === replayScene);
  assert.equal(seek.scene, matchScene);
  assert.equal(pause.scene, matchScene);
  assert.ok(pause.at > seek.at, 'Decoding from the earlier keyframe takes place off air');
  assert.ok(calls.indexOf(pause) < calls.indexOf(aired));
  assert.equal(played().scene, replayScene);
  const finalFragCursor = duration - (finalSave.at - final.at);
  const lead = finalFragCursor - played().cursor;
  assert.ok(lead >= 500 && lead <= 1000, `Final frag lead-in was ${lead} ms`);
  assert.equal(replay.current().speed, 50);

  assert.ok(await until(() => replay.current() == null));
  const returned = calls.find(call => call.type === 'SetCurrentProgramScene' && call.fields.sceneName === matchScene);
  assert.ok(returned, 'Replay returns to the match scene');
  assert.ok(returned.cursor > finalFragCursor + 490, 'The return occurs after the final frag and its visible aftermath');
  assert.doesNotThrow(() => replay.ingest(null));
  assert.equal(replay.status().enabled, true);
});

test('keeps the match on air when the capture is too short to include the kill window', async () => {
  const { calls, connect } = fakeObs({ mediaDuration: 1100 });
  const replay = createObsReplay({}, connect);
  await replay.setEnabled(true);
  replay.ingest(game);
  finishRound(replay, [frag('final')]);
  assert.equal(replay.pending(), true);
  assert.ok(await until(() => !replay.pending()));
  assert.equal(replay.current(), null);
  assert.ok(calls.some(call => call.type === 'GetMediaInputStatus'));
  assert.ok(!calls.some(call => call.type === 'SetCurrentProgramScene'));
});

test('plays an accurately trimmed clip immediately even with a distant keyframe', async () => {
  let bounds;
  let cleaned = false;
  const { calls, connect } = fakeObs({ seekToKeyframe: 4000, preparedDuration: () => bounds.duration });
  const replay = createObsReplay({}, connect, async (file, window) => {
    assert.equal(file, 'clip-1.mkv');
    bounds = window;
    return { path: 'trimmed.mp4', async cleanup() { cleaned = true; } };
  });
  await replay.setEnabled(true);
  replay.ingest(game);
  finishRound(replay, [frag('trimmed-final')]);
  assert.ok(await until(() => replay.status().lastAttempt?.outcome === 'playing', 2200));
  assert.equal(bounds.duration, 1490);
  assert.ok(bounds.start > 7400 && bounds.start < 8150);
  assert.ok(!calls.some(call => call.type === 'SetMediaInputCursor'));
  await replay.setEnabled(false);
  assert.ok(await until(() => cleaned));
});
