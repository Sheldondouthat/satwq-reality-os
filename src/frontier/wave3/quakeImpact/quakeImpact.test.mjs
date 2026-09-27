import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mmiColor,
  pagerColor,
  normalizeDyfi,
  normalizeMmiContours,
  getQuakeImpact,
  findLargestRecentQuake,
} from './impact.js';

// Fixtures shaped from the live us7000ti1p detail (verified 2026-09-27),
// trimmed to the fields this module reads.

const DETAIL_FIXTURE = {
  geometry: { coordinates: [-171.5033, 52.9564, 33] },
  properties: {
    mag: 6.5,
    place: '177 km W of Nikolski, Alaska',
    time: 1758950000000,
    alert: 'green',
    products: {
      dyfi: [
        {
          contents: {
            'dyfi_geo_10km.geojson': {
              url: 'https://earthquake.usgs.gov/product/dyfi/us7000ti1p/us/1/dyfi_geo_10km.geojson',
            },
          },
        },
      ],
      shakemap: [
        {
          contents: {
            'download/cont_mmi.json': {
              url: 'https://earthquake.usgs.gov/product/shakemap/us7000ti1p/us/1/download/cont_mmi.json',
            },
          },
        },
      ],
      losspager: [
        {
          contents: {
            'json/alerts.json': {
              url: 'https://earthquake.usgs.gov/product/losspager/us7000ti1p/us/1/json/alerts.json',
            },
          },
        },
      ],
    },
  },
};

const DYFI_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[-174.22, 52.13], [-174.07, 52.13], [-174.07, 52.22], [-174.22, 52.22], [-174.22, 52.13]]] },
      properties: { cdi: 3.4, dist: 221, name: 'UTM:(1U 069 578 10000)<br>Atka', nresp: 1, stddev: 0.33 },
    },
    {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[-175.0, 52.0], [-174.9, 52.0], [-174.9, 52.1], [-175.0, 52.1], [-175.0, 52.0]]] },
      properties: { cdi: 2.1, dist: 300, name: 'Adak', nresp: 2 },
    },
  ],
};

const MMI_FIXTURE = {
  type: 'FeatureCollection',
  metadata: { eventid: 'us7000ti1p' },
  features: [
    {
      type: 'Feature',
      properties: { value: 4.0, units: 'mmi', color: '#80ffff', weight: 2 },
      geometry: { type: 'MultiPolygon', coordinates: [[[[-173.06, 53.41], [-173.03, 53.41], [-173.03, 53.42], [-173.06, 53.42], [-173.06, 53.41]]]] },
    },
    {
      type: 'Feature',
      properties: { value: 6.5, units: 'mmi', color: '#ff9d5c', weight: 4 },
      geometry: { type: 'MultiPolygon', coordinates: [[[[-171.6, 52.95], [-171.5, 52.95], [-171.5, 53.0], [-171.6, 53.0], [-171.6, 52.95]]]] },
    },
  ],
};

const ALERTS_FIXTURE = {
  fatality: { type: 'fatality', units: 'fatalities', gvalue: 1.0, level: 'green', bins: [] },
  economic: { type: 'economic', units: 'USD', gvalue: 1.0, level: 'green', bins: [] },
};

test('mmiColor: ramps from cyan (low) to dark red (extreme)', () => {
  assert.equal(mmiColor(1.5), '#80ffff');
  assert.equal(mmiColor(6.5), '#ff9d5c');
  assert.equal(mmiColor(9.5), '#a00000');
  assert.equal(mmiColor(NaN), '#8a93a6');
});

test('pagerColor: maps the four PAGER levels', () => {
  assert.equal(pagerColor('green'), '#4dd07a');
  assert.equal(pagerColor('red'), '#ff3b3b');
  assert.equal(pagerColor('bogus'), '#8a93a6');
});

test('normalizeDyfi: centroids + cdi from the 10km grid (live shape)', () => {
  const pts = normalizeDyfi(DYFI_FIXTURE);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].cdi, 3.4);
  assert.ok(Math.abs(pts[0].lat - 52.175) < 0.01, `lat ${pts[0].lat}`);
  assert.equal(pts[0].nresp, 1);
  assert.match(pts[0].name, /Atka/);
  assert.ok(!pts[0].name.includes('<br>'), 'HTML stripped from names');
});

test('normalizeMmiContours: sorted by MMI, rings kept', () => {
  const cs = normalizeMmiContours(MMI_FIXTURE);
  assert.equal(cs.length, 2);
  assert.equal(cs[0].mmi, 4.0);
  assert.equal(cs[1].mmi, 6.5);
  assert.equal(cs[1].rings.length, 1);
});

function stubFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected url ${url}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return { ok: true, json: async () => value };
  };
}

test('getQuakeImpact: full bundle from stubbed USGS (live-verified shapes)', async () => {
  const impact = await getQuakeImpact('us7000ti1p', {
    fetchImpl: stubFetch({
      'eventid=us7000ti1p': DETAIL_FIXTURE,
      'dyfi_geo_10km.geojson': DYFI_FIXTURE,
      'cont_mmi.json': MMI_FIXTURE,
      'json/alerts.json': ALERTS_FIXTURE,
    }),
  });
  assert.equal(impact.mag, 6.5);
  assert.equal(impact.pager.level, 'green');
  assert.equal(impact.pager.kind, 'model');
  assert.equal(impact.pager.economic.level, 'green');
  assert.equal(impact.dyfi.available, true);
  assert.equal(impact.dyfi.kind, 'observation');
  assert.equal(impact.dyfi.points.length, 2);
  assert.equal(impact.dyfi.maxCdi, 3.4);
  assert.equal(impact.shakemap.available, true);
  assert.equal(impact.shakemap.kind, 'model');
  assert.equal(impact.shakemap.contours.length, 2);
});

test('getQuakeImpact: missing products degrade to available:false, never throw', async () => {
  const bare = { geometry: { coordinates: [0, 0, 10] }, properties: { mag: 5.5, place: 'X', time: 1, products: {} } };
  const impact = await getQuakeImpact('xx000', {
    fetchImpl: stubFetch({ 'eventid=xx000': bare }),
  });
  assert.equal(impact.pager.available, false);
  assert.equal(impact.dyfi.available, false);
  assert.equal(impact.shakemap.available, false);
});

test('getQuakeImpact: off-origin product URLs are rejected (no SSRF through ComCat)', async () => {
  const evil = JSON.parse(JSON.stringify(DETAIL_FIXTURE));
  evil.properties.products.dyfi[0].contents['dyfi_geo_10km.geojson'].url = 'https://evil.example.com/x.geojson';
  const seen = [];
  const impact = await getQuakeImpact('us7000ti1p', {
    fetchImpl: async (url) => {
      seen.push(String(url));
      if (String(url).includes('eventid=')) return { ok: true, json: async () => evil };
      return { ok: true, json: async () => MMI_FIXTURE };
    },
  });
  assert.ok(!seen.some((u) => u.includes('evil.example.com')), 'evil URL never fetched');
  assert.equal(impact.dyfi.available, false);
});

test('getQuakeImpact: requires an eventId', async () => {
  await assert.rejects(() => getQuakeImpact(null, { fetchImpl: stubFetch({}) }), /eventId required/);
});

test('findLargestRecentQuake: picks the biggest M5.5+ from the feed', async () => {
  const feed = {
    features: [
      { id: 'a', properties: { mag: 5.6, place: 'small', ids: ',usAAAA,' } },
      { id: 'b', properties: { mag: 6.8, place: 'big', ids: ',usBBBB,' } },
      { id: 'c', properties: { mag: null, place: 'bad', ids: ',usCCCC,' } },
    ],
  };
  const q = await findLargestRecentQuake({ fetchImpl: stubFetch({ '4.5_day': feed }) });
  assert.equal(q.eventId, 'usBBBB');
  assert.equal(q.mag, 6.8);
});

test('findLargestRecentQuake: returns null when nothing qualifies', async () => {
  const q = await findLargestRecentQuake({
    fetchImpl: stubFetch({ '4.5_day': { features: [{ properties: { mag: 4.0, ids: ',usX,' } }] } }),
  });
  assert.equal(q, null);
});
