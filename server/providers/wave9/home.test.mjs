/**
 * Wave 9 — Pembroke home view (GET /api/home) tests.
 *
 * All fixtures are REAL capture bytes from 2026-10-04 23:45 EDT
 * (home-2026-10-04-*.json/.xml/.html). Key expectations were verified by an
 * independent python3 statement over the same bytes before these assertions
 * were written (weather 59.6°F/Overcast, AQ us_aqi 30, NWS 0 features,
 * quakes max 5.5 → 0 firings, SWPC max Kp 5 → 0 firings, FAA 5 firings,
 * MIROVA 1 Ambrym firing → 6 tripwire firings total).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  HOME_POINT,
  WMO_WORDS,
  numOrNull,
  parseLocation,
  parseHomeWeather,
  buildHomePayload,
  homeProxy,
} from './home.js';

const FIX = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'home-2026-10-04',
);
const fx = (name) => readFileSync(`${FIX}-${name}`, 'utf8');

test('numOrNull guards the Number("")===0 and Number(null)===0 traps', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull('59.6'), 59.6);
  assert.equal(numOrNull(0), 0, 'real zeros are preserved, not nulled');
  assert.equal(numOrNull('0'), 0);
});

test('parseLocation: no query → verified home point', () => {
  const loc = parseLocation({ lat: null, lon: null });
  assert.equal(loc.name, HOME_POINT.name);
  assert.equal(loc.lat, 37.31957);
  assert.equal(loc.lon, -80.63895);
  assert.equal(loc.isDefault, true);
});

test('parseLocation: custom point + name', () => {
  const loc = parseLocation({ lat: '40.7', lon: '-74.0', name: 'NYC' });
  assert.equal(loc.name, 'NYC');
  assert.equal(loc.lat, 40.7);
  assert.equal(loc.isDefault, false);
});

test('parseLocation: custom point without name → "Custom location"', () => {
  const loc = parseLocation({ lat: '40.7', lon: '-74.0', name: null });
  assert.equal(loc.name, 'Custom location');
});

test('parseLocation: malformed coords → 400', () => {
  for (const q of [
    { lat: 'abc', lon: '-74' },
    { lat: '91', lon: '-74' },
    { lat: '40', lon: '181' },
    { lat: '40', lon: null },
  ]) {
    assert.throws(
      () => parseLocation(q),
      (e) => e.status === 400,
      JSON.stringify(q),
    );
  }
});

test('WMO weather-code map: spot checks', () => {
  assert.equal(WMO_WORDS[0], 'Clear sky');
  assert.equal(WMO_WORDS[3], 'Overcast');
  assert.equal(WMO_WORDS[95], 'Thunderstorm');
  assert.equal(WMO_WORDS[99], 'Thunderstorm with heavy hail');
});

test('parseHomeWeather: real 2026-10-04 fixture bytes', () => {
  const w = parseHomeWeather(JSON.parse(fx('weather.json')));
  assert.equal(w.tempF, 59.6);
  assert.equal(w.feelsLikeF, 58.5);
  assert.equal(w.humidityPct, 90);
  assert.equal(w.weatherCode, 3);
  assert.equal(w.weatherWord, 'Overcast');
  assert.equal(w.isDay, false);
  assert.equal(w.windKmh, 12.6);
  assert.equal(w.windDeg, 311);
  assert.equal(w.pressureHpa, 1016.8);
  assert.equal(w.highF, 65.5);
  assert.equal(w.lowF, 54.8);
  assert.equal(w.sunrise, '2026-10-04T07:21');
  assert.equal(w.sunset, '2026-10-04T19:01');
  assert.equal(w.timezone, 'America/New_York');
});

test('parseHomeWeather: missing fields read null, never zero-filled', () => {
  const w = parseHomeWeather({ current: {}, daily: {} });
  assert.equal(w.tempF, null);
  assert.equal(w.weatherWord, null);
  assert.equal(w.isDay, null);
  assert.equal(w.highF, null);
  assert.equal(w.sunrise, null);
});

test('tripwire checks on real 2026-10-04 fixture bytes', async () => {
  const { checkQuakes, checkFaa, checkMirova, checkSwpc, checkNwsAlerts } =
    await import('./alertRules.js');
  assert.equal(
    checkQuakes(JSON.parse(fx('quakes.json'))).length,
    0,
    'max M5.5 < M6 threshold',
  );
  const faa = checkFaa(fx('faa.xml'));
  assert.equal(faa.length, 5, '2 GDP (BOS/SAN) + 3 closures (LAX/SAN/PHL)');
  assert.ok(faa.every((f) => f.ruleId === 'faa-ground'));
  const mirova = checkMirova(fx('mirova.html'));
  assert.equal(mirova.length, 1);
  assert.ok(mirova[0].title.includes('Ambrym'));
  assert.equal(
    checkSwpc(JSON.parse(fx('swpc.json'))).length,
    0,
    'max Kp 5 < 8',
  );
  assert.equal(
    checkNwsAlerts(JSON.parse(fx('nws.json'))).length,
    0,
    'zero active alerts at home point',
  );
});

test('buildHomePayload: quiet-case shape + 6 tripwire firings', async () => {
  const { checkQuakes, checkFaa, checkMirova, checkSwpc } =
    await import('./alertRules.js');
  const { parseNwsAlerts } = await import('../wave6/alerts.js');
  const { parseModelPayload } = await import('../wave7/aqModel.js');
  const loc = parseLocation({ lat: null, lon: null });
  const nwsRaw = JSON.parse(fx('nws.json'));
  const results = [
    {
      id: 'weather',
      ok: true,
      stale: false,
      ...parseHomeWeather(JSON.parse(fx('weather.json'))),
    },
    {
      id: 'alerts',
      ok: true,
      stale: false,
      count: 0,
      severe: [],
      alerts: parseNwsAlerts(nwsRaw),
    },
    {
      id: 'air',
      ok: true,
      stale: false,
      ...parseModelPayload(JSON.parse(fx('aq.json')), {
        lat: loc.lat,
        lon: loc.lon,
      }),
    },
    {
      id: 'quakes',
      ok: true,
      stale: false,
      firings: checkQuakes(JSON.parse(fx('quakes.json'))),
    },
    { id: 'faa', ok: true, stale: false, firings: checkFaa(fx('faa.xml')) },
    {
      id: 'mirova',
      ok: true,
      stale: false,
      firings: checkMirova(fx('mirova.html')),
    },
    {
      id: 'swpc',
      ok: true,
      stale: false,
      firings: checkSwpc(JSON.parse(fx('swpc.json'))),
    },
  ];
  const payload = buildHomePayload(loc, results);
  assert.equal(payload.home.name, HOME_POINT.name);
  assert.equal(payload.home.isDefault, true);
  assert.equal(payload.alerts.count, 0);
  assert.equal(payload.airQuality.model, true, 'CAMS model label carried');
  assert.equal(payload.airQuality.current.usAqi, 30);
  assert.equal(payload.tripwires.firingCount, 6);
  assert.equal(payload.tripwires.rules.length, 4);
  assert.equal(payload.briefing.url, '/api/morning-briefing');
  const keys = Object.keys(payload.honesty);
  assert.ok(keys.length >= 5, `honesty block has ${keys.length} keys`);
  assert.equal(Object.keys(payload.sources).length, 7);
});

test('buildHomePayload: sources carry per-section ok state', () => {
  const payload = buildHomePayload(parseLocation({ lat: null, lon: null }), [
    { id: 'weather', ok: true, stale: false },
    { id: 'alerts', ok: false, error: 'home_fetch_failed' },
    { id: 'air', ok: false, error: 'home_fetch_failed' },
    { id: 'quakes', ok: false, error: 'x' },
    { id: 'faa', ok: true, stale: true, firings: [] },
    { id: 'mirova', ok: false, error: 'x' },
    { id: 'swpc', ok: false, error: 'x' },
  ]);
  assert.equal(payload.sources.alerts.ok, false);
  assert.equal(payload.sources.faa.stale, true);
  assert.equal(
    payload.tripwires.ok,
    true,
    'one tripwire rule ok keeps section alive',
  );
});

function mountHandler() {
  const seen = [];
  homeProxy().configureServer({
    middlewares: { use: (route, fn) => seen.push({ route, fn }) },
  });
  return seen[0];
}

test('non-GET → 405 without touching the network', async () => {
  const { route, fn } = mountHandler();
  assert.equal(route, '/api/home');
  let status = null;
  const res = {
    writeHead: (s) => {
      status = s;
    },
    end: () => {},
  };
  await fn({ method: 'POST', url: '/api/home', headers: {} }, res);
  assert.equal(status, 405);
});

test('?lat=bogus → 400 without touching the network', async () => {
  const { fn } = mountHandler();
  let status = null;
  let body = null;
  const res = {
    writeHead: (s) => {
      status = s;
    },
    end: (b) => {
      body = JSON.parse(b);
    },
  };
  await fn(
    { method: 'GET', url: '/api/home?lat=bogus&lon=-80', headers: {} },
    res,
  );
  assert.equal(status, 400);
  assert.equal(body.error, 'home_bad_location');
});
