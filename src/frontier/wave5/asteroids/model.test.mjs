import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchAsteroids,
  parseCd,
  sortApproaches,
  approachDelta,
  ldBadge,
  brightnessClass,
  approachTitle,
  formatLd,
  windowSummary,
  escapeHtml,
} from './model.js';

const NOW = Date.parse('2026-09-27T15:30:00Z');

test('parseCd reads CAD UTC datetime strings', () => {
  assert.equal(parseCd('2026-10-05 12:34:56.789'), Date.parse('2026-10-05T12:34:56.789Z'));
  assert.equal(parseCd('2026-10-15 00:00:00.000'), Date.parse('2026-10-15T00:00:00.000Z'));
  assert.ok(Number.isNaN(parseCd('not a date')));
  assert.ok(Number.isNaN(parseCd(null)));
});

test('sortApproaches orders chronologically, unparseable last', () => {
  const out = sortApproaches([
    { des: 'b', cd: '2026-10-15 00:00:00.000' },
    { des: 'junk', cd: 'garbage' },
    { des: 'a', cd: '2026-10-05 12:34:56.789' },
  ]);
  assert.deepEqual(out.map((a) => a.des), ['a', 'b', 'junk']);
});

test('approachDelta counts down and back up', () => {
  assert.equal(approachDelta('2026-09-27 16:00:00.000', NOW), 'in 30m');
  assert.equal(approachDelta('2026-09-29 17:30:00.000', NOW), 'in 2d 2h');
  assert.equal(approachDelta('2026-09-27 14:00:00.000', NOW), '1h 30m ago');
  assert.equal(approachDelta('garbage', NOW), 'date n/a');
});

test('ldBadge frames by Moon-orbit bands', () => {
  assert.deepEqual(ldBadge(0.48), { label: 'inside the Moon’s orbit', color: '#ff5a5a' });
  assert.equal(ldBadge(3.2).label, 'very close (<5 LD)');
  assert.equal(ldBadge(12).label, 'near-Earth (<20 LD)');
  assert.equal(ldBadge(45).label, 'distant flyby');
  assert.equal(ldBadge(null).label, 'distance n/a');
});

test('brightnessClass is honest about H being brightness, not size', () => {
  assert.equal(brightnessClass(20), 'bright (H ≤ 21)');
  assert.equal(brightnessClass(24.5), 'typical (H 21–25)');
  assert.equal(brightnessClass(27), 'faint (H > 25)');
  assert.equal(brightnessClass(null), 'H unlisted');
});

test('approachTitle composes des + delta', () => {
  assert.equal(
    approachTitle({ des: '2026 AA', cd: '2026-09-27 16:00:00.000' }, NOW),
    '2026 AA · in 30m',
  );
  assert.equal(approachTitle({ cd: 'garbage' }, NOW), 'unnamed · date n/a');
});

test('formatLd rounds to three decimals', () => {
  assert.equal(formatLd(0.48091), '0.481 LD');
  assert.equal(formatLd(null), '—');
});

test('windowSummary names the next approach', () => {
  const payload = {
    approaches: [
      { des: 'past', cd: '2026-09-27 13:00:00.000' },
      { des: '2026 AA', cd: '2026-10-05 12:34:56.789' },
    ],
  };
  assert.equal(windowSummary(payload, NOW), '2 approaches · next: 2026 AA in 7d 21h');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<b>x</b>&"\'"'), '&lt;b&gt;x&lt;/b&gt;&amp;&quot;&#39;&quot;');
});

test('fetchAsteroids validates the payload shape', async () => {
  const good = { approaches: [{ des: 'x' }] };
  const ok = await fetchAsteroids({
    fetchImpl: async () => new Response(JSON.stringify(good), { status: 200 }),
  });
  assert.deepEqual(ok.approaches, [{ des: 'x' }]);

  await assert.rejects(
    fetchAsteroids({ fetchImpl: async () => new Response('no', { status: 502 }) }),
    /asteroids_http_502/,
  );
  await assert.rejects(
    fetchAsteroids({
      fetchImpl: async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 }),
    }),
    /asteroids_bad_payload/,
  );
});
