import assert from 'node:assert/strict';
import test from 'node:test';
import { firesProxy, _firesInternals } from './fires.js';

const {
  parseHmsText,
  dedupeHmsDetections,
  yearDayToIso,
  discoverNifcIncidentService,
  parseNifcIncidents,
  buildSnapshot,
  clearCaches,
} = _firesInternals;

const HMS_FIXTURE = [
  '        Lon,        Lat, YearDay, Time,       Satellite, Method of Detect, Ecosys, Fire RadPower',
  ' -68.500916,  18.726505, 2022199, 0533,       SUOMI NPP,            VIIRS,     24,         1.150',
  ' -68.501320,  18.726900, 2022199, 0533,       SUOMI NPP,            VIIRS,     24,         1.397',
  ' -99.393158,  54.971855, 2022199, 2010,       GOES-EAST,              FDC,     23,      -999.000',
  'not-a-valid-row',
  '',
].join('\n');

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
  return { method, url: '/api/fires', headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('yearDayToIso converts YYYYDDD dates', () => {
  assert.equal(yearDayToIso('2022199'), '2022-07-18T00:00:00.000Z');
  assert.equal(yearDayToIso('junk'), null);
  assert.equal(yearDayToIso('2022367'), null); // day-of-year overflow
});

test('parseHmsText trims detections and maps FRP -999 to null', () => {
  const rows = parseHmsText(HMS_FIXTURE);
  assert.equal(rows.length, 3); // bad row + blank line skipped
  const [a, , goes] = rows;
  assert.equal(a.kind, 'detection');
  assert.equal(a.satellite, 'SUOMI NPP');
  assert.equal(a.method, 'VIIRS');
  assert.equal(a.lat, 18.7265);
  assert.equal(a.lon, -68.5009);
  assert.equal(a.date, '2022-07-18T00:00:00.000Z');
  assert.equal(a.fireRadiativePower, 1.15);
  assert.equal(goes.satellite, 'GOES-EAST');
  assert.equal(goes.fireRadiativePower, null); // -999.000 sentinel → null
  assert.deepEqual(goes.sources, ['hms']);
});

test('dedupeHmsDetections merges same-satellite near-dups, keeps strongest FRP', () => {
  const rows = parseHmsText(HMS_FIXTURE);
  const merged = dedupeHmsDetections(rows);
  assert.equal(merged.length, 2);
  const suomi = merged.find((d) => d.satellite === 'SUOMI NPP');
  assert.equal(suomi.fireRadiativePower, 1.397);
  // Different satellite at the same point does NOT merge.
  const cross = dedupeHmsDetections([
    ...rows,
    { ...rows[0], satellite: 'NOAA20', id: 'x' },
  ]);
  assert.equal(cross.length, 3);
});

test('discoverNifcIncidentService prefers the current-incidents dataset', () => {
  const dcat = {
    dataset: [
      {
        title: 'WFIGS 2026 Interagency Fire Perimeters to Date',
        distribution: [{ mediaType: 'application/json', accessURL: 'https://x/Perimeters/FeatureServer/0' }],
      },
      {
        title: 'Current Wildland Fire Incident Locations',
        distribution: [
          { mediaType: 'text/html', accessURL: 'https://x/landing' },
          { mediaType: 'application/json', accessURL: 'https://x/WFIGS_Incident_Locations_Current/FeatureServer/0' },
        ],
      },
    ],
  };
  const hit = discoverNifcIncidentService(dcat);
  assert.equal(hit.title, 'Current Wildland Fire Incident Locations');
  assert.equal(hit.serviceUrl, 'https://x/WFIGS_Incident_Locations_Current/FeatureServer/0');
  assert.equal(discoverNifcIncidentService({ dataset: [] }), null);
  assert.equal(discoverNifcIncidentService({}), null);
});

test('parseNifcIncidents normalizes WFIGS geojson', () => {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 524112,
        geometry: { type: 'Point', coordinates: [-111.0162123, 45.5373896] },
        properties: {
          OBJECTID: 524112,
          IrwinID: '{9A3939AD-CD44-4494-B0B9-29EA3764C81F}',
          IncidentName: 'FY26 West Zone Piles',
          IncidentTypeCategory: 'RX',
          IncidentSize: 12.5,
          FireDiscoveryDateTime: 1767714249000,
          PercentContained: null,
          POOState: 'US-MT',
          POOCounty: 'Gallatin',
          FireCause: 'Undetermined',
          FireMgmtComplexity: 'Type 5',
          GACC: 'NRCC',
        },
      },
      { type: 'Feature', geometry: null, properties: {} }, // dropped: no geometry
    ],
  };
  const out = parseNifcIncidents(geojson);
  assert.equal(out.length, 1);
  const [f] = out;
  assert.equal(f.kind, 'incident');
  assert.equal(f.id, 'nifc:9A3939AD-CD44-4494-B0B9-29EA3764C81F');
  assert.equal(f.lat, 45.5374);
  assert.equal(f.lon, -111.0162);
  assert.equal(f.sizeAcres, 12.5);
  assert.equal(f.discoveryTime, new Date(1767714249000).toISOString());
  assert.equal(f.state, 'US-MT');
  assert.equal(f.county, 'Gallatin');
  assert.deepEqual(f.sources, ['nifc']);
});

test('buildSnapshot puts incidents first and counts kinds', () => {
  const snap = buildSnapshot([
    { key: 'hms', ok: true, count: 2, attribution: 'h', latencyMs: 1, fileLastModified: 'Mon, 18 Jul 2022 23:55:02 GMT', dataVintage: '2022199', staleNote: 'frozen', detectionsBySatellite: { A: 2 }, fires: [
      { id: 'd1', kind: 'detection' },
      { id: 'd2', kind: 'detection' },
    ] },
    { key: 'nifc', ok: true, count: 1, attribution: 'n', latencyMs: 2, discoveredDataset: 'ds', discoveredService: 'svc', fires: [
      { id: 'i1', kind: 'incident', discoveryTime: '2026-01-01T00:00:00.000Z' },
    ] },
  ]);
  assert.equal(snap.count, 3);
  assert.deepEqual(snap.counts, { incidents: 1, detections: 2 });
  assert.equal(snap.fires[0].id, 'i1');
  assert.equal(snap.sources.hms.staleNote, 'frozen');
  assert.equal(snap.sources.nifc.discoveredService, 'svc');
});

test('firesProxy mounts /api/fires on dev and preview', () => {
  const calls = mount(firesProxy());
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.route === '/api/fires'));
});

test('firesProxy handler rejects non-GET with 405', async () => {
  const [{ handler }] = mount(firesProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('firesProxy maps upstream failure to honest 502', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(Object.assign(new Error('boom'), { status: 502 }));
  try {
    const [{ handler }] = mount(firesProxy());
    const res = fakeRes();
    await handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'fires_unavailable');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
