import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, meteorShowersProxy } from './meteorShowers.js';

test('buildPayload: 8 showers, sorted by daysToPeak, all fields present', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const p = buildPayload(now);
  assert.equal(p.count, 8);
  assert.equal(p.showers.length, 8);
  for (const s of p.showers) {
    assert.ok(typeof s.name === 'string' && s.name.length > 0, 'name');
    assert.match(s.peak, /^\d{4}-\d{2}-\d{2}$/, 'peak date shape');
    assert.ok(typeof s.active === 'string' && s.active.length > 0, 'active');
    assert.ok(Number.isFinite(s.zhr) && s.zhr > 0, 'zhr');
    assert.ok(Number.isInteger(s.daysToPeak) && s.daysToPeak >= 0, 'daysToPeak non-negative');
  }
  const days = p.showers.map((s) => s.daysToPeak);
  assert.deepEqual(days, [...days].sort((a, b) => a - b), 'sorted ascending');
  assert.ok(p.honesty && /static calendar/.test(p.honesty.kind), 'honesty block');
});

test('buildPayload: year rollover — past peaks resolve to next year', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const p = buildPayload(now);
  const quad = p.showers.find((s) => s.name === 'Quadrantids');
  assert.equal(quad.peak.slice(0, 4), '2027', 'January peak rolls to next year');
  const orion = p.showers.find((s) => s.name === 'Orionids');
  assert.equal(orion.peak, '2026-10-21', 'upcoming peak stays this year');
  assert.equal(p.showers[0].name, 'Orionids', 'nearest shower first');
});

test('proxy: configureServer registers GET handler returning 200 JSON', async () => {
  const plugin = meteorShowersProxy();
  assert.equal(plugin.name, 'meteor-showers');
  const routes = [];
  plugin.configureServer({ middlewares: { use: (r, fn) => routes.push([r, fn]) } });
  assert.equal(routes.length, 1);
  assert.equal(routes[0][0], '/api/meteor-showers');
  const handler = routes[0][1];

  let status, body, headers;
  const res = {
    writeHead: (s, h) => { status = s; headers = h; },
    end: (b) => { body = JSON.parse(b); },
  };
  await handler({ method: 'GET', url: '/api/meteor-showers' }, res);
  assert.equal(status, 200);
  assert.equal(headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(body.count, 8);
  assert.ok(Array.isArray(body.showers) && body.showers.length === 8);

  await handler({ method: 'POST', url: '/api/meteor-showers' }, res);
  assert.equal(status, 405);
});
