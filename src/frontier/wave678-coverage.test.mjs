/**
 * Wave5–8 audit coverage test (wave5-recur-ui branch).
 *
 * Asserts that every Wave6/7/8 route the audit found missing a frontend
 * layer now has: (1) a pure model with the exact registry ROUTE, (2) an
 * `attempt('<id>', …)` mount in src/frontier/index.js, (3) a theme key in
 * scripts/theme-keys-wave5.json.
 *
 * ROUTES below are copied from server/pages/registry.mjs. If the registry
 * gains a route, add the row here AND the layer.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const ROUTES = [
  // [route, waveDir, attemptId]
  ['/api/pskreporter', 'wave6/pskreporter', 'pskreporter'],
  ['/api/sondes', 'wave6/sondes', 'sondes'],
  ['/api/gliders', 'wave6/gliders', 'gliders'],
  ['/api/frequencies', 'wave6/frequencies', 'frequencies'],
  ['/api/ham-space', 'wave6/hamSpace', 'hamSpace'],
  ['/api/aircraft', 'wave6/aircraft', 'aircraft'],
  ['/api/ships', 'wave6/ships', 'ships'],
  ['/api/buoys', 'wave6/buoys', 'buoys'],
  ['/api/tides', 'wave6/tides', 'tides'],
  ['/api/whales', 'wave6/whales', 'whales'],
  ['/api/meteor-stations', 'wave6/meteorStations', 'meteorStations'],
  ['/api/trains', 'wave6/trains', 'trains'],
  ['/api/bikeshare', 'wave6/bikeshare', 'bikeshare'],
  ['/api/comets', 'wave6/comets', 'comets'],
  ['/api/dsn', 'wave6/dsn', 'dsn'],
  ['/api/fires', 'wave6/fires', 'fires'],
  ['/api/disasters', 'wave6/disasters', 'disasters'],
  ['/api/alerts', 'wave6/alerts', 'alerts'],
  ['/api/solar-img', 'wave6/solarImg', 'solarImg'],
  ['/api/aurora-cams', 'wave6/auroraCams', 'auroraCams'],
  ['/api/volcano-cams', 'wave6/volcanoCams', 'volcanoCams'],
  ['/api/magnetometers', 'wave6/magnetometers', 'magnetometers'],
  ['/api/birdcast', 'wave6/birdcast', 'birdcast'],
  ['/api/coral', 'wave6/coral', 'coral'],
  ['/api/lightning', 'wave6/lightning', 'lightning'],
  ['/api/stations-ext', 'wave6/stationsExt', 'stationsExt'],
  ['/api/knowledge', 'wave6/knowledge', 'knowledge'],
  ['/api/sports', 'wave6/sports', 'sports'],
  ['/api/tec', 'wave7/tec', 'tec'],
  ['/api/mbta', 'wave7/mbta', 'mbta'],
  ['/api/aq-model', 'wave7/aqModel', 'aqModel'],
  ['/api/ioos', 'wave7/ioos', 'ioos'],
  ['/api/birdcast-dash', 'wave7/birdcastDash', 'birdcastDash'],
  ['/api/infrasound-ims', 'wave8/infrasound', 'infrasound'],
  ['/api/geomag-usgs', 'wave8/geomagUsgs', 'geomagUsgs'],
  ['/api/icon-d2', 'wave8/iconD2', 'iconD2'],
  ['/api/currents', 'wave8/currents', 'currents'],
  ['/api/gtfs-de', 'wave8/gtfsDe', 'gtfsDe'],
  ['/api/nhc-gis', 'wave8/nhcGis', 'nhcGis'],
  ['/api/findu', 'wave8/findu', 'findu'],
  ['/api/iss-ext', 'wave8/issExt', 'issExt'],
  ['/api/gracedb', 'wave8/gracedb', 'gracedb'],
  ['/api/nexrad', 'wave9/nexrad', 'nexrad'],
  ['/api/goes', 'wave9/goes', 'goes'],
  ['/api/usdm', 'wave9/usdm', 'usdm'],
  ['/api/exoplanets', 'wave9/exoplanets', 'exoplanets'],
  ['/api/pollen', 'wave9/pollen', 'pollen'],
  ['/api/hab', 'wave9/hab', 'hab'],
  ['/api/usace', 'wave9/usace', 'usace'],
];

const indexSrc = readFileSync(join(ROOT, 'src', 'frontier', 'index.js'), 'utf8');
const themeKeys = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'theme-keys-wave5.json'), 'utf8'),
).map((entry) => entry.key);
const indexImports = readFileSync(join(ROOT, 'src', 'frontier', 'index.js'), 'utf8');

test('all 49 audited routes have a model with the exact registry ROUTE', async () => {
  assert.equal(ROUTES.length, 49);
  const seen = new Set();
  for (const [route, waveDir] of ROUTES) {
    const mod = await import(`./${waveDir}/model.js`);
    assert.equal(mod.ROUTE, route, `${waveDir}/model.js ROUTE mismatch`);
    assert.ok(!seen.has(route), `duplicate ROUTE ${route}`);
    seen.add(route);
  }
});

test('every layer is mounted via attempt() and imported in frontier/index.js', () => {
  for (const [, waveDir, attemptId] of ROUTES) {
    assert.ok(
      indexSrc.includes(`attempt('${attemptId}'`),
      `missing attempt('${attemptId}') in frontier/index.js`,
    );
    assert.ok(
      indexImports.includes(`./${waveDir}/index.js`),
      `missing import of ./${waveDir}/index.js in frontier/index.js`,
    );
  }
});

test('every layer has a theme key registered', () => {
  for (const [, waveDir] of ROUTES) {
    // index.js keeps themeKey in the createTickerInit spec; verify it is registered
    const idx = readFileSync(join(ROOT, 'src', 'frontier', waveDir, 'index.js'), 'utf8');
    const m = idx.match(/themeKey:\s*'([^']+)'/);
    assert.ok(m, `no themeKey in ${waveDir}/index.js`);
    assert.ok(
      themeKeys.includes(m[1]),
      `theme key ${m[1]} missing from scripts/theme-keys-wave5.json`,
    );
  }
});
