import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseDmsHemisphere,
  extractTfrPolygons,
  extractTfrAreas,
  buildTfrRecord,
  tfrProxy,
  _tfrInternals,
} from './tfr.js';

const SAMPLE_DETAIL = `<XNOTAM-Update version="0.1" created="2026-09-26T11:02:29">
<Group><Add><Not><TfrNot><codeType>91.137(a)(1)</codeType>
<TFRAreaGroup>
<aseTFRArea><AseUid><codeType>RAS</codeType><codeId>24778</codeId></AseUid>
<txtName>Hazard Area1</txtName><codeDistVerUpper>ALT</codeDistVerUpper>
<valDistVerUpper>7500</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper>
<codeDistVerLower>ALT</codeDistVerLower><valDistVerLower>0</valDistVerLower>
<uomDistVerLower>FT</uomDistVerLower>
<abdMergedArea><AbdUid><txtRmk>24778</txtRmk></AbdUid>
<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType>
<geoLat>44.6666659N</geoLat><geoLong>118.59166667W</geoLong></Avx>
<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType>
<geoLat>44.66071124N</geoLat><geoLong>118.57377863W</geoLong></Avx>
<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType>
<geoLat>44.65569797N</geoLat><geoLong>118.56972563W</geoLong></Avx>
<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType>
<geoLat>44.6666659N</geoLat><geoLong>118.59166667W</geoLong></Avx>
</abdMergedArea></aseTFRArea></TFRAreaGroup>
<dateEffective>2026-09-27T13:00:00</dateEffective><dateExpire>2026-09-29T01:00:00</dateExpire>
</TfrNot></Not></Add></Group></XNOTAM-Update>`;

test('parseDmsHemisphere converts lat/lon with hemisphere letters', () => {
  assert.equal(parseDmsHemisphere('44.6666659N'), 44.6666659);
  assert.equal(parseDmsHemisphere('118.59166667W'), -118.59166667);
  assert.equal(parseDmsHemisphere('2.000S'), -2);
  assert.equal(parseDmsHemisphere('78.333E'), 78.333);
  assert.equal(parseDmsHemisphere('bogus'), null);
  assert.equal(parseDmsHemisphere('44.5'), null);
  assert.equal(parseDmsHemisphere(null), null);
});

test('extractTfrPolygons returns closed lon/lat rings', () => {
  const rings = extractTfrPolygons(SAMPLE_DETAIL);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
  assert.deepEqual(rings[0][0], [-118.59166667, 44.6666659]);
  // first == last (closed ring)
  assert.deepEqual(rings[0][0], rings[0][rings[0].length - 1]);
});

test('extractTfrPolygons drops degenerate rings', () => {
  assert.deepEqual(extractTfrPolygons('<XNOTAM-Update/>'), []);
  assert.deepEqual(
    extractTfrPolygons(
      '<abdMergedArea><Avx><geoLat>1.0N</geoLat><geoLong>2.0W</geoLong></Avx></abdMergedArea>',
    ),
    [],
  );
});

test('extractTfrAreas reads name + FT altitude band', () => {
  const areas = extractTfrAreas(SAMPLE_DETAIL);
  assert.equal(areas.length, 1);
  assert.equal(areas[0].name, 'Hazard Area1');
  assert.equal(areas[0].upperFt, 7500);
  assert.equal(areas[0].lowerFt, 0);
});

test('buildTfrRecord merges list entry + detail', () => {
  const record = buildTfrRecord(
    { notam_id: '6/5701', facility: 'ZSE', state: 'OR', type: 'HAZARDS', description: 'd' },
    SAMPLE_DETAIL,
  );
  assert.equal(record.id, '6/5701');
  assert.equal(record.type, 'HAZARDS');
  assert.equal(record.state, 'OR');
  assert.equal(record.effective, '2026-09-27T13:00:00');
  assert.equal(record.expires, '2026-09-29T01:00:00');
  assert.equal(record.rings.length, 1);
  assert.equal(record.areas[0].upperFt, 7500);
});

test('buildTfrRecord tolerates missing detail', () => {
  const record = buildTfrRecord({ notam_id: '9/9999', type: 'VIP' }, null);
  assert.equal(record.id, '9/9999');
  assert.deepEqual(record.rings, []);
  assert.deepEqual(record.areas, []);
  assert.equal(record.effective, null);
});

test('detailUrl encodes notam ids with underscore', () => {
  assert.equal(
    _tfrInternals.detailUrl('6/5701'),
    'https://tfr.faa.gov/download/detail_6_5701.xml',
  );
});

test('tfrProxy mounts /api/tfrs on both server shapes', () => {
  const provider = tfrProxy();
  assert.equal(provider.name, 'tfr');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/tfrs', '/api/tfrs']);
});

test('tfrProxy rejects non-GET with 405', async () => {
  const provider = tfrProxy();
  let handler = null;
  provider.configureServer({ middlewares: { use: (_r, h) => { handler = h; } } });
  let status = null;
  const res = {
    writeHead(s) { status = s; },
    end() {},
  };
  await handler({ method: 'POST', url: '/api/tfrs', on: () => {}, removeListener: () => {} }, res);
  assert.equal(status, 405);
});

test('loadSnapshot caps detail fetches under the subrequest budget', async () => {
  const { loadSnapshot, clearCaches, DETAIL_LIMIT } = _tfrInternals;
  clearCaches();
  const realFetch = globalThis.fetch;
  let detailCalls = 0;
  const entries = Array.from({ length: DETAIL_LIMIT + 20 }, (_, i) => ({
    notam_id: `6/57${String(i).padStart(2, '0')}`,
    txtName: `TFR ${i}`,
  }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('/download/detail_')) {
      detailCalls++;
      return {
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode(SAMPLE_DETAIL).buffer,
      };
    }
    return {
      ok: true,
      arrayBuffer: async () =>
        new TextEncoder().encode(JSON.stringify(entries)).buffer,
    };
  };
  try {
    const snap = await loadSnapshot();
    assert.equal(snap.count, DETAIL_LIMIT + 20, 'all entries still listed');
    assert.ok(
      detailCalls <= DETAIL_LIMIT,
      `detail fetches (${detailCalls}) within cap ${DETAIL_LIMIT}`,
    );
    assert.equal(snap.withGeometry, detailCalls, 'geometry only where details fetched');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
