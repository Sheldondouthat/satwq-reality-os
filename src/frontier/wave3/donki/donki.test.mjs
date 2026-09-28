import assert from 'node:assert/strict';
import test from 'node:test';
import {
  arcSamples,
  cmeLabel,
  etaCountdown,
  speedColor,
  subsolarPoint,
} from './model.js';
import {
  ballisticTransitHours,
  donkiProxy,
  isEarthDirected,
  parseCme,
  parseDays,
  parseDonkiPayload,
  parseFlr,
  parseGst,
  parseSep,
  parseType,
  windowDates,
} from '../../../../server/providers/wave3/donki.js';

// — model.js —

test('subsolarPoint stays in physical range', () => {
  const p = subsolarPoint(new Date('2026-09-27T12:00:00Z'));
  assert.ok(p.lat >= -23.44 && p.lat <= 23.44, `decl ${p.lat}`);
  assert.ok(p.lon >= -180 && p.lon <= 180, `lon ${p.lon}`);
});

test('speedColor bands by CME speed', () => {
  assert.equal(speedColor(300), '#ffb454');
  assert.equal(speedColor(800), '#ff7a3d');
  assert.equal(speedColor(1200), '#ff5a5a');
  assert.equal(speedColor(2000), '#c44dff');
  assert.equal(speedColor(Number.NaN), '#8a93a6');
});

test('etaCountdown formats human countdowns', () => {
  const now = 1_000_000_000_000;
  assert.equal(etaCountdown(now + 50 * 3600_000, now), '2d 2h');
  assert.equal(etaCountdown(now + 5 * 3600_000 + 30 * 60_000, now), '5h 30m');
  assert.equal(etaCountdown(now + 20 * 60_000, now), '20m');
  assert.equal(etaCountdown(now - 1, now), 'arriving now');
  assert.equal(etaCountdown(Number.NaN, now), 'ETA n/a');
});

test('cmeLabel joins speed, countdown, source', () => {
  const now = 1_000_000_000_000;
  const label = cmeLabel({ speedKms: 827, etaMs: now + 3600_000, sourceLocation: 'S20W30' }, now);
  assert.match(label, /827 km\/s/);
  assert.match(label, /1h 0m/);
  assert.match(label, /S20W30/);
});

test('arcSamples interpolates start -> impact', () => {
  const rows = arcSamples({ lon: 0, lat: 0, h: 100 }, { lon: 10, lat: 5, h: 50 }, 48);
  assert.equal(rows.length, 49);
  assert.deepEqual(rows[0], [0, 0, 100]);
  assert.deepEqual(rows[48], [10, 5, 50]);
  assert.ok(rows.every((r) => r.length === 3 && r.every(Number.isFinite)));
});

// — provider parsing —

test('parseType and parseDays validate input', () => {
  assert.equal(parseType('cme'), 'CME');
  assert.equal(parseType(null), 'CME');
  assert.throws(() => parseType('bogus'), /donki_bad_type/);
  assert.equal(parseDays(''), 30);
  assert.equal(parseDays('7'), 7);
  assert.throws(() => parseDays('90'), /donki_bad_days/);
  assert.throws(() => parseDays('0'), /donki_bad_days/);
});

test('windowDates emits yyyy-MM-dd bounds', () => {
  const { startDate, endDate } = windowDates(30, Date.parse('2026-09-27T12:00:00Z'));
  assert.match(startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(endDate, '2026-09-27');
  assert.equal(startDate, '2026-08-28');
});

test('isEarthDirected heuristic', () => {
  assert.equal(isEarthDirected({ latitude: 10, longitude: 5, halfAngle: 30 }, ''), true);
  assert.equal(isEarthDirected({ latitude: -24, longitude: null, halfAngle: 10 }, ''), false);
  assert.equal(isEarthDirected({ latitude: 60, longitude: 120, halfAngle: 20 }, ''), false);
  assert.equal(isEarthDirected({ latitude: null, longitude: null, halfAngle: 100 }, ''), true); // halo
  assert.equal(isEarthDirected({ latitude: 60, longitude: 120, halfAngle: 10 }, 'Halo CME observed'), true);
  assert.equal(isEarthDirected(null, ''), false);
});

test('ballisticTransitHours for a typical CME speed', () => {
  const h = ballisticTransitHours(827);
  assert.ok(Math.abs(h - 50.2) < 0.5, `expected ~50.2h, got ${h}`);
  assert.equal(ballisticTransitHours(0), null);
  assert.equal(ballisticTransitHours(Number.NaN), null);
});

const CME_FIXTURE = {
  activityID: '2026-08-27T01:09:00-CME-001',
  startTime: '2026-08-27T01:09Z',
  sourceLocation: '',
  activeRegionNum: null,
  note: 'Far-sided STEREO-A only.',
  link: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/view/CME/48312/-1',
  cmeAnalyses: [
    {
      isMostAccurate: true,
      time21_5: '2026-08-27T05:13Z',
      latitude: -24.0,
      longitude: null,
      halfAngle: 10.0,
      speed: 827.0,
      type: 'C',
      note: 'Plane-of-sky measurement.',
    },
  ],
};

test('parseCme normalizes the real 2026-08-27 CME record', () => {
  const c = parseCme(CME_FIXTURE);
  assert.equal(c.id, '2026-08-27T01:09:00-CME-001');
  assert.equal(c.speedKms, 827);
  assert.equal(c.halfAngleDeg, 10);
  assert.equal(c.sourceLat, -24);
  assert.equal(c.sourceLon, null);
  assert.equal(c.earthDirected, false); // far-sided, narrow
  assert.ok(Math.abs(c.etaHours - 50.2) < 0.5);
  assert.ok(c.etaMs > c.startMs);
});

test('parseCme picks the most-accurate analysis', () => {
  const rec = {
    ...CME_FIXTURE,
    cmeAnalyses: [
      { isMostAccurate: false, speed: 400, latitude: 0, longitude: 0, halfAngle: 20 },
      { isMostAccurate: true, speed: 900, latitude: 5, longitude: 10, halfAngle: 40 },
    ],
  };
  const c = parseCme(rec);
  assert.equal(c.speedKms, 900);
  assert.equal(c.earthDirected, true);
});

test('parseFlr / parseGst / parseSep normalize their records', () => {
  const f = parseFlr({
    flrID: '2026-09-01T12:00:00-FLR-001',
    classType: 'M5.2',
    peakTime: '2026-09-01T12:20Z',
    sourceLocation: 'S15W40',
    activeRegionNum: 1234,
    link: 'x',
  });
  assert.equal(f.class, 'M5.2');
  assert.ok(Number.isFinite(f.peakMs));
  const g = parseGst({
    gstID: '2026-09-02T00:00:00-GST-001',
    startTime: '2026-09-02T00:00Z',
    allKpIndex: [{ kpIndex: 4 }, { kpIndex: 6 }, { kpIndex: 5 }],
    link: 'y',
  });
  assert.equal(g.maxKp, 6);
  const s = parseSep({
    sepID: '2026-09-03T00:00:00-SEP-001',
    eventTime: '2026-09-03T01:00Z',
    instruments: [{ displayName: 'SOHO/EPHIN' }],
    link: 'z',
  });
  assert.deepEqual(s.instruments, ['SOHO/EPHIN']);
});

test('parseDonkiPayload caps events and drops id-less records', () => {
  const docs = Array.from({ length: 70 }, (_, i) => ({ ...CME_FIXTURE, activityID: `id-${i}` }));
  docs.push({ noId: true });
  const out = parseDonkiPayload(docs, 'CME');
  assert.equal(out.length, 60);
  assert.throws(() => parseDonkiPayload({ not: 'array' }, 'CME'), /unexpected_shape/);
});

// — provider HTTP behavior —

function fakeReq(url, method = 'GET') {
  return { method, url, headers: {}, on: () => {}, removeListener: () => {} };
}
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
function fakeFetchJson(doc) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => JSON.stringify(doc),
    };
  };
  return { fetchImpl, calls };
}
async function callHandler(proxy, url, method = 'GET') {
  const seen = [];
  proxy.configureServer({ middlewares: { use: (route, handler) => seen.push({ route, handler }) } });
  const req = fakeReq(url, method);
  const res = fakeRes();
  await seen[0].handler(req, res);
  return res;
}

test('donkiProxy mounts /api/donki on both server shapes', () => {
  const proxy = donkiProxy();
  assert.equal(proxy.name, 'donki');
  const seen = [];
  proxy.configureServer({ middlewares: { use: (r) => seen.push(r) } });
  proxy.configurePreviewServer({ middlewares: { use: (r) => seen.push(r) } });
  assert.deepEqual(seen, ['/api/donki', '/api/donki']);
});

test('donkiProxy rejects POST and bad type', async () => {
  const post = await callHandler(donkiProxy(), '/api/donki?type=CME', 'POST');
  assert.equal(post.statusCode, 405);
  const bad = await callHandler(donkiProxy(), '/api/donki?type=bogus');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /donki_bad_type/);
});

test('donkiProxy serves normalized events, labels the ETA model, and caches', async () => {
  const { fetchImpl, calls } = fakeFetchJson([CME_FIXTURE]);
  const proxy = donkiProxy({ fetchImpl, now: () => Date.parse('2026-09-27T12:00:00Z') });
  const res = await callHandler(proxy, '/api/donki?type=CME&days=30');
  assert.equal(res.statusCode, 200);
  const doc = JSON.parse(res.body);
  assert.equal(doc.type, 'CME');
  assert.equal(doc.events.length, 1);
  assert.equal(doc.events[0].speedKms, 827);
  assert.match(doc.etaModel, /ballistic/);
  assert.match(calls[0], /kauai\.ccmc\.gsfc\.nasa\.gov\/DONKI\/WS\/get\/CME\?/);
  assert.match(calls[0], /startDate=2026-08-28&endDate=2026-09-27/);
  const again = await callHandler(proxy, '/api/donki?type=CME&days=30');
  assert.equal(again.statusCode, 200);
  assert.equal(calls.length, 1);
});

// — wave6 bundle adapters (2026-09-28) —

import {
  adaptWave6Cme,
  adaptWave6Flare,
  ballisticTransitHoursWave6,
  isEarthDirectedWave6,
} from './model.js';

test('isEarthDirectedWave6 matches the provider heuristic', () => {
  assert.equal(isEarthDirectedWave6(null), false);
  assert.equal(
    isEarthDirectedWave6({ latitude: 10, longitude: -20, halfAngle: 30, note: '' }, ''),
    true,
  );
  assert.equal(
    isEarthDirectedWave6({ latitude: 70, longitude: -20, halfAngle: 30, note: '' }, ''),
    false,
  );
  assert.equal(
    isEarthDirectedWave6({ latitude: 70, longitude: 170, halfAngle: 120, note: '' }, ''),
    true,
  );
  assert.equal(
    isEarthDirectedWave6({ latitude: null, longitude: null, halfAngle: null, note: '' }, 'halo cme observed'),
    true,
  );
  // null coords stay missing (never Number(null)===0 -> false positive at 0,0)
  assert.equal(
    isEarthDirectedWave6({ latitude: null, longitude: null, halfAngle: null, note: '' }, ''),
    false,
  );
});

test('ballisticTransitHoursWave6 rejects non-finite input', () => {
  assert.equal(ballisticTransitHoursWave6(500), 149597870.7 / 500 / 3600);
  assert.equal(ballisticTransitHoursWave6(0), null);
  assert.equal(ballisticTransitHoursWave6(Number.NaN), null);
});

test('adaptWave6Cme reshapes the wave6 cme item', () => {
  const item = {
    id: '2026-09-27T00:00:00-CME-001',
    startTime: '2026-09-27T00:00:00Z',
    sourceLocation: 'S20W30',
    note: 'halo',
    analysis: {
      latitude: 10, longitude: -20, halfAngle: 120, speedKms: 800, note: '',
    },
  };
  const cme = adaptWave6Cme(item);
  assert.equal(cme.id, item.id);
  assert.equal(cme.sourceLocation, 'S20W30');
  assert.equal(cme.speedKms, 800);
  assert.equal(cme.earthDirected, true);
  assert.ok(Number.isFinite(cme.etaMs) && cme.etaMs > Date.parse(item.startTime));
});

test('adaptWave6Cme degrades honestly without analysis', () => {
  const cme = adaptWave6Cme({ id: 'x', startTime: null, analysis: null });
  assert.equal(cme.earthDirected, false);
  assert.equal(cme.speedKms, null);
  assert.equal(cme.etaMs, null);
});

test('adaptWave6Flare reshapes the wave6 flare item', () => {
  const f = adaptWave6Flare({
    id: 'FLR-1', class: 'M5.2', peakTime: '2026-09-27T12:00:00Z', sourceLocation: 'N10E20',
  });
  assert.equal(f.class, 'M5.2');
  assert.equal(f.peakMs, Date.parse('2026-09-27T12:00:00Z'));
  assert.equal(f.sourceLocation, 'N10E20');
});
