import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplaySelector } from '../replay-selection.mjs';

const players = [
  { slot: 1, side: 'CT', name: 'A', health: 100, observed: true },
  { slot: 2, side: 'CT', name: 'B', health: 0 },
  { slot: 3, side: 'T', name: 'C', health: 100 },
  { slot: 4, side: 'T', name: 'D', health: 100 },
];
const live = { matchId: 'G1.1', mapId: 'de_mirage', phase: 'live', round: 3, ct: 1, t: 1, players };
const matchWinner = { id: 'result-3', at: 3000, side: 'CT', round: 3, reason: 'elimination' };
const over = { ...live, phase: 'over', ct: 2, roundResult: matchWinner };
const frag = (id, at) => ({ id, at, side: 'CT', slot: 1, name: 'A', count: 1 });

test('accepts a late final frag after a round result arrived without candidates', () => {
  const selector = createReplaySelector();
  selector.ingest(live, 2000);
  assert.equal(selector.ingest(over, 3000).roundEnd, null);

  const late = frag('late', 3210);
  const { capture, roundEnd } = selector.ingest({ ...over, frags: [late] }, 3210);
  assert.equal(capture?.id, late.id);
  assert.equal(roundEnd?.at, matchWinner.at);
  assert.equal(roundEnd?.id, matchWinner.id);
  assert.equal(roundEnd?.candidates[0]?.id, late.id);
  assert.equal(roundEnd?.candidates[0]?.title, 'Клатч 1×2');
  assert.equal(selector.ingest({ ...over, frags: [late] }, 3290).roundEnd, null);
});

test('updates the same round result when a newer frag outranks the first candidate', () => {
  const selector = createReplaySelector();
  const first = frag('first', 2150);
  const final = frag('final', 3190);
  selector.ingest(live, 2000);
  selector.ingest({ ...live, frags: [first] }, 2150);
  const initial = selector.ingest({ ...over, frags: [first] }, 3000).roundEnd;
  assert.equal(initial?.candidates[0]?.id, first.id);

  const refreshed = selector.ingest({ ...over, frags: [first, final] }, 3190).roundEnd;
  assert.equal(refreshed?.id, initial.id);
  assert.equal(refreshed?.at, initial.at);
  assert.deepEqual(refreshed?.candidates.map(candidate => candidate.id), [final.id, first.id]);
  const stale = frag('stale', 3900);
  assert.equal(selector.ingest({ ...over, frags: [stale] }, 3900).capture, null);
});

test('infers the previous winner from an isolated score update when the over packet is missing', () => {
  for (const phase of ['freezetime', 'live']) {
    const selector = createReplaySelector();
    const last = frag('last-observed', 2150);
    selector.ingest(live, 2000);
    selector.ingest({ ...live, frags: [last] }, 2150);
    const nextGame = { ...live, phase, round: 4, ct: 2 };
    const fallback = selector.ingest(nextGame, 3000).roundEnd;
    assert.equal(fallback?.round, 3);
    assert.equal(fallback?.side, 'CT');
    assert.equal(fallback?.candidates[0]?.id, last.id);
    assert.equal(selector.ingest(nextGame, 3100).roundEnd, null);
  }
});

test('rejects ambiguous score transitions, map swaps and stale GSI when inferring a missing result', () => {
  for (const next of [
    { ...live, phase: 'freezetime', round: 4, ct: 2, t: 2 },
    { ...live, phase: 'freezetime', round: 5, ct: 3 },
    { ...live, phase: 'freezetime', round: 4, ct: 2, matchId: 'G1.2' },
    { ...live, phase: 'freezetime', round: 4, ct: 2, mapId: 'de_anubis' },
  ]) {
    const selector = createReplaySelector();
    selector.ingest(live, 2000);
    selector.ingest({ ...live, frags: [frag('last-observed', 2150)] }, 2150);
    assert.equal(selector.ingest(next, 3000).roundEnd, null);
  }
  const selector = createReplaySelector();
  selector.ingest(live, 2000);
  selector.ingest({ ...live, frags: [frag('last-observed', 2150)] }, 2150);
  assert.equal(selector.ingest({ ...live, phase: 'freezetime', round: 4, ct: 2 }, 18000).roundEnd, null);
});
