import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hazardLabel,
  colorForSigmet,
  altitudeRange,
  sigmetExpired,
  sigmetRing,
  colorForFlightCategory,
  fetchSigmets,
  fetchAirportReports,
  AIRPORT_DOT_STATIONS,
} from './model.js';

const SIGMET = {
  icaoId: 'SBGL',
  firId: 'SBAZ',
  hazard: 'TS',
  qualifier: 'EMBD',
  base: null,
  top: 48000,
  validFrom: 1790479800,
  validTo: 1790494200,
  coords: [
    { lon: -59.017, lat: -5.567 },
    { lon: -60.383, lat: -7.583 },
    { lon: -56.033, lat: -6.367 },
  ],
};

test('hazardLabel names known hazards, prefixes unknown ones', () => {
  assert.equal(hazardLabel('TS'), 'Thunderstorm');
  assert.equal(hazardLabel('VA'), 'Volcanic ash');
  assert.equal(hazardLabel('XYZ'), 'SIGMET XYZ');
  assert.equal(hazardLabel(''), 'SIGMET');
});

test('colorForSigmet distinguishes thunderstorm from icing', () => {
  const ts = colorForSigmet({ hazard: 'TS' });
  const ice = colorForSigmet({ hazard: 'ICE' });
  assert.notDeepEqual(ts, ice);
  assert.equal(colorForSigmet({ hazard: 'NOPE' }).r, colorForSigmet({}).r);
});

test('altitudeRange defaults null base to the surface', () => {
  assert.deepEqual(altitudeRange(SIGMET), { baseFt: 0, topFt: 48000 });
  assert.deepEqual(altitudeRange({ base: 5000, top: null }), { baseFt: 5000, topFt: null });
});

test('sigmetExpired compares validTo against now', () => {
  const now = 1790480000 * 1000;
  assert.equal(sigmetExpired(SIGMET, now), false);
  assert.equal(sigmetExpired(SIGMET, 1790500000 * 1000), true);
  assert.equal(sigmetExpired({}, now), false); // unknown validity: keep, don't hide
});

test('sigmetRing filters invalid coords', () => {
  const ring = sigmetRing({ coords: [{ lon: 1, lat: 2 }, { lon: null, lat: 3 }, null] });
  assert.deepEqual(ring, [[1, 2]]);
});

test('colorForFlightCategory grades VFR/IFR differently', () => {
  assert.notDeepEqual(colorForFlightCategory('VFR'), colorForFlightCategory('IFR'));
  assert.equal(colorForFlightCategory('vfr').g, colorForFlightCategory('VFR').g);
});

test('AIRPORT_DOT_STATIONS stays within the provider 20-station cap', () => {
  assert.ok(AIRPORT_DOT_STATIONS.length > 0 && AIRPORT_DOT_STATIONS.length <= 20);
  assert.ok(AIRPORT_DOT_STATIONS.every((s) => /^[A-Z0-9]{3,5}$/.test(s)));
});

test('fetchSigmets returns parsed snapshot on 200', async () => {
  const out = await fetchSigmets({
    fetchImpl: async () => new Response(JSON.stringify({ count: 1, sigmets: [SIGMET] }), { status: 200 }),
  });
  assert.equal(out.count, 1);
});

test('fetchSigmets throws with status on HTTP error', async () => {
  await assert.rejects(
    () => fetchSigmets({ fetchImpl: async () => new Response('x', { status: 503 }) }),
    (error) => error.status === 503,
  );
});

test('fetchAirportReports returns empty without ids, fetches with ids', async () => {
  const empty = await fetchAirportReports({ ids: [] });
  assert.deepEqual(empty.reports, []);
  const out = await fetchAirportReports({
    ids: ['KJFK'],
    fetchImpl: async (url) => {
      assert.ok(url.includes('/api/airports/metar?ids=KJFK'));
      return new Response(JSON.stringify({ reports: [{ icaoId: 'KJFK', fltcat: 'VFR' }] }), { status: 200 });
    },
  });
  assert.equal(out.reports[0].fltcat, 'VFR');
});
