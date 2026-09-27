import assert from 'node:assert/strict';
import test from 'node:test';
import { createRainviewerRadarLayer, createRainviewerRadarSource } from './index.js';

test('rainviewer-radar layer id/name/source wiring', () => {
  assert.equal(typeof createRainviewerRadarSource().getSnapshot, 'function');
  const layer = createRainviewerRadarLayer();
  assert.equal(layer.id, 'rainviewer-radar');
  assert.equal(layer.name, 'RainViewer Radar');
  assert.equal(layer.icon, '🌧️');
  assert.equal(layer.source, 'RainViewer');
  assert.equal(layer.updateInterval, 10 * 60 * 1000);
});
