import assert from 'node:assert/strict';
import test from 'node:test';
import { createGibsSstLayer, createGibsSstSource } from './index.js';

test('gibs-sst layer id/name/source wiring', () => {
  assert.equal(typeof createGibsSstSource().getSnapshot, 'function');
  const layer = createGibsSstLayer();
  assert.equal(layer.id, 'gibs-sst');
  assert.equal(layer.name, 'Sea Surface Temp');
  assert.equal(layer.icon, '🌡️');
  assert.equal(layer.source, 'NASA GIBS');
  assert.equal(layer.updateInterval, 6 * 3600 * 1000);
});
