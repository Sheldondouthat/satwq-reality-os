import assert from 'node:assert/strict';
import test from 'node:test';
import { biosphereProxy, _biosphereInternals } from './biosphere.js';

const { trimINatObservation, trimGbifOccurrence, trimBiospherePayload } = _biosphereInternals;

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
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const INAT_OBS = {
  id: 300000001,
  observed_on: '2026-09-27',
  created_at: '2026-09-27T10:00:00Z',
  species_guess: 'Monarch',
  location: '37.2,-80.5',
  license_code: 'CC-BY-NC',
  uri: 'https://www.inaturalist.org/observations/300000001',
  user: { login: 'sheldon_naturalist' },
  taxon: {
    name: 'Danaus plexippus',
    preferred_common_name: 'Monarch',
    rank: 'species',
    iconic_taxon_name: 'Insecta',
  },
};

const GBIF_OCC = {
  key: 987654321,
  scientificName: 'Danaus plexippus (Linnaeus, 1758)',
  taxonRank: 'SPECIES',
  class: 'Insecta',
  eventDate: '2026-09-26T14:00:00',
  license: 'CC_BY_4_0',
  decimalLatitude: 37.21,
  decimalLongitude: -80.51,
  datasetName: 'eBird? no — test dataset',
};

test('biosphereProxy mounts /api/biosphere on both server shapes', () => {
  const routes = mount(biosphereProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/biosphere', '/api/biosphere']);
});

test('trimINatObservation parses lat,lon string and prefers common name', () => {
  const o = trimINatObservation(INAT_OBS);
  assert.equal(o.feed, 'inaturalist');
  assert.equal(o.id, '300000001');
  assert.equal(o.name, 'Monarch');
  assert.equal(o.scientificName, 'Danaus plexippus');
  assert.equal(o.lat, 37.2);
  assert.equal(o.lon, -80.5);
  assert.equal(o.observer, 'sheldon_naturalist');
});

test('trimINatObservation yields null coords when location is absent', () => {
  const o = trimINatObservation({ id: 1, species_guess: 'x' });
  assert.equal(o.lat, null);
  assert.equal(o.lon, null);
});

test('trimGbifOccurrence keeps decimal coords and builds occurrence URL', () => {
  const o = trimGbifOccurrence(GBIF_OCC);
  assert.equal(o.feed, 'gbif');
  assert.equal(o.id, '987654321');
  assert.equal(o.lat, 37.21);
  assert.equal(o.lon, -80.51);
  assert.equal(o.url, 'https://www.gbif.org/occurrence/987654321');
});

test('trimGbifOccurrence drops non-finite coords', () => {
  const o = trimGbifOccurrence({ key: 2, scientificName: 'x', decimalLatitude: 'bad', decimalLongitude: 5 });
  assert.equal(o.lat, null);
  assert.equal(o.lon, 5);
});

test('trimBiospherePayload counts coord-bearing observations', () => {
  const payload = trimBiospherePayload([
    { name: 'inaturalist', result: [trimINatObservation(INAT_OBS)] },
    { name: 'gbif', result: new Error('down') },
  ]);
  assert.equal(payload.count, 1);
  assert.equal(payload.withCoords, 1);
  assert.deepEqual(payload.degradedSources, ['gbif']);
});

test('handler serves merged snapshot with mocked fetch', async () => {
  _biosphereInternals.clearCaches();
  const calls = mount(biosphereProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    assert.equal(init?.redirect, 'follow'); // workerd: 'error' throws at edge (main 2ec4053)
    const u = String(url);
    let body = null;
    if (u.includes('api.inaturalist.org')) body = { results: [INAT_OBS] };
    else if (u.includes('api.gbif.org')) body = { results: [GBIF_OCC] };
    assert.ok(body, `unexpected upstream URL ${u}`);
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/biosphere'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.withCoords, 2);
    assert.deepEqual(payload.degradedSources, []);
    assert.equal(payload.items[0].feed, 'inaturalist');
    assert.equal(payload.items[1].feed, 'gbif');
    assert.match(res.headers['Cache-Control'], /max-age=900/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  _biosphereInternals.clearCaches();
  const calls = mount(biosphereProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/biosphere'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /biosphere_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(biosphereProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/biosphere', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
