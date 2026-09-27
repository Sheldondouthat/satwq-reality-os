import assert from 'node:assert/strict';
import test from 'node:test';
import { createRainviewerSatelliteLayer, createRainviewerSatelliteSource } from './index.js';

test('rainviewer-satellite layer id/name/source wiring', () => {
  assert.equal(typeof createRainviewerSatelliteSource().getSnapshot, 'function');
  const layer = createRainviewerSatelliteLayer();
  assert.equal(layer.id, 'rainviewer-satellite');
  assert.equal(layer.name, 'RainViewer Satellite IR');
  assert.equal(layer.icon, '📡');
  assert.equal(layer.source, 'RainViewer');
  assert.equal(layer.updateInterval, 10 * 60 * 1000);
});
