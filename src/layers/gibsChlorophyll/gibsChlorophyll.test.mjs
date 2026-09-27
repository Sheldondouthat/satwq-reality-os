import assert from 'node:assert/strict';
import test from 'node:test';
import { createGibsChlorophyllLayer, createGibsChlorophyllSource } from './index.js';

test('gibs-chlorophyll layer id/name/source wiring', () => {
  assert.equal(typeof createGibsChlorophyllSource().getSnapshot, 'function');
  const layer = createGibsChlorophyllLayer();
  assert.equal(layer.id, 'gibs-chlorophyll');
  assert.equal(layer.name, 'Ocean Chlorophyll');
  assert.equal(layer.icon, '🌊');
  assert.equal(layer.source, 'NASA GIBS');
  assert.equal(layer.updateInterval, 6 * 3600 * 1000);
});
