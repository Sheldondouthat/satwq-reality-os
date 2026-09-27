import assert from 'node:assert/strict';
import test from 'node:test';
import { magnetometersProxy, _magnetometersInternals } from './magnetometers.js';

const { HAPI_DATASETS, IRF_PLOTS, parseHapiCsv, hapiWindow, clearCaches } = _magnetometersInternals;

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(method = 'GET') {
  return { method, url: '/api/magnetometers' };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// ——— fixtures (HAPI 3.3 CSV shape verified against the live endpoint 2026-09-27) ———

function norstarCsv(rows = 100) {
  const header = [
    '#{',
    '#  "HAPI": "3.3",',
    '#  "parameters": [',
    '#    {"name": "Time", "type": "isotime", "units": "UTC"},',
    '#    {"name": "raw_signal", "type": "double", "units": "V", "description": "raw signal voltage"}',
    '#  ]',
    '#}',
  ];
  const lines = [...header];
  for (let i = 0; i < rows; i++) {
    const t = new Date(Date.UTC(2026, 8, 25, 0, 0, 2) + i * 5000).toISOString();
    lines.push(`${t},${(2.5 + 0.1 * Math.sin(i / 7)).toFixed(3)}`);
  }
  return lines.join('\n');
}

function swanCsv(rows = 120) {
  const header = [
    '#{',
    '#  "HAPI": "3.3",',
    '#  "parameters": [',
    '#    {"name": "Time", "type": "isotime", "units": "UTC"},',
    '#    {"name": "raw_power", "type": "double", "units": "dB", "size": [11], "description": "HSR raw power"}',
    '#  ]',
    '#}',
  ];
  const lines = [...header];
  for (let i = 0; i < rows; i++) {
    const t = new Date(Date.UTC(2026, 8, 25, 0, 0, 0) + i * 1000).toISOString();
    const vals = Array.from({ length: 11 }, (_, b) => (20 + b + 0.5 * Math.sin(i / 13 + b)).toFixed(4));
    lines.push(`${t},${vals.join(',')}`);
  }
  return lines.join('\n');
}

function textResponse(text) {
  return {
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function mockFetchImpl({ seen = [], fail = false } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    if (fail) return { ok: false, status: 503, body: { cancel: async () => {} } };
    if (String(url).includes('NORSTAR_RIOMETER_K0%40GILL')) return textResponse(norstarCsv());
    if (String(url).includes('SWAN_HSR_K0%40CHUR')) return textResponse(swanCsv());
    throw new Error(`unexpected url ${url}`);
  };
}

test('parseHapiCsv extracts units and decimates a scalar series', () => {
  const p = parseHapiCsv(norstarCsv(), 'raw_signal');
  assert.equal(p.units, 'V');
  assert.equal(p.sampleCount, 100);
  assert.ok(p.series.length <= 48 && p.series.length > 0);
  assert.equal(p.latest.length, 1);
  assert.ok(p.min < p.mean && p.mean < p.max);
  assert.ok(Date.parse(p.latestTime) > 0);
  assert.equal(p.series[0].t, new Date(Date.UTC(2026, 8, 25, 0, 0, 2)).toISOString());
});

test('parseHapiCsv handles a binned parameter (SWAN 11-band raw_power)', () => {
  const p = parseHapiCsv(swanCsv(), 'raw_power');
  assert.equal(p.units, 'dB');
  assert.equal(p.sampleCount, 120);
  assert.equal(p.latest.length, 11);
  assert.ok(p.series.every((r) => Array.isArray(r.v) && r.v.length === 11));
  assert.throws(() => parseHapiCsv('#{}\n', 'raw_power'), /no_data/);
});

test('hapiWindow targets a 1-hour window ending 49h ago', () => {
  const now = Date.parse('2026-09-28T01:07:00Z');
  const w = hapiWindow(now);
  assert.equal(w.start, '2026-09-25T23:07:00.000Z');
  assert.equal(w.stop, '2026-09-26T00:07:00.000Z');
});

test('IRF plots are pinned manifests with honest probe flags', () => {
  assert.equal(IRF_PLOTS.length, 2);
  assert.ok(IRF_PLOTS[0].url.endsWith('/maggraphs/sgu1/lycksele.png'));
  assert.ok(IRF_PLOTS[1].url.endsWith('/maggraphs/sgu2/lycksele.png'));
  assert.ok(IRF_PLOTS.every((p) => p.probe === 'vm-000'));
});

test('handler merges IRF manifest with live HAPI samples', async () => {
  clearCaches();
  const seen = [];
  const provider = magnetometersProxy({ fetchImpl: mockFetchImpl({ seen }), now: () => Date.parse('2026-09-28T01:07:00Z') });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/magnetometers');
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.sources.irf.ok, true);
  assert.equal(doc.irf.plots.length, 2);
  assert.equal(doc.sources.hapi.ok, true);
  assert.equal(doc.sources.hapi.liveCount, 2);
  const [n, s] = doc.hapi.datasets;
  assert.equal(n.datasetId, 'NORSTAR_RIOMETER_K0@GILL');
  assert.equal(n.ok, true);
  assert.equal(n.units, 'V');
  assert.equal(n.sampleCount, 100);
  assert.equal(s.datasetId, 'SWAN_HSR_K0@CHUR');
  assert.equal(s.units, 'dB');
  assert.equal(s.latest.length, 11);
  assert.ok(doc.hapi.windowStart.endsWith('.000Z'));
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
});

test('HAPI down degrades honestly while the IRF manifest keeps the route alive', async () => {
  clearCaches();
  const provider = magnetometersProxy({ fetchImpl: mockFetchImpl({ fail: true }) });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler(fakeReq('GET'), res);
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.sources.hapi.ok, false);
  assert.ok(doc.sources.hapi.error.includes('magnetometers_hapi_503'));
  assert.equal(doc.sources.irf.ok, true);
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const calls = mount(magnetometersProxy({ fetchImpl: mockFetchImpl() }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
