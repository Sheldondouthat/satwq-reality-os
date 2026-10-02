/**
 * Wave 9 (R2-12) — ocearch provider tests (co-located).
 *
 * Fixtures are REAL upstream bytes captured live 2026-10-02 from
 * https://www.mapotic.com/api/v1/maps/3413/ (OCEARCH's tracker, keyless):
 * roster = 4 roster features (tiger shark "To\u00f1o" pinged 2026-09-30,
 * white shark "Breton" pinged 2026-09-29, leatherback "Tallulah" (turtle,
 * exclusion fixture), white shark "Grey Lady" last pinged 2018);
 * motion = Grey Lady's full track (25 rows, 2016-09-21 -> 2018-12-30).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  isSharkSpecies,
  selectTopSharks,
  findAnimal,
  parseMotion,
  ageDays,
  buildAnimalRow,
  buildPayload,
  motionUrl,
  numOrNull,
  _ocearchInternals,
} from './ocearch.js';

const ROSTER_FIXTURE = {"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[-79.78037,32.20996]},"properties":{"id":288211,"last_update":"2025-08-29T20:33:29.142129Z","name":"Grey Lady","slug":"grey-lady","category":8494,"is_published":true,"flags":[],"rating":null,"voting":null,"category_name":{"en":"Sharks"},"custom_marker":null,"length":"12 ft 5 in.","weight":"1,142 lbs","tag_location":"Nantucket, MA","last_move_datetime":"2018-12-30T10:28:52Z","stage_of_life":"Sub-Adult","species":"White Shark (Carcharodon carcharias)","image":"https://media.mapotic.com/i/metadata=none,width=400,height=266,fit=crop/https://media.mapotic.com/media/image/geo/3413/288211/ps5lpd_vhmw8r_img_1934_wm_6thfzs7.jpg","image_data":{"path":"https://media.mapotic.com/media/image/geo/3413/288211/ps5lpd_vhmw8r_img_1934_wm_6thfzs7.jpg","domain":"ce838d3ec.cloudimg.io"},"gender":"Female","zping":true,"zping_datetime":"2019-03-11T23:02:51+00:00"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-59.27658,44.37339]},"properties":{"id":544541,"last_update":"2026-09-29T16:00:30.643266Z","name":"Breton","slug":"breton","category":8494,"is_published":true,"flags":[],"rating":null,"voting":null,"category_name":{"en":"Sharks"},"custom_marker":null,"length":"13 ft 3 in.","weight":"1,437 lbs","tag_location":"Scatarie Island, Nova Scotia","last_move_datetime":"2026-09-29T13:29:56.844000Z","stage_of_life":"Adult","species":"White Shark (Carcharodon carcharias)","image":"https://media.mapotic.com/i/metadata=none,width=400,height=266,fit=crop/https://media.mapotic.com/media/image/geo/3413/544541/slshmw_09122020_ocearch_novascotia_scatarieisland_0749-copy_seTzp18.jpg","image_data":{"path":"https://media.mapotic.com/media/image/geo/3413/544541/slshmw_09122020_ocearch_novascotia_scatarieisland_0749-copy_seTzp18.jpg","domain":"ce838d3ec.cloudimg.io"},"gender":"Male","zping":false,"zping_datetime":"2026-09-29T12:27:44.657000+00:00"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-86.83308,20.82542]},"properties":{"id":3470603,"last_update":"2026-10-01T01:30:18.308922Z","name":"To\u00f1o","slug":"tono","category":8494,"is_published":true,"flags":[],"rating":null,"voting":null,"category_name":{"en":"Sharks"},"custom_marker":null,"length":"9 ft. 4 in.","weight":"265 lbs.","tag_location":"East of Isla Mujeres","last_move_datetime":"2026-09-30T23:39:01.318000Z","stage_of_life":"Adult","species":"Tiger Shark (Galeocerdo cuvier)","image":"https://media.mapotic.com/i/metadata=none,width=400,height=266,fit=crop/https://media.mapotic.com/media/image/geo/3413/3470603/2ojbyj-tt4-pics-slightly-edited.png","image_data":{"path":"https://media.mapotic.com/media/image/geo/3413/3470603/2ojbyj-tt4-pics-slightly-edited.png","domain":"ce838d3ec.cloudimg.io"},"gender":"Male","zping":false,"zping_datetime":"2026-09-30T19:17:56.377000+00:00"}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-68.65603,43.15089]},"properties":{"id":3552504,"last_update":"2026-10-02T07:00:26.630132Z","name":"Tallulah","slug":"tallulah","category":8496,"is_published":true,"flags":[],"rating":null,"voting":null,"category_name":{"en":"Turtles"},"custom_marker":null,"length":"5 ft. 3 in.","weight":"990 lbs.","tag_location":"Juno Beach, Florida, USA","last_move_datetime":"2026-10-02T06:21:30.866000Z","stage_of_life":"Adult","species":"Leatherback Sea Turtle (Dermochelys coriacea)","image":"https://media.mapotic.com/i/metadata=none,width=400,height=266,fit=crop/https://media.mapotic.com/media/image/geo/3413/3552504/lh2khp-tallulah.jpeg","image_data":{"path":"https://media.mapotic.com/media/image/geo/3413/3552504/lh2khp-tallulah.jpeg","domain":"ce838d3ec.cloudimg.io"},"gender":"Female","zping":false,"zping_datetime":"2026-10-02T05:27:45.347000+00:00"}}]};
const MOTION_FIXTURE = {"motion":[{"dt_move":"2016-09-21T21:32:12Z","point":{"type":"Point","coordinates":[-69.870987,41.472284]},"import_id":"ocearch:54179"},{"dt_move":"2016-09-23T02:38:57Z","point":{"type":"Point","coordinates":[-69.7907,41.31729]},"import_id":"ocearch:53863"},{"dt_move":"2016-09-23T10:05:08Z","point":{"type":"Point","coordinates":[-69.88861083984375,41.41595533303721]},"import_id":"ocearch:53862"},{"dt_move":"2016-09-30T22:50:45Z","point":{"type":"Point","coordinates":[-69.84281,41.20802]},"import_id":"ocearch:54228"},{"dt_move":"2016-09-30T23:43:10Z","point":{"type":"Point","coordinates":[-69.83467,41.21212]},"import_id":"ocearch:54229"},{"dt_move":"2016-10-01T00:29:29Z","point":{"type":"Point","coordinates":[-69.83122,41.21169]},"import_id":"ocearch:54231"},{"dt_move":"2016-10-01T06:53:58Z","point":{"type":"Point","coordinates":[-69.8389,41.19534]},"import_id":"ocearch:54242"},{"dt_move":"2016-10-01T08:47:12Z","point":{"type":"Point","coordinates":[-69.84059,41.19488]},"import_id":"ocearch:54254"},{"dt_move":"2016-11-19T08:14:55Z","point":{"type":"Point","coordinates":[-74.12713,38.25914]},"import_id":"ocearch:56505"},{"dt_move":"2016-11-19T09:09:44Z","point":{"type":"Point","coordinates":[-75.00215,37.3692]},"import_id":"ocearch:56509"},{"dt_move":"2016-11-19T10:51:28Z","point":{"type":"Point","coordinates":[-74.98932,37.338]},"import_id":"ocearch:56514"},{"dt_move":"2016-11-19T11:41:04Z","point":{"type":"Point","coordinates":[-74.98053,37.33458]},"import_id":"ocearch:56516"},{"dt_move":"2016-11-21T10:59:37Z","point":{"type":"Point","coordinates":[-74.52063,36.48779]},"import_id":"ocearch:56572"},{"dt_move":"2016-11-21T15:38:48Z","point":{"type":"Point","coordinates":[-75.17546,36.15985]},"import_id":"ocearch:56576"},{"dt_move":"2016-11-22T08:44:45Z","point":{"type":"Point","coordinates":[-75.8209,35.41024]},"import_id":"ocearch:56611"},{"dt_move":"2016-12-11T18:31:42Z","point":{"type":"Point","coordinates":[-80.50903,31.25132]},"import_id":"ocearch:57348"},{"dt_move":"2016-12-11T19:21:18Z","point":{"type":"Point","coordinates":[-80.51676,31.25789]},"import_id":"ocearch:57352"},{"dt_move":"2016-12-11T22:22:36Z","point":{"type":"Point","coordinates":[-80.56225,31.2453]},"import_id":"ocearch:57361"},{"dt_move":"2016-12-15T03:34:27Z","point":{"type":"Point","coordinates":[-81.1421,30.10213]},"import_id":"ocearch:57467"},{"dt_move":"2017-03-17T01:17:20Z","point":{"type":"Point","coordinates":[-79.59439,32.49797]},"import_id":"ocearch:60440"},{"dt_move":"2017-03-24T04:47:20Z","point":{"type":"Point","coordinates":[-79.54764,32.04609]},"import_id":"ocearch:60570"},{"dt_move":"2017-03-24T08:00:42Z","point":{"type":"Point","coordinates":[-79.83556,32.05442]},"import_id":"ocearch:60573"},{"dt_move":"2017-03-31T03:30:49Z","point":{"type":"Point","coordinates":[-80.72577,32.03208]},"import_id":"ocearch:60676"},{"dt_move":"2017-04-01T00:02:21Z","point":{"type":"Point","coordinates":[-80.1368,32.0615]},"import_id":"ocearch:61085"},{"dt_move":"2018-12-30T10:28:52Z","point":{"type":"Point","coordinates":[-79.78037,32.20996]},"import_id":"ocearch:81823"}],"center":[-76.63437473492813,35.04222811700688],"boundaries":[[-81.1421,30.10213],[-69.7907,41.472284]]};
test('numOrNull guards the Number(null)/Number("")===0 trap', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(0), 0); // real zero is preserved, not nulled
  assert.equal(numOrNull(-79.78037), -79.78037);
  assert.equal(numOrNull('288211'), 288211);
});

test('parseQuery: defaults, n bounds, animal ids', () => {
  const q = (s) => new URL(`http://x/?${s}`).searchParams;
  assert.deepEqual(parseQuery(q('')), { mode: 'top', n: 12 });
  assert.deepEqual(parseQuery(q('n=24')), { mode: 'top', n: 24 });
  assert.deepEqual(parseQuery(q('n=1')), { mode: 'top', n: 1 });
  assert.deepEqual(parseQuery(q('animal=544541')), { mode: 'animal', animalId: 544541 });
  for (const bad of ['n=0', 'n=25', 'n=abc', 'n=-1', 'n=12.5']) {
    assert.throws(() => parseQuery(q(bad)), /ocearch_bad_n/, bad);
  }
  for (const bad of ['animal=abc', 'animal=-1', 'animal=12.5', 'animal=!']) {
    assert.throws(() => parseQuery(q(bad)), /ocearch_bad_animal/, bad);
  }
});

test('isSharkSpecies: sharks pass, turtles fail', () => {
  assert.equal(isSharkSpecies('White Shark (Carcharodon carcharias)'), true);
  assert.equal(isSharkSpecies('Tiger Shark (Galeocerdo cuvier)'), true);
  assert.equal(isSharkSpecies('Shortfin Mako Shark (Isurus oxyrinchus)'), true);
  assert.equal(isSharkSpecies('Hammerhead Shark (Sphyrnidae)'), true);
  assert.equal(isSharkSpecies('Leatherback Sea Turtle (Dermochelys coriacea)'), false);
  assert.equal(isSharkSpecies('Loggerhead Sea Turtle (Caretta caretta)'), false);
  assert.equal(isSharkSpecies(''), false);
  assert.equal(isSharkSpecies(null), false);
});

test('selectTopSharks on real roster: turtles excluded, newest-first', () => {
  const top = selectTopSharks(ROSTER_FIXTURE, 12);
  assert.equal(top.length, 3); // 4th feature is a leatherback turtle
  const ids = top.map((f) => f.properties.id);
  assert.deepEqual(ids, [3470603, 544541, 288211]); // Toño, Breton, Grey Lady
  assert.ok(!ids.includes(3552504));
  const top2 = selectTopSharks(ROSTER_FIXTURE, 2);
  assert.equal(top2.length, 2);
  assert.deepEqual(top2.map((f) => f.properties.id), [3470603, 544541]);
  // empty / malformed rosters → empty selection, never throws
  assert.deepEqual(selectTopSharks({}, 12), []);
  assert.deepEqual(selectTopSharks({ features: null }, 12), []);
});

test('findAnimal: sharks found, turtles and unknowns miss', () => {
  const breton = findAnimal(ROSTER_FIXTURE, 544541);
  assert.equal(breton.properties.name, 'Breton');
  assert.equal(findAnimal(ROSTER_FIXTURE, 3552504), null); // turtle: sharks-only
  assert.equal(findAnimal(ROSTER_FIXTURE, 99999999), null);
});

test('parseMotion on real Grey Lady bytes: 25 ascending pings, real coords', () => {
  const pings = parseMotion(MOTION_FIXTURE);
  assert.equal(pings.length, 25);
  // ascending: last ping is the roster's own latest fix (2018-12-30)
  assert.equal(pings[24].time, '2018-12-30T10:28:52Z');
  assert.equal(pings[24].lat, 32.20996);
  assert.equal(pings[24].lon, -79.78037);
  assert.equal(pings[0].time, '2016-09-21T21:32:12Z');
  for (let i = 1; i < pings.length; i++) assert.ok(pings[i].time >= pings[i - 1].time);
});

test('parseMotion skips corrupt rows and caps at newest 80', () => {
  const mk = (i) => ({ dt_move: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`, point: { coordinates: [-70 - i / 1000, 40 + i / 1000] } });
  const rows = Array.from({ length: 85 }, (_, i) => mk(i));
  rows.push({ dt_move: '2026-02-01T00:00:00Z', point: { coordinates: [null, 41] } }); // bad coords
  rows.push({ dt_move: null, point: { coordinates: [-70, 41] } }); // bad time
  rows.push({ dt_move: '2026-02-01T00:00:00Z', point: { coordinates: [0, 0] } }); // 0,0 is kept (real coords possible) but valid
  const pings = parseMotion({ motion: rows });
  assert.equal(pings.length, 80);
  // the [0,0] row is valid coords (kept) and the newest valid row overall
  assert.equal(pings[79].time, '2026-02-01T00:00:00Z');
  assert.deepEqual([pings[79].lat, pings[79].lon], [0, 0]);
  // the two corrupt rows were dropped, not zero-filled
  assert.ok(pings.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.time));
});

test('buildAnimalRow on Grey Lady: real motion track stats', () => {
  const greyLady = findAnimal(ROSTER_FIXTURE, 288211);
  const pings = parseMotion(MOTION_FIXTURE);
  const row = buildAnimalRow(greyLady, pings, 'motion');
  assert.equal(row.id, 288211);
  assert.equal(row.name, 'Grey Lady');
  assert.equal(row.species, 'White Shark (Carcharodon carcharias)');
  assert.equal(row.gender, 'Female');
  assert.equal(row.trackSource, 'motion');
  assert.equal(row.ok, true);
  assert.equal(row.pingCount, 25);
  assert.equal(row.lastPing, '2018-12-30T10:28:52Z');
  assert.equal(row.firstPing, '2016-09-21T21:32:12Z');
  assert.ok(Math.abs(row.spanDays - 829.5) < 0.05); // independent python check: 829.539 days
  assert.equal(row.fresh, false); // last ping 2018 — dark, correctly
  assert.ok(row.lastPingAgeDays > 2500);
  assert.equal(row.zping.flag, true); // roster byte: true (tag surfaced 2019-03-11 without a fix)
  assert.equal(row.zping.datetime, '2019-03-11T23:02:51+00:00');
  assert.ok(row.photo.startsWith('https://media.mapotic.com/'));
});

test('buildAnimalRow fallback: motion miss → roster latest-point (real coordinate)', () => {
  const breton = findAnimal(ROSTER_FIXTURE, 544541);
  const row = buildAnimalRow(breton, [], 'motion');
  assert.equal(row.trackSource, 'roster-point');
  assert.equal(row.ok, true);
  assert.equal(row.pingCount, 1);
  assert.equal(row.pings[0].lat, 44.37339);
  assert.equal(row.pings[0].lon, -59.27658);
  assert.equal(row.pings[0].time, '2026-09-29T13:29:56.844000Z');
  assert.equal(row.fresh, true);
});

test('buildAnimalRow dark: no motion and no geometry → ok:false, never faked', () => {
  const row = buildAnimalRow({ properties: { id: 1, name: 'X', species: 'Shark' }, geometry: null }, [], 'motion');
  assert.equal(row.ok, false);
  assert.equal(row.pingCount, 0);
  assert.deepEqual(row.pings, []);
});

test('ageDays: fractional diffs; garbage → null', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.ok(Math.abs(ageDays('2026-09-29T13:29:56.844000Z', now) - 2.43) < 0.01);
  assert.equal(ageDays('garbage', now), null);
});

test('motionUrl shape', () => {
  assert.equal(motionUrl(544541), 'https://www.mapotic.com/api/v1/maps/3413/pois/544541/motion/with-meta/');
});

test('buildPayload: summary + freshest ping from real rows', () => {
  const top = selectTopSharks(ROSTER_FIXTURE, 12);
  const rows = top.map((f) => {
    if (f.properties.id === 288211) return buildAnimalRow(f, parseMotion(MOTION_FIXTURE), 'motion');
    return buildAnimalRow(f, [], 'motion');
  });
  const payload = buildPayload(rows, 3, false);
  assert.equal(payload.summary.animals, 3);
  assert.equal(payload.summary.ok, 3);
  assert.equal(payload.summary.dark, 0);
  assert.equal(payload.summary.sharksInMap, 3);
  assert.equal(payload.summary.freshestPingUtc, '2026-09-30T23:39:01.318000Z'); // Toño
  assert.equal(payload.summary.fresh, 2); // Toño + Breton fresh; Grey Lady dark
  assert.equal(payload.stale, false);
  assert.ok(payload.honesty.spotPings.length > 50);
  assert.ok(payload.honesty.straightLines.includes('NOT'));
});

test('buildPayload stale flag passes through', () => {
  const payload = buildPayload([], 0, true);
  assert.equal(payload.stale, true);
  assert.equal(payload.summary.animals, 0);
});

test('_ocearchInternals exposes the pieces the harness probes', () => {
  assert.equal(typeof _ocearchInternals.clearCaches, 'function');
  assert.ok(_ocearchInternals.ROSTER_URL.includes('/api/v1/maps/3413/pois.geojson/'));
});
