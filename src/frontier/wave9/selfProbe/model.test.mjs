/**
 * Wave 9 — edge self-probe ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const doc = (summary) => ({ summary });

test('ROUTE matches the registry entry', () => {
  assert.equal(ROUTE, '/api/self-probe');
});

test('valueLine names reachable/total and edge revivals', () => {
  const line = valueLine(doc({ total: 12, reachable: 7, edgeNewlyReachable: 2 }));
  assert.ok(line.includes('7/12'), `reachable/total missing: ${line}`);
  assert.ok(line.includes('2 revived'), `revival metric missing: ${line}`);
});

test('valueLine null on unavailable doc', () => {
  assert.equal(valueLine({ error: 'selfprobe_unavailable' }), null);
  assert.equal(valueLine(null), null);
});

test('detailLine carries the verdict breakdown', () => {
  const line = detailLine(doc({ reachable: 7, feedCandidates: 2, botWalls: 3, notFound: 0, unreachable: 2, rateLimited: 0, serverErrors: 0, edgeNewlyReachable: 2 }));
  assert.ok(line.includes('Reachable 7'), line);
  assert.ok(line.includes('bot-walls 3'), line);
  assert.ok(line.includes('not proof of a machine-readable feed'), line);
});

test('detailLine degrades honestly on unavailable doc', () => {
  assert.equal(detailLine({ error: 'selfprobe_unavailable' }), '');
});

test('EMOJI and LABEL are set', () => {
  assert.equal(EMOJI, '📡');
  assert.ok(LABEL.length > 0);
});
