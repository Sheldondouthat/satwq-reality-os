import assert from 'node:assert/strict';
import test from 'node:test';
import { createGibsNightlightsLayer, createGibsNightlightsSource } from './index.js';

test('gibs-nightlights layer id/name/source wiring', () => {
  assert.equal(typeof createGibsNightlightsSource().getSnapshot, 'function');
  const layer = createGibsNightlightsLayer();
  assert.equal(layer.id, 'gibs-nightlights');
  assert.equal(layer.name, 'Black Marble Night Lights');
  assert.equal(layer.icon, '🌃');
  assert.equal(layer.source, 'NASA GIBS');
  assert.equal(layer.updateInterval, 6 * 3600 * 1000);
});
