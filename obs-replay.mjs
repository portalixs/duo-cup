import { setTimeout as wait } from 'node:timers/promises';
import { createObsConnection } from './obs-websocket.mjs';
import { createReplaySelector } from './replay-selection.mjs';

const matchScene = '02 · Матч CS2';
const replayScene = '05 · Повтор';
const media = { inputName: 'DUO CUP · клип повтора' };
const activePhases = new Set(['live', 'bomb', 'defuse']);
const handoffLimit = 9600;
const slowPercent = 50;
const saveTailMs = 760;
const leadMs = 940;
const minimumLeadMs = 530;
const visibleTailMs = 550;
const freezeOverlapMs = 6500;
const statusPollMs = 40;
const roundSettleMs = 850;
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

export function createObsReplay(config, connect = createObsConnection, trimClip = null) {
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
  let lastAttempt = null;
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

  function recordAttempt(round, outcome) {
    lastAttempt = { round, outcome, at: Date.now() };
  }

  async function scene() {
    const result = await request('GetCurrentProgramScene');
    return result.sceneName ?? result.currentProgramSceneName;
  }

  async function save(candidate, version) {
    if (!enabled || version !== generation || showing?.switched || candidate.at <= returnedAt + 400 || Date.now() - candidate.at > 2300) return null;
    if (!(await request('GetReplayBufferStatus')).outputActive) {
      recordAttempt(candidate.round, 'buffer-stopped');
      return null;
    }
    if (await scene() !== matchScene) {
      recordAttempt(candidate.round, 'not-in-match-scene');
      return null;
    }
    // Allow the kill and its aftermath through the capture and encoder before saving.
    await wait(Math.max(0, candidate.at + saveTailMs - Date.now()));
    if (!enabled || version !== generation || showing?.switched || !sameMap(latest, candidate)
      || Date.now() - candidate.at > 2350 || await scene() !== matchScene) return null;
    const at = Date.now();
    let timer;
    try {
      const file = new Promise(resolve => {
        pendingSave = resolve;
        timer = setTimeout(() => resolve(null), 1350);
      });
      await request('SaveReplayBuffer');
      const path = await file;
      recordAttempt(candidate.round, path ? 'saved' : 'save-timeout');
      return path ? { path, at } : null;
    } finally {
      clearTimeout(timer);
      pendingSave = null;
    }
  }

  function capture(candidate) {
    if (showing?.switched || Date.now() < nextConnectionAttempt) return;
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
    return Number.isFinite(latest.clockEnd) ? latest.clockEnd : freezeAt + freezeOverlapMs;
  }

  function preloading(run) {
    return !run.cancelled && canAir(run.round) && Date.now() - run.round.at < handoffLimit;
  }

  function playback(action) {
    return request('TriggerMediaInputAction', { ...media, mediaAction: mediaAction(action) });
  }

  async function mediaReady(run, duration) {
    const loadingUntil = Date.now() + 800;
    while (preloading(run) && Date.now() < loadingUntil) {
      const status = await request('GetMediaInputStatus', media, 600);
      if (status.mediaState === 'OBS_MEDIA_STATE_PLAYING' && status.mediaDuration > 0
        && (duration == null || Math.abs(status.mediaDuration - duration) < 150)) return status;
      await wait(statusPollMs);
    }
    return null;
  }

  async function releaseTrimmed(run) {
    if (!run.trimmed) return;
    const clip = run.trimmed;
    run.trimmed = null;
    await request('SetInputSettings', { ...media, inputSettings: { local_file: '' }, overlay: true }).catch(() => {});
    await clip.cleanup().catch(() => {});
  }

  async function prepareClip(run, candidate, capture) {
    await request('SetInputMute', { ...media, inputMuted: true });
    const load = path => request('SetInputSettings', { ...media, inputSettings: {
      local_file: path, is_local_file: true, speed_percent: slowPercent,
      restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false, looping: false,
    }, overlay: true });

    await load(capture.path);
    const status = await mediaReady(run);
    let window = clipWindow(status?.mediaDuration, candidate, capture, returnedAt);
    if (!window || !preloading(run)) return null;

    if (trimClip) {
      const duration = window.last - window.first;
      run.trimmed = await trimClip(capture.path, { start: window.first, duration }).catch(() => null);
      if (run.trimmed) {
        if (!preloading(run)) { await releaseTrimmed(run); return null; }
        await load(run.trimmed.path);
        if (!await mediaReady(run, duration)) return null;
        window = { first: 0, lastStart: window.lastStart - window.first, last: duration };
      }
    }

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
      await releaseTrimmed(run);
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
    const run = { round, switched: false, started: false, cancelled: false, transitionMs: 0 };
    showing = run;
    try {
      if (await scene() !== matchScene) {
        recordAttempt(round.round, 'not-in-match-scene');
        return;
      }
      const transition = await request('GetCurrentSceneTransition').catch(() => ({}));
      const stinger = transition.transitionKind === 'obs_stinger_transition';
      const cutMs = stinger && Number.isSafeInteger(transition.transitionSettings?.transition_point)
        && transition.transitionSettings?.tp_type === 0 ? Math.min(1500, transition.transitionSettings.transition_point) : stinger ? 425 : 0;
      run.transitionMs = stinger ? Math.max(870, cutMs + 450) : Math.min(1000, transition.transitionDuration ?? 0);

      await wait(Math.max(0, round.at + roundSettleMs - Date.now()));
      const attempted = new Set();
      while (preloading(run)) {
        const candidate = round.candidates.find(item => !attempted.has(item.id) && captures.has(item.id));
        if (!candidate) return;
        attempted.add(candidate.id);
        await releaseTrimmed(run);
        const capture = await captures.get(candidate.id);
        if (!preloading(run) || await scene() !== matchScene) return;
        if (!capture) continue;
        run.prepared = true;
        const clip = await prepareClip(run, candidate, capture);
        if (!clip) {
          recordAttempt(round.round, 'clip-not-ready');
          continue;
        }
        if (!preloading(run) || await scene() !== matchScene) return;
        if (Date.now() + cutMs + clip.duration + run.transitionMs > airUntil(round)) {
          recordAttempt(round.round, 'not-enough-freeze-time');
          continue;
        }

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
        recordAttempt(round.round, 'playing');
        run.timer = setTimeout(() => { void finish(run); }, clip.duration);
        return;
      }
    } finally {
      if (!run.started) await finish(run);
    }
  }

  function ingest(game) {
    if (!game) {
      latest = null;
      freezeAt = undefined;
      if (showing || awaitingReplay || captures.size) stop();
      else selector.reset();
      return;
    }
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
      if (awaitingReplay?.id === roundEnd.id) {
        awaitingReplay.candidates = roundEnd.candidates;
        return;
      }
      if (showing) return;
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
    lastAttempt = null;
    enabled = true;
  }

  return {
    ingest, stop, setEnabled,
    status: () => ({ enabled, playing: Boolean(data), error: lastWarning, lastAttempt }),
    current: () => data ?? null,
    pending: () => Boolean(awaitingReplay),
  };
}
