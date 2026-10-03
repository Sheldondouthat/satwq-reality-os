/**
 * Wave 9 — Lunar ephemeris tests (R2-21, GET /api/moon).
 *
 * The provider is pure computed geometry — no fixtures needed. All expected
 * values below were produced by an INDEPENDENT python3 reimplementation of
 * the simplified Meeus/Schlyter algorithm (typed from the published
 * constants, not copied from the JS) at /tmp/lunar-crosscheck.py, 2026-10-03.
 * The two implementations agreed to the second on phases and to the
 * millisecond on rise/set; event instants agreed exactly.
 *
 * Anchors:
 *   2026-08-12T17:47Z (total solar eclipse) -> New Moon, elong 0.90, dist 371493 km
 *   2026-09-07T18:00Z -> Waning Crescent, elong 44.58, illum 0.144
 *   2026-10-03T12:00Z -> Last Quarter, elong 90.84, illum 0.507, dist 363418 km
 *   Pembroke VA (37.28,-80.41) 2026-09-07: rise 06:37:10.839Z, set 21:51:12.086Z
 *   Pembroke VA 2026-10-03: rise 03:16:03.778Z, set 19:05:00.194Z
 *   Upcoming from 2026-10-03T12:00Z: Last Quarter 2026-10-03T13:32:20.722Z,
 *     New Moon 2026-10-10T15:30:00.000Z, First Quarter 2026-10-18T15:53:52.459Z,
 *     Full Moon 2026-10-26T04:00:00.000Z (python agreed to the second)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lunarProxy,
  topocentricAltitudeDeg,
  _lunarInternals as internals,
} from './lunar.js';

const { findRiseSet, upcomingPhases, getLunarSnapshot, parseLunarQuery, LUNAR_HONESTY } = internals;

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

function fakeReq(url, method = 'GET') {
  return { method, url, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('eclipse anchor: 2026-08-12T17:47Z is New Moon, elong 0.90', () => {
  const s = getLunarSnapshot({ dateMs: Date.parse('2026-08-12T17:47:00Z'), lat: null, lon: null, next: 1 });
  assert.equal(s.phase.name, 'New Moon');
  assert.ok(Math.abs(s.phase.elongationDeg - 0.9) < 0.05, `elong ${s.phase.elongationDeg}`);
  assert.equal(s.phase.illumination, 0);
  assert.ok(Math.abs(s.distanceKm - 371493) < 3, `dist ${s.distanceKm}`);
});

test('phase sanity: 2026-10-03T12:00Z is Last Quarter', () => {
  const s = getLunarSnapshot({ dateMs: Date.parse('2026-10-03T12:00:00Z'), lat: null, lon: null, next: 1 });
  assert.equal(s.phase.name, 'Last Quarter');
  assert.ok(Math.abs(s.phase.elongationDeg - 90.84) < 0.05, `elong ${s.phase.elongationDeg}`);
  assert.ok(Math.abs(s.phase.illumination - 0.507) < 0.005, `illum ${s.phase.illumination}`);
  assert.ok(Math.abs(s.distanceKm - 363418) < 3, `dist ${s.distanceKm}`);
  assert.equal(s.perigean, true); // 363418 < 370000, labeled computed
  assert.equal(s.source, 'computed');
});

test('moonrise/moonset Pembroke VA 2026-09-07 matches the independent statement', () => {
  const rs = findRiseSet(Date.parse('2026-09-07T12:00:00Z'), 37.28, -80.41);
  const rise = Date.parse(rs.moonrise);
  const set = Date.parse(rs.moonset);
  assert.ok(Math.abs(rise - Date.parse('2026-09-07T06:37:10.839Z')) < 120000, rs.moonrise);
  assert.ok(Math.abs(set - Date.parse('2026-09-07T21:51:12.086Z')) < 120000, rs.moonset);
  assert.equal(rs.events.length, 2);
  assert.equal(rs.events[0].type, 'moonrise');
});

test('moonrise/moonset Pembroke VA 2026-10-03 matches the independent statement', () => {
  const rs = findRiseSet(Date.parse('2026-10-03T12:00:00Z'), 37.28, -80.41);
  assert.ok(Math.abs(Date.parse(rs.moonrise) - Date.parse('2026-10-03T03:16:03.778Z')) < 120000, rs.moonrise);
  assert.ok(Math.abs(Date.parse(rs.moonset) - Date.parse('2026-10-03T19:05:00.194Z')) < 120000, rs.moonset);
});

test('upcoming events are the astronomical instants, in order', () => {
  const up = upcomingPhases(Date.parse('2026-10-03T12:00:00Z'), 4);
  assert.deepEqual(up.map((e) => e.type), ['Last Quarter', 'New Moon', 'First Quarter', 'Full Moon']);
  assert.ok(Math.abs(Date.parse(up[0].date) - Date.parse('2026-10-03T13:32:20.722Z')) < 300000, up[0].date);
  assert.ok(up[1].date.startsWith('2026-10-10'), up[1].date);
  assert.ok(up[2].date.startsWith('2026-10-18'), up[2].date);
  assert.ok(up[3].date.startsWith('2026-10-26'), up[3].date);
  for (let i = 1; i < up.length; i++) assert.ok(Date.parse(up[i].date) > Date.parse(up[i - 1].date));
  assert.ok(up.every((e) => Number.isFinite(e.daysAway) && Number.isFinite(e.distanceKm)));
});

test('topocentric altitude is finite and near horizon at the computed rise', () => {
  const riseMs = Date.parse('2026-09-07T06:37:10.839Z');
  const alt = topocentricAltitudeDeg(riseMs, 37.28, -80.41);
  assert.ok(Math.abs(alt - -0.583) < 0.05, `alt ${alt}`);
});

test('parseLunarQuery: defaults, bad date, bad lat/lon, bad next', () => {
  const d = parseLunarQuery({ url: '/api/moon' });
  assert.equal(d.next, 8);
  assert.equal(d.lat, null);
  const withObs = parseLunarQuery({ url: '/api/moon?lat=37.28&lon=-80.41&next=3' });
  assert.equal(withObs.next, 3);
  assert.equal(withObs.lat, 37.28);
  assert.throws(() => parseLunarQuery({ url: '/api/moon?date=bogus' }), /invalid date/);
  assert.throws(() => parseLunarQuery({ url: '/api/moon?lat=37.28' }), /lat and lon/);
  assert.throws(() => parseLunarQuery({ url: '/api/moon?lat=91&lon=0' }), /lat and lon/);
  assert.throws(() => parseLunarQuery({ url: '/api/moon?next=99' }), /next must be/);
});

test('honesty block is present and labels computed geometry', () => {
  const keys = Object.keys(LUNAR_HONESTY);
  assert.ok(keys.includes('computation') && keys.includes('riseSet') && keys.includes('perigean'));
  assert.ok(/COMPUTED GEOMETRY/.test(LUNAR_HONESTY.computation));
});

test('lunarProxy handler: 200 shape, 400 on bad date, 405 on POST', async () => {
  const calls = mount(lunarProxy());
  assert.equal(calls[0].route, '/api/moon');
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/moon?lat=37.28&lon=-80.41'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.phase && body.upcoming && body.honesty && body.generatedAt);
  assert.equal(body.riseSet.events.length, 2);
  assert.equal(body.source, 'computed');
  const res400 = fakeRes();
  await handler(fakeReq('/api/moon?date=bogus'), res400);
  assert.equal(res400.statusCode, 400);
  assert.equal(JSON.parse(res400.body).error, 'lunar_bad_request');
  const res405 = fakeRes();
  await handler(fakeReq('/api/moon', 'POST'), res405);
  assert.equal(res405.statusCode, 405);
});
