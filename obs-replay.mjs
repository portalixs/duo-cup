import { setTimeout as wait } from 'node:timers/promises';
import { createObsConnection } from './obs-websocket.mjs';
import { createReplaySelector } from './replay-selection.mjs';

const matchScene = '02 · Матч CS2';
const replayScene = '05 · Повтор';
const media = { inputName: 'DUO CUP · клип повтора' };
const activePhases = new Set(['live', 'bomb', 'defuse']);
const handoffLimit = 5100;
const slowPercent = 50;
const saveTailMs = 760;
const leadMs = 940;
const minimumLeadMs = 530;
const visibleTailMs = 550;
const freezeOverlapMs = 4400;
const statusPollMs = 40;
const mediaAction = action => `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${action}`;

function clipWindow(duration, candidate, capture, returnedAt) {
  const afterFrag = capture.at - candidate.at;
  if (afterFrag < 580 || !Number.isFinite(duration) || duration <= afterFrag + minimumLeadMs) return null;
  const frag = duration - afterFrag;
  const first = Math.max(0, frag - leadMs, frag + returnedAt + 150 - candidate.at);
  const lastStart = frag - minimumLeadMs;
  if (first > lastStart) return null;
  return { first, lastStart, last: frag + visibleTailMs };
}

export function createObsReplay(config, connect = createObsConnection) {
  const selector = createReplaySelector();
  const captures = new Map();
  let enabled = false;
  let latest;
  let freezeAt;
  let data;
  let awaitingReplay;
  let showing;
  let saveQueue = Promise.resolve();
  let generation = 0;
  let enableRequest = 0;
  let pendingSave;
  let nextConnectionAttempt = 0;
  let returnedAt = 0;
  let lastWarning = '';
  const { request } = connect(config ?? {}, (type, event) => {
    if (type === 'ReplayBufferSaved' && typeof event?.savedReplayPath === 'string') pendingSave?.(event.savedReplayPath);
    if (type === 'MediaInputPlaybackEnded' && event?.inputName === media.inputName && showing?.started) void finish(showing);
    if (type === 'CurrentProgramSceneChanged' && showing?.switched && event?.sceneName !== replayScene) {
      showing.cancelled = true;
      data = null;
      returnedAt = Date.now();
      if (showing.started) void finish(showing);
    }
  });

  function warn(error) {
    nextConnectionAttempt = Date.now() + 3000;
    if (lastWarning === error.message) return;
    lastWarning = error.message;
    console.warn(`Повтор OBS: ${error.message}`);
  }

  async function scene() {
    const result = await request('GetCurrentProgramScene');
    return result.sceneName ?? result.currentProgramSceneName;
  }

  async function save(candidate, version) {
    if (!enabled || version !== generation || showing?.switched || candidate.at <= returnedAt + 400 || Date.now() - candidate.at > 1100) return null;
    if (!(await request('GetReplayBufferStatus')).outputActive || await scene() !== matchScene) return null;
    // Allow the kill and its aftermath through the capture and encoder before saving.
    await wait(Math.max(0, candidate.at + saveTailMs - Date.now()));
    if (!enabled || version !== generation || showing?.switched || !sameMap(latest, candidate)
      || Date.now() - candidate.at > 1450 || await scene() !== matchScene) return null;
    const at = Date.now();
    let timer;
    try {
      const file = new Promise(resolve => {
        pendingSave = resolve;
        timer = setTimeout(() => resolve(null), 1350);
      });
      await request('SaveReplayBuffer');
      const path = await file;
      return path ? { path, at } : null;
    } finally {
      clearTimeout(timer);
      pendingSave = null;
    }
  }

  function capture(candidate) {
    if (showing || Date.now() < nextConnectionAttempt) return;
    if (captures.size >= 24) captures.delete(captures.keys().next().value);
    const version = generation;
    const pending = saveQueue.then(() => save(candidate, version)).catch(error => { warn(error); return null; });
    captures.set(candidate.id, pending);
    saveQueue = pending;
  }

  function sameMap(game, round) {
    return game?.matchId === round.matchId && game.mapId === round.mapId;
  }

  function canAir(round) {
    if (!enabled || !sameMap(latest, round) || latest.phase === 'warmup') return false;
    if (latest.phase === 'freezetime' && latest.round > round.round && Number.isFinite(latest.clockEnd)) {
      return latest.clockEnd - Date.now() > 400;
    }
    return !activePhases.has(latest.phase) || latest.round <= round.round;
  }

  function airUntil(round) {
    if (latest.phase !== 'freezetime' || latest.round <= round.round) return Infinity;
    return Math.min(freezeAt + freezeOverlapMs, Number.isFinite(latest.clockEnd) ? latest.clockEnd : Infinity);
  }

  function preloading(run) {
    return !run.cancelled && canAir(run.round) && Date.now() - run.round.at < handoffLimit;
  }

  function playback(action) {
    return request('TriggerMediaInputAction', { ...media, mediaAction: mediaAction(action) });
  }

  async function prepareClip(run, candidate, capture) {
    await request('SetInputMute', { ...media, inputMuted: true });
    await request('SetInputSettings', { ...media, inputSettings: {
      local_file: capture.path, is_local_file: true, speed_percent: slowPercent,
      restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false, looping: false,
    }, overlay: true });

    let window;
    const loadingUntil = Date.now() + 800;
    while (preloading(run) && Date.now() < loadingUntil) {
      const status = await request('GetMediaInputStatus', media, 600);
      if (status.mediaState === 'OBS_MEDIA_STATE_ERROR') return null;
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' && status.mediaDuration > 0) {
        window = clipWindow(status.mediaDuration, candidate, capture, returnedAt);
        break;
      }
      await wait(statusPollMs);
    }
    if (!window || !preloading(run)) return null;

    // OBS seeks to the preceding keyframe. Play off air through any excess lead-in.
    if (window.first > 0) await request('SetMediaInputCursor', { ...media, mediaCursor: Math.floor(window.lastStart) }, 850);
    while (preloading(run)) {
      const status = await request('GetMediaInputStatus', media, 600);
      if (status.mediaState !== 'OBS_MEDIA_STATE_PLAYING' || status.mediaCursor > window.lastStart + 45) return null;
      if (status.mediaCursor >= window.first - 30) {
        await playback('PAUSE');
        const pauseUntil = Date.now() + 240;
        while (preloading(run) && Date.now() < pauseUntil) {
          const paused = await request('GetMediaInputStatus', media, 600);
          if (paused.mediaCursor > window.lastStart + 65) return null;
          if (paused.mediaState === 'OBS_MEDIA_STATE_PAUSED' && paused.mediaCursor >= window.first - 35) {
            return { duration: (window.last - paused.mediaCursor) * 100 / slowPercent };
          }
          await wait(statusPollMs);
        }
        return null;
      }
      await wait(statusPollMs);
    }
    return null;
  }

  async function finish(run) {
    if (showing !== run || run.finishing) return;
    run.finishing = true;
    run.cancelled = true;
    clearTimeout(run.timer);
    try {
      if (run.switchRequest) await run.switchRequest.catch(() => {});
      if (run.switched && await scene() === replayScene) {
        if (run.started) await playback('PAUSE').catch(() => {});
        await request('SetCurrentProgramScene', { sceneName: matchScene });
        returnedAt = Date.now();
        // Keep the replay caption and last frame in the outgoing scene under the wipe.
        await wait(run.transitionMs);
      }
      if (run.prepared) await playback('STOP').catch(() => {});
    } catch (error) {
      warn(error);
      if (!run.retried) {
        run.retried = true;
        run.finishing = false;
        setTimeout(() => { void finish(run); }, 300).unref();
        return;
      }
    }
    if (showing === run) {
      data = null;
      showing = null;
    }
  }

  async function play(round) {
    if (showing || !canAir(round) || Date.now() < nextConnectionAttempt) return;
    const matches = round.candidates.map(candidate => [candidate, captures.get(candidate.id)]).filter(([, clip]) => clip);
    if (!matches.length) return;
    const run = { round, switched: false, started: false, cancelled: false, transitionMs: 0 };
    showing = run;
    try {
      if (await scene() !== matchScene) return;
      const transition = await request('GetCurrentSceneTransition').catch(() => ({}));
      const stinger = transition.transitionKind === 'obs_stinger_transition';
      const cutMs = stinger && Number.isSafeInteger(transition.transitionSettings?.transition_point)
        && transition.transitionSettings?.tp_type === 0 ? Math.min(1500, transition.transitionSettings.transition_point) : stinger ? 425 : 0;
      run.transitionMs = stinger ? Math.max(870, cutMs + 450) : Math.min(1000, transition.transitionDuration ?? 0);

      for (const [candidate, pending] of matches) {
        const capture = await pending;
        if (!preloading(run) || await scene() !== matchScene) return;
        if (!capture) continue;
        run.prepared = true;
        const clip = await prepareClip(run, candidate, capture);
        if (!clip) continue;
        if (!preloading(run) || await scene() !== matchScene) return;
        if (Date.now() + cutMs + clip.duration + run.transitionMs > airUntil(round)) continue;

        data = { title: candidate.title, name: candidate.name, round: candidate.round, speed: slowPercent, loading: false };
        run.switched = true;
        const switchedAt = Date.now();
        run.switchRequest = request('SetCurrentProgramScene', { sceneName: replayScene });
        await run.switchRequest;
        await wait(Math.max(0, switchedAt + cutMs - Date.now()));
        if (run.cancelled || !canAir(round)) return;
        await playback('PLAY');
        if (run.cancelled) return;
        run.started = true;
        run.timer = setTimeout(() => { void finish(run); }, clip.duration);
        return;
      }
    } finally {
      if (!run.started) await finish(run);
    }
  }

  function ingest(game) {
    if (game.phase === 'freezetime' && (latest?.phase !== game.phase || latest.round !== game.round || !sameMap(latest, game))) {
      freezeAt = Date.now();
    }
    latest = game;
    if (showing) {
      if (!canAir(showing.round)) void finish(showing);
      else if (showing.started && Date.now() + showing.transitionMs >= airUntil(showing.round)) void finish(showing);
    }
    if (!enabled) return;
    const { capture: candidate, roundEnd } = selector.ingest(game);
    if (candidate) capture(candidate);
    if (roundEnd?.candidates.some(candidate => captures.has(candidate.id))) {
      awaitingReplay = roundEnd;
      void play(roundEnd).catch(warn).finally(() => {
        if (awaitingReplay === roundEnd) awaitingReplay = null;
      });
    }
  }

  function stop() {
    generation++;
    awaitingReplay = null;
    if (showing) void finish(showing);
    selector.reset();
    captures.clear();
  }

  async function setEnabled(value) {
    const attempt = ++enableRequest;
    if (!value) {
      enabled = false;
      stop();
      return;
    }
    const { scenes } = await request('GetSceneList');
    if (!scenes.some(item => item.sceneName === matchScene) || !scenes.some(item => item.sceneName === replayScene)) {
      throw new Error('Импортируйте коллекцию DUO CUP со сценой «05 · Повтор»');
    }
    await request('GetInputSettings', media);
    if (!(await request('GetReplayBufferStatus')).outputActive) throw new Error('Запустите буфер повтора в OBS');
    if (attempt !== enableRequest) return;
    nextConnectionAttempt = 0;
    lastWarning = '';
    enabled = true;
  }

  return {
    ingest, stop, setEnabled,
    status: () => ({ enabled, playing: Boolean(data), error: lastWarning }),
    current: () => data ?? null,
    pending: () => Boolean(awaitingReplay),
  };
}
