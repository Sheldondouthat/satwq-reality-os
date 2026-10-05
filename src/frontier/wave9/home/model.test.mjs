/**
 * Wave 9 — home view ticker model tests (pure, no DOM).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE,
  EMOJI,
  LABEL,
  valueLine,
  detailLine,
  degradedSections,
} from './model.js';

const DOC = {
  home: {
    name: 'Pembroke, VA 24136',
    lat: 37.31957,
    lon: -80.63895,
    isDefault: true,
  },
  weather: {
    ok: true,
    tempF: 59.6,
    feelsLikeF: 58.5,
    weatherWord: 'Overcast',
    highF: 65.5,
    lowF: 54.8,
  },
  alerts: { ok: true, count: 0, severe: [], alerts: [] },
  airQuality: { ok: true, model: true, current: { usAqi: 30 } },
  tripwires: { ok: true, firingCount: 0, firing: [] },
  briefing: { url: '/api/morning-briefing' },
  sources: {
    weather: { ok: true, stale: false },
    alerts: { ok: true, stale: false },
    air: { ok: false, error: 'home_fetch_failed' },
  },
  honesty: { aggregation: 'x' },
};

test('ROUTE / EMOJI / LABEL', () => {
  assert.equal(ROUTE, '/api/home');
  assert.equal(EMOJI, '🏠');
  assert.equal(LABEL, 'Home — Pembroke VA');
});

test('valueLine: quiet home reads quiet', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('59.6°F'), line);
  assert.ok(line.includes('Overcast'), line);
  assert.ok(line.includes('AQI 30'), line);
  assert.ok(line.includes('no active alerts'), line);
  assert.ok(!line.includes('🚨'), 'no tripwires → no alarm glyph');
});

test('valueLine: firing tripwires surface in the line', () => {
  const doc = { ...DOC, tripwires: { ok: true, firingCount: 3, firing: [] } };
  assert.ok(valueLine(doc).includes('🚨 3'), valueLine(doc));
});

test('valueLine: alert count renders', () => {
  const doc = {
    ...DOC,
    alerts: { ok: true, count: 2, alerts: [{ event: 'Flood Watch' }] },
  };
  assert.ok(valueLine(doc).includes('2 alerts'), valueLine(doc));
});

test('valueLine: unavailable doc → null', () => {
  assert.equal(valueLine({ error: 'home_unavailable' }), null);
  assert.equal(valueLine(null), null);
});

test('detailLine: names quiet states and briefing link', () => {
  const d = detailLine(DOC);
  assert.ok(d.includes('No active NWS alerts'), d);
  assert.ok(d.includes('CAMS model'), d);
  assert.ok(d.includes('No tripwires firing'), d);
  assert.ok(d.includes('/api/morning-briefing'), d);
});

test('degradedSections: lists failed sections', () => {
  assert.deepEqual(degradedSections(DOC), ['air']);
});
