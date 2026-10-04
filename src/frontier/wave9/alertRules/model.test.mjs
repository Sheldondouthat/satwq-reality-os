/**
 * Wave 9 — alert rules ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const firingDoc = {
  firingCount: 2,
  rules: [
    { id: 'quake-m6', ok: true },
    { id: 'nws-severe', ok: true },
  ],
  firings: [
    { severity: 'critical', title: 'M7.2 earthquake — SYNTHETIC test trench' },
    { severity: 'medium', title: 'Ground Delay Programs — AUS' },
  ],
  notify: { topic: 'satwq-alerts' },
};

const quietDoc = {
  firingCount: 0,
  rules: [
    { id: 'quake-m6', ok: true },
    { id: 'nws-severe', ok: false },
  ],
  firings: [],
  notify: { topic: 'satwq-alerts' },
};

test('ROUTE matches the registry entry', () => {
  assert.equal(ROUTE, '/api/alert-rules');
});

test('valueLine names the firing count and top firing', () => {
  const line = valueLine(firingDoc);
  assert.ok(line.includes('2 firing'), `count missing: ${line}`);
  assert.ok(line.includes('M7.2 earthquake'), `top firing missing: ${line}`);
  assert.ok(line.includes('+1 more'), `overflow missing: ${line}`);
});

test('valueLine is quiet-is-real when nothing fires', () => {
  const line = valueLine(quietDoc);
  assert.ok(line.includes('quiet'), `quiet missing: ${line}`);
  assert.ok(line.includes('1/2 rules ok'), `rule health missing: ${line}`);
});

test('valueLine null on unavailable doc', () => {
  assert.equal(valueLine({ error: 'alertrules_unavailable' }), null);
  assert.equal(valueLine(null), null);
});

test('detailLine lists firings and the heuristic disclaimer', () => {
  const line = detailLine(firingDoc);
  assert.ok(line.includes('[critical] M7.2 earthquake'), line);
  assert.ok(line.includes('heuristic thresholds'), line);
  assert.ok(line.includes('satwq-alerts'), line);
});

test('detailLine degrades honestly on unavailable doc', () => {
  assert.equal(detailLine({ error: 'alertrules_unavailable' }), '');
});

test('EMOJI and LABEL are set', () => {
  assert.equal(EMOJI, '🚨');
  assert.ok(LABEL.length > 0);
});
