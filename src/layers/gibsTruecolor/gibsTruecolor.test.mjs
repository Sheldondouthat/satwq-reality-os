import assert from 'node:assert/strict';
import test from 'node:test';
import { createGibsTruecolorLayer, createGibsTruecolorSource } from './index.js';

test('gibs-truecolor layer id/name/source wiring', () => {
  assert.equal(typeof createGibsTruecolorSource().getSnapshot, 'function');
  const layer = createGibsTruecolorLayer();
  assert.equal(layer.id, 'gibs-truecolor');
  assert.equal(layer.name, 'NASA True Color');
  assert.equal(layer.icon, '🛰️');
  assert.equal(layer.source, 'NASA GIBS');
  assert.equal(layer.updateInterval, 6 * 3600 * 1000);
});
