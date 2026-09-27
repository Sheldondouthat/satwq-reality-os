import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, formatAnalysisDate } from './model.js';

test('formatAnalysisDate renders YYYYMMDD', () => {
  assert.equal(formatAnalysisDate('20260925'), 'Sep 25, 2026');
  assert.equal(formatAnalysisDate('20250103'), 'Jan 3, 2025');
  assert.equal(formatAnalysisDate('bogus'), '—');
  assert.equal(formatAnalysisDate(null), '—');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<img onerror>'), '&lt;img onerror&gt;');
});
