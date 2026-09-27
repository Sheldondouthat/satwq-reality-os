import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBluramsStatus, attachFrameSource } from './bluramsHook.js';

test('getBluramsStatus is honest: no live feed, paths documented', () => {
  const status = getBluramsStatus();
  assert.equal(status.live, false);
  assert.match(status.reason, /no browser-reachable/i);
  assert.ok(status.paths.length >= 2);
});

test('attachFrameSource validates its inputs', () => {
  assert.throws(() => attachFrameSource(null, { getFrame: async () => ({}) }), /canvas/);
  assert.throws(
    () => attachFrameSource({ getContext: () => ({}) }, {}),
    /getFrame/,
  );
});

test('attachFrameSource draws frames and detaches cleanly', async () => {
  const drawn = [];
  const canvasEl = {
    width: 160,
    height: 90,
    getContext: () => ({
      clearRect: () => {},
      drawImage: (...args) => drawn.push(args),
    }),
  };
  const frame = { fake: 'frame' };
  const source = {
    getFrame: async () => frame,
    intervalMs: 60_000, // long cadence; we detach before it fires
    onError: () => {},
  };
  const handle = attachFrameSource(canvasEl, source);
  assert.equal(typeof handle.detach, 'function');
  assert.equal(typeof handle.refresh, 'function');
  // Let the immediate first-frame refresh finish before asserting.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0][0], frame);
  await handle.refresh();
  assert.equal(drawn.length, 2);
  handle.detach();
  handle.detach(); // idempotent
});

test('attachFrameSource auto-detaches after repeated failures', async () => {
  const canvasEl = {
    width: 160,
    height: 90,
    getContext: () => ({ clearRect: () => {}, drawImage: () => {} }),
  };
  const errors = [];
  const source = {
    getFrame: async () => { throw new Error('bridge down'); },
    intervalMs: 60_000,
    onError: (err) => errors.push(err),
  };
  const handle = attachFrameSource(canvasEl, source);
  // Let the immediate first-frame refresh fail once, then drive 5 more.
  await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 5; i++) await handle.refresh();
  assert.ok(errors.length >= 5, `expected >=5 errors, got ${errors.length}`);
  handle.detach();
});
