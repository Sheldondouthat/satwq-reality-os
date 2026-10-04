/**
 * Wave 9 — alert rules engine tests.
 *
 * Fixtures are trimmed real 2026-10-04 capture bytes, EXCEPT rows explicitly
 * labeled SYNTHETIC below (threshold/window cases the live data did not
 * contain at capture time; the parsers they exercise are covered by their
 * own providers' tests against fully-real fixtures).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkQuakes,
  checkNwsAlerts,
  checkFaa,
  checkMirova,
  checkSwpc,
  RULE_IDS,
  DEFAULT_NTFY_TOPIC,
  NTFY_SERVER,
  alertRulesProxy,
} from './alertRules.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const fix = (n) => join(DIR, 'fixtures', n);

test('RULE_IDS pins the 5 shipped rules', () => {
  assert.deepEqual(RULE_IDS, ['quake-m6', 'nws-severe', 'faa-ground', 'mirova-thermal', 'swpc-g4']);
});

test('ntfy defaults are the documented public channel', () => {
  assert.equal(DEFAULT_NTFY_TOPIC, 'satwq-alerts');
  assert.equal(NTFY_SERVER, 'https://ntfy.sh');
});

test('checkQuakes: fires only on M>=6.0 inside 24h', () => {
  const geojson = JSON.parse(readFileSync(fix('alerts-usgs-2026-10-04.json'), 'utf8'));
  const now = 1791129000000; // ~2026-10-04T15:50Z, at capture time
  const firings = checkQuakes(geojson, now);
  assert.equal(firings.length, 1);
  const f = firings[0];
  assert.equal(f.ruleId, 'quake-m6');
  assert.equal(f.severity, 'high'); // synthetic M6.2 < 7.0
  assert.match(f.title, /^M6\.2 earthquake/);
  assert.match(f.title, /Tambolaka/);
  assert.ok(f.dedupeKey.startsWith('quake:'));
  assert.match(f.link, /^https:\/\/earthquake\.usgs\.gov\/earthquakes\/eventpage\//);
  // the real M5.9 (below threshold) and the M6.5 ~30h old (outside window) stay quiet
});

test('checkQuakes: M>=7.0 is critical', () => {
  const now = 1791129000000;
  const big = {
    type: 'FeatureCollection',
    features: [
      {
        id: 'us7000synth',
        properties: {
          mag: 7.2,
          place: 'SYNTHETIC test trench',
          time: now - 3600_000,
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000synth',
        },
      },
    ],
  };
  const firings = checkQuakes(big, now);
  assert.equal(firings.length, 1);
  assert.equal(firings[0].severity, 'critical');
});

test('checkQuakes: empty feature collection is quiet-is-real', () => {
  assert.deepEqual(checkQuakes({ type: 'FeatureCollection', features: [] }), []);
});

test('checkNwsAlerts: fires on severe FFW + tornado, skips the noise', () => {
  const doc = JSON.parse(readFileSync(fix('alerts-nws-2026-10-04.json'), 'utf8'));
  const firings = checkNwsAlerts(doc);
  const events = firings.map((f) => f.title.split(' — ')[0]).sort();
  assert.deepEqual(events, ['Flash Flood Warning', 'Tornado Warning']);
  const tornado = firings.find((f) => f.ruleId === 'nws-severe' && f.title.startsWith('Tornado'));
  assert.equal(tornado.severity, 'critical');
test('checkNwsAlerts: URN ids fall back to the alerts index, never a fabricated link', () => {
  const doc = JSON.parse(readFileSync(fix('alerts-nws-2026-10-04.json'), 'utf8'));
  const firings = checkNwsAlerts(doc);
  for (const f of firings) assert.equal(f.link, 'https://alerts.weather.gov');
});

test('checkNwsAlerts: full-URL upstream ids become real deep links (no double prefix)', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [
      {
        id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.SYNTHETIC',
        properties: {
          event: 'Tornado Warning',
          headline: 'TEST ONLY synthetic tornado',
          severity: 'Extreme',
          areaDesc: 'Test County',
          sent: '2026-10-04T15:00:00-05:00',
        },
      },
    ],
  };
  const firings = checkNwsAlerts(doc);
  assert.equal(firings.length, 1);
  assert.equal(
    firings[0].link,
    'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.SYNTHETIC',
  );
  assert.equal(
    firings[0].dedupeKey,
    'nws:https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.SYNTHETIC',
  );
});
  assert.ok(tornado.dedupeKey.startsWith('nws:'));
  // Small Craft Advisory (142 live) and Flood Watch are correctly excluded.
});

test('checkFaa: GDP + closures fire, per-flight delay list excluded', () => {
  const xml = readFileSync(fix('alerts-faa-2026-10-04.xml'), 'utf8');
  const firings = checkFaa(xml);
  const keys = firings.map((f) => f.dedupeKey).sort();
  assert.deepEqual(keys, [
    'faa:closure:LAX',
    'faa:closure:PHL',
    'faa:closure:SAN',
    'faa:gdp:AUS',
    'faa:gdp:BOS',
    'faa:gdp:SAN',
  ]);
  for (const f of firings) assert.equal(f.severity, 'medium');
  const aus = firings.find((f) => f.dedupeKey === 'faa:gdp:AUS');
  assert.match(aus.detail, /low ceilings/);
  // DAL/TEB departure-delay rows are deliberately excluded (low signal).
});

test('checkMirova: only very-high/extreme fire, level carried verbatim', () => {
  const html = readFileSync(fix('alerts-mirova-2026-10-04.html'), 'utf8');
  const firings = checkMirova(html);
  assert.equal(firings.length, 1);
  const f = firings[0];
  assert.equal(f.ruleId, 'mirova-thermal');
  assert.match(f.title, /very-high/); // MIROVA's own level, never recomputed
  assert.ok(f.dedupeKey.startsWith('mirova:'));
  assert.equal(f.link, 'https://www.mirovaweb.it/NRT/');
  // the real moderate row stays quiet
});

test('checkSwpc: Kp>=8 in 3h fires once with G-scale mapping', () => {
  const rows = JSON.parse(readFileSync(fix('alerts-swpc-2026-10-04.json'), 'utf8'));
  const now = Date.parse('2026-10-04T15:50:00');
  const firings = checkSwpc(rows, now);
  assert.equal(firings.length, 1);
  const f = firings[0];
  assert.equal(f.ruleId, 'swpc-g4');
  assert.equal(f.title, 'G4-class geomagnetic storm (Kp 8)'); // Kp8-4 = G4
  assert.match(f.dedupeKey, /^swpc:kp8:\d{10}$/);
  assert.equal(f.link, 'https://www.swpc.noaa.gov/products/planetary-k-index');
});

test('checkSwpc: quiet Kp stays quiet-is-real', () => {
  const rows = JSON.parse(readFileSync(fix('alerts-swpc-2026-10-04.json'), 'utf8'));
  const real = rows.slice(0, 12); // without the synthetic Kp8 row
  const now = Date.parse('2026-10-04T15:50:00');
  assert.deepEqual(checkSwpc(real, now), []);
});

test('checkSwpc: ignores rows outside the 3h window', () => {
  const now = Date.parse('2026-10-04T15:50:00');
  const stale = [{ time_tag: '2026-10-03T15:50:00', kp_index: 9 }];
  assert.deepEqual(checkSwpc(stale, now), []);
});

test('handler: 405 on non-GET, 400 on unknown rule — no network touched', async () => {
  const proxy = alertRulesProxy();
  let layers;
  proxy.configureServer({ middlewares: { use: (route, fn) => (layers = { route, fn }) } });
  assert.equal(layers.route, '/api/alert-rules');

  const run = (method, url) =>
    new Promise((resolve) => {
      const res = {
        writeHead: (s, h) => (res._s = s),
        end: (b) => resolve({ status: res._s, body: JSON.parse(b) }),
      };
      layers.fn({ method, url }, res);
    });

  const m405 = await run('POST', '/api/alert-rules');
  assert.equal(m405.status, 405);
  const b400 = await run('GET', '/api/alert-rules?rule=bogus');
  assert.equal(b400.status, 400);
  assert.deepEqual(b400.body.valid, RULE_IDS);
});
