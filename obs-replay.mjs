import { setTimeout as wait } from 'node:timers/promises';
import { createObsConnection } from './obs-websocket.mjs';
import { createReplaySelector } from './replay-selection.mjs';

const matchScene = '02 · Матч CS2';
const replayScene = '05 · Повтор';
const media = { inputName: 'DUO CUP · клип повтора' };
const activePhases = new Set(['live', 'bomb', 'defuse']);
const handoffLimit = 2200;
const playLimit = 6200;

export function createObsReplay(config, connect = createObsConnection) {
  const selector = createReplaySelector();
  const captures = new Map();
  let enabled = false;
  let latest;
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
    if (!enabled || version !== generation || showing || candidate.at <= returnedAt + 400 || Date.now() - candidate.at > 1100) return null;
    if (!(await request('GetReplayBufferStatus')).outputActive || await scene() !== matchScene) return null;
    // The observed frag arrives via GSI. Leave a short tail for encoder frames already queued in OBS.
    await wait(Math.max(0, candidate.at + 280 - Date.now()));
    if (!enabled || version !== generation || showing || !sameMap(latest, candidate) || Date.now() - candidate.at > 1200) return null;
    const at = Date.now();
    let timer;
    try {
      const file = new Promise(resolve => {
        pendingSave = resolve;
        timer = setTimeout(() => resolve(null), 1350);
      });
      await request('SaveReplayBuffer');
      const path = await file;
      return path ? { path, at, candidate } : null;
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

  async function finish(run) {
    if (showing !== run || run.finishing) return;
    run.finishing = true;
    run.cancelled = true;
    data = null;
    clearTimeout(run.timer);
    clearTimeout(run.freezeTimer);
    try {
      if (run.switchRequest) await run.switchRequest.catch(() => {});
      if (run.switched && await scene() === replayScene) {
        await request('SetCurrentProgramScene', { sceneName: matchScene });
        returnedAt = Date.now();
      }
    } catch (error) {
      warn(error);
      if (!run.retried) {
        run.retried = true;
        run.finishing = false;
        setTimeout(() => { void finish(run); }, 300).unref();
        return;
      }
    }
    if (showing === run) showing = null;
  }

  async function play(round) {
    if (showing || !canAir(round) || Date.now() < nextConnectionAttempt) return;
    const matches = round.candidates.map(candidate => [candidate, captures.get(candidate.id)]).filter(([, clip]) => clip);
    if (!matches.length) return;
    let selected;
    for (const [candidate, pending] of matches) {
      const capture = await pending;
      if (!canAir(round) || Date.now() - round.at > handoffLimit) return;
      if (capture) {
        selected = { candidate, capture };
        break;
      }
    }
    if (!selected || showing) return;
    const { candidate, capture } = selected;
    const run = { round, switched: false, started: false, cancelled: false };
    showing = run;
    try {
      if (await scene() !== matchScene) return;
      await request('SetInputSettings', { ...media, inputSettings: { local_file: capture.path }, overlay: true });
      await request('SetInputMute', { ...media, inputMuted: true });
      if (run.cancelled || !canAir(round) || await scene() !== matchScene || Date.now() - round.at > handoffLimit) return;
      data = { title: candidate.title, name: candidate.name, round: candidate.round, loading: true };
      await wait(Math.max(140, round.at + 450 - Date.now()));
      if (run.cancelled || !canAir(round) || await scene() !== matchScene || Date.now() - round.at > handoffLimit) return;
      run.switched = true;
      run.switchRequest = request('SetCurrentProgramScene', { sceneName: replayScene });
      await run.switchRequest;
      if (run.cancelled) return;
      run.timer = setTimeout(() => { void finish(run); }, playLimit);
      let status;
      const readyBy = Date.now() + 950;
      do {
        status = await request('GetMediaInputStatus', media, 600);
        if (status.mediaDuration > 0 && status.mediaState === 'OBS_MEDIA_STATE_PLAYING') break;
        await wait(55);
      } while (!run.cancelled && Date.now() < readyBy);
      if (run.cancelled || !canAir(round) || status.mediaState !== 'OBS_MEDIA_STATE_PLAYING' || status.mediaDuration <= 0) return;
      const startAt = Math.max(candidate.startAt - 1150, returnedAt + 150);
      const duration = Math.min(playLimit, capture.at - startAt);
      const cursor = Math.max(0, status.mediaDuration - duration);
      if (cursor > 0) {
        await request('SetMediaInputCursor', { ...media, mediaCursor: cursor }, 850);
        await wait(80);
      }
      if (run.cancelled) return;
      run.started = true;
      data = { ...data, loading: false };
      if (latest.phase === 'freezetime' && latest.round > round.round) timeNextRound(run);
    } finally {
      if (!run.started) await finish(run);
    }
  }

  function timeNextRound(run) {
    run.freezeTimer ??= setTimeout(() => { void finish(run); }, 2200);
  }

  function ingest(game) {
    latest = game;
    if (showing) {
      if (!canAir(showing.round)) void finish(showing);
      else if (game.phase === 'freezetime' && game.round > showing.round.round) timeNextRound(showing);
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
