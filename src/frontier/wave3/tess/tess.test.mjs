import assert from 'node:assert/strict';
import test from 'node:test';
import { countdown, dispositionLabel, escapeHtml } from './model.js';

test('countdown formats hoursUntil', () => {
  assert.equal(countdown(0.3), 'in 18m');
  assert.equal(countdown(3.2), 'in 3.2h');
  assert.equal(countdown(72), 'in 3.0d');
  assert.equal(countdown(-1), 'now');
  assert.equal(countdown(NaN), '—');
});

test('dispositionLabel expands PC/CP honestly', () => {
  assert.equal(dispositionLabel('CP'), 'confirmed planet');
  assert.equal(dispositionLabel('PC'), 'planet candidate');
  assert.equal(dispositionLabel('FP'), 'FP');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<b>1.01</b>'), '&lt;b&gt;1.01&lt;/b&gt;');
});
