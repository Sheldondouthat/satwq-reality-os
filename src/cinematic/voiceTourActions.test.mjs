import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTourVoiceActions } from './voiceTourActions.js';

function makeFakes() {
  const tour = {
    started: 0,
    stopped: 0,
    running: false,
    start() {
      this.started += 1;
      this.running = true;
      return true;
    },
    stop() {
      this.stopped += 1;
      this.running = false;
      return true;
    },
  };
  const ambience = {
    enabled: false,
    setEnabled(on) {
      this.enabled = Boolean(on);
      return this.enabled;
    },
  };
  const calls = [];
  const base = async (name, args = {}, options = {}) => {
    calls.push({ name, args, options });
    return { ok: true, action: name, delegated: true };
  };
  return { tour, ambience, base, calls };
}

test('start_tour delegates to the tour director', async () => {
  const { tour, ambience, base, calls } = makeFakes();
  const run = withTourVoiceActions(base, { tourDirector: tour, ambientEngine: ambience });
  const res = await run('start_tour');
  assert.equal(res.ok, true);
  assert.equal(res.running, true);
  assert.equal(tour.started, 1);
  assert.equal(calls.length, 0);
});

test('stop_tour stops the tour and reports running:false', async () => {
  const { tour, ambience, base } = makeFakes();
  const run = withTourVoiceActions(base, { tourDirector: tour, ambientEngine: ambience });
  await run('start_tour');
  const res = await run('stop_tour');
  assert.equal(res.ok, true);
  assert.equal(res.stopped, true);
  assert.equal(res.running, false);
  assert.equal(tour.stopped, 1);
});

test('set_ambience toggles the engine (on and off)', async () => {
  const { tour, ambience, base } = makeFakes();
  const run = withTourVoiceActions(base, { tourDirector: tour, ambientEngine: ambience });
  let res = await run('set_ambience', { enabled: true });
  assert.equal(res.enabled, true);
  assert.equal(ambience.enabled, true);
  res = await run('set_ambience', { enabled: false });
  assert.equal(res.enabled, false);
});

test('unknown actions pass through to the base runner untouched', async () => {
  const { tour, ambience, base, calls } = makeFakes();
  const run = withTourVoiceActions(base, { tourDirector: tour, ambientEngine: ambience });
  const res = await run('fly_to_location', { latitude: 10, longitude: 20 }, { signal: 's' });
  assert.equal(res.delegated, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { latitude: 10, longitude: 20 });
  assert.deepEqual(calls[0].options, { signal: 's' });
});

test('missing collaborators degrade gracefully', async () => {
  const { base } = makeFakes();
  const run = withTourVoiceActions(base, {});
  const res = await run('start_tour');
  assert.equal(res.ok, false);
  assert.equal(res.running, false);
});
