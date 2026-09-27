/**
 * radiation provider tests — normalization, dose bands, and the HTTP handler
 * with an injected fetch (no network).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  radiationProxy,
  normalizeMeasurement,
  normalizeBatch,
  doseBand,
} from './radiation.js';

function fakeRes() {
  const chunks = [];
  return {
    status: null,
    headers: null,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(body) { chunks.push(body); this.body = chunks.join(''); },
  };
}

function okFetch(payload) {
  return async () => ({
    ok: true,
    body: { cancel: async () => {} },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Map(),
  });
}

describe('radiation provider', () => {
  it('normalizes a good Safecast measurement', () => {
    const p = normalizeMeasurement({
      latitude: 44.3292, longitude: 3.05828, value: 0.145, unit: 'usv',
      captured_at: '2026-09-27T00:36:48.165Z',
    });
    assert.deepEqual(p, {
      lat: 44.3292, lon: 3.0583, valueUsvH: 0.145, unit: 'usv',
      capturedAt: '2026-09-27T00:36:48.165Z',
    });
  });

  it('rejects malformed measurements', () => {
    assert.equal(normalizeMeasurement(null), null);
    assert.equal(normalizeMeasurement({ latitude: 0, longitude: 0 }), null);
    assert.equal(normalizeMeasurement({ latitude: 95, longitude: 0, value: 0.1, unit: 'usv' }), null);
    assert.equal(normalizeMeasurement({ latitude: 0, longitude: 0, value: -1, unit: 'usv' }), null);
    assert.equal(normalizeMeasurement({ latitude: 0, longitude: 0, value: 99999, unit: 'usv' }), null);
  });

  it('converts cpm to µSv/h with the documented factor, flagged approximate', () => {
    const p = normalizeMeasurement({ latitude: 10, longitude: 20, value: 30, unit: 'cpm' });
    assert.ok(Math.abs(p.valueUsvH - 0.081) < 1e-9, `got ${p.valueUsvH}`);
    assert.equal(p.unit, 'usv~');
  });

  it('caps the batch and skips bad rows', () => {
    const payload = Array.from({ length: 900 }, (_, i) => ({
      latitude: (i % 90) - 45, longitude: (i % 180) - 90, value: 0.1, unit: 'usv',
    }));
    payload.push({ latitude: 999, longitude: 0, value: 0.1, unit: 'usv' });
    const out = normalizeBatch(payload);
    assert.equal(out.length, 600);
  });

  it('classifies dose bands', () => {
    assert.equal(doseBand(0.05), 'low');
    assert.equal(doseBand(0.15), 'background');
    assert.equal(doseBand(0.5), 'elevated');
    assert.equal(doseBand(2.5), 'high');
    assert.equal(doseBand(Number.NaN), 'unknown');
  });

  it('serves /api/radiation with attribution and schema', async () => {
    const proxy = radiationProxy({
      fetchImpl: okFetch([
        { latitude: 44.3, longitude: 3.05, value: 0.145, unit: 'usv', captured_at: '2026-09-27T00:36:48Z' },
      ]),
      now: () => 1_000_000,
    });
    const req = { method: 'GET', url: '/api/radiation' };
    const res = fakeRes();
    await new Promise((resolve) => {
      const origEnd = res.end.bind(res);
      res.end = (b) => { origEnd(b); resolve(); };
      proxy.configureServer({ middlewares: { use: (route, handler) => {
        assert.equal(route, '/api/radiation');
        handler(req, res);
      } } });
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.schemaVersion, 1);
    assert.match(body.source, /Safecast/);
    assert.match(body.attribution, /Safecast/);
    assert.equal(body.points.length, 1);
    assert.equal(body.unavailable, false);
    assert.equal(body.fetchedAt, 1_000_000);
  });

  it('serves stale cache on upstream failure', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true, body: { cancel: async () => {} },
          text: async () => JSON.stringify([{ latitude: 1, longitude: 2, value: 0.2, unit: 'usv' }]),
          headers: new Map(),
        };
      }
      return { ok: false, status: 500, body: { cancel: async () => {} } };
    };
    let nowMs = 0;
    const proxy = radiationProxy({ fetchImpl: flaky, now: () => nowMs });
    const handlers = [];
    proxy.configureServer({ middlewares: { use: (r, h) => handlers.push([r, h]) } });
    const [, handler] = handlers[0];
    const run = () => new Promise((resolve) => {
      const res = fakeRes();
      const origEnd = res.end.bind(res);
      res.end = (b) => { origEnd(b); resolve(res); };
      handler({ method: 'GET', url: '/api/radiation' }, res);
    });
    const r1 = await run();
    assert.equal(r1.status, 200);
    // advance past TTL (10 min) but within stale window (60 min)
    nowMs = 20 * 60_000;
    const r2 = await run();
    assert.equal(r2.status, 200);
    const body = JSON.parse(r2.body);
    assert.equal(body.stale, true);
    assert.equal(body.points.length, 1);
  });

  it('rejects non-GET', async () => {
    const proxy = radiationProxy({ fetchImpl: okFetch([]) });
    const handlers = [];
    proxy.configurePreviewServer({ middlewares: { use: (r, h) => handlers.push(h) } });
    const res = await new Promise((resolve) => {
      const r = fakeRes();
      const origEnd = r.end.bind(r);
      r.end = (b) => { origEnd(b); resolve(r); };
      handlers[0]({ method: 'POST', url: '/api/radiation' }, r);
    });
    assert.equal(res.status, 405);
  });
});
