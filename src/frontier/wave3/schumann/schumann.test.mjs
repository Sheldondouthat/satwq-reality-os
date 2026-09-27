import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml } from './model.js';

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<img>'), '&lt;img&gt;');
  assert.equal(escapeHtml(null), '');
});
