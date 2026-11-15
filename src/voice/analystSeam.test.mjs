import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANALYST_LAYERS, createAnalystEngine } from '../data/analystEngine.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';

const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Every getAnalystRecords implementation in the tree, classified by host.
 *
 * `catalog` layers are registered in the application catalog
 * (src/app/constructCatalog.js, plus the localGeojson infrastructure
 * factory), so the analyst provider in gevActions.js can reach their
 * instances through the data manager — admission in ANALYST_LAYERS and in
 * the analyst_query schema enum is a complete unlock for them.
 *
 * `frontier` layers are instantiated only inside the frontier integrator
 * (src/frontier/index.js), which the analyst provider never sees. Admitting
 * one of those here would make the engine accept the key and return an
 * empty snapshot for a layer that may be showing data — a silent empty.
 * They stay unadmitted, explicitly, until their instances join the
 * catalog; moving a row from `frontier` to `catalog` in this table makes
 * the admission tests below demand the unlock.
 */
const IMPLEMENTATIONS = Object.freeze([
  {
    file: 'data/localGeojsonCore.js',
    ids: ['local-datacenters', 'local-dams'],
    host: 'catalog',
  },
  {
    file: 'layers/earthquakes/index.js',
    ids: ['earthquakes'],
    host: 'catalog',
  },
  { file: 'layers/firms/queries.js', ids: ['local-firms'], host: 'catalog' },
  { file: 'layers/flights/queries.js', ids: ['flights'], host: 'catalog' },
  { file: 'layers/military/queries.js', ids: ['military'], host: 'catalog' },
  {
    file: 'layers/perimeters/index.js',
    ids: ['fire-perimeters'],
    host: 'catalog',
  },
  {
    file: 'layers/satellites/records.js',
    ids: ['satellites'],
    host: 'catalog',
  },
  {
    file: 'layers/vessels/queries.js',
    ids: ['ais-live-vessels'],
    host: 'catalog',
  },
  { file: 'layers/aurora/index.js', ids: ['aurora'], host: 'catalog' },
  { file: 'layers/buoys/index.js', ids: ['buoys'], host: 'catalog' },
  { file: 'layers/meteors/index.js', ids: ['meteors'], host: 'catalog' },
  {
    file: 'layers/spaceWeather/index.js',
    ids: ['space-weather'],
    host: 'catalog',
  },
  { file: 'layers/tides/index.js', ids: ['tides'], host: 'catalog' },
  { file: 'layers/volcanoes/index.js', ids: ['volcanoes'], host: 'catalog' },
  { file: 'layers/wspr/index.js', ids: ['wspr'], host: 'catalog' },
  {
    file: 'layers/auroraOvation/index.js',
    ids: ['aurora-ovation'],
    host: 'frontier',
  },
  {
    file: 'layers/invisibleOcean/index.js',
    ids: ['invisible-ocean'],
    host: 'frontier',
  },
  { file: 'layers/lightning/index.js', ids: ['lightning'], host: 'frontier' },
  {
    file: 'layers/seismicWaves/index.js',
    ids: ['seismic-waves'],
    host: 'frontier',
  },
]);

function scanImplementingFiles() {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const source = readFileSync(absolute, 'utf8');
        if (/\bgetAnalystRecords\s*\(/.test(source)) {
          found.push(
            path.relative(SRC_ROOT, absolute).split(path.sep).join('/'),
          );
        }
      }
    }
  };
  visit(path.join(SRC_ROOT, 'layers'));
  visit(path.join(SRC_ROOT, 'data'));
  return found.sort();
}

function schemaAnalystEnum() {
  const tool = GEV_ACTION_SCHEMAS.find((t) => t.name === 'analyst_query');
  assert.ok(tool, 'analyst_query tool exists');
  return tool.parameters.properties.layers.items.enum;
}

test('analyst seam: every getAnalystRecords implementation is classified', () => {
  const scanned = scanImplementingFiles();
  const classified = IMPLEMENTATIONS.map((row) => row.file).sort();
  assert.deepEqual(
    scanned,
    classified,
    'a layer implemented getAnalystRecords without being classified in analystSeam.test.mjs — ' +
      'classify it as catalog (and admit it in ANALYST_LAYERS + the analyst_query enum) ' +
      'or as frontier (explicitly unadmitted, with the reason in this file)',
  );
});

test('analyst seam: the two gates admit exactly the catalog implementations', () => {
  const catalogIds = IMPLEMENTATIONS.filter((row) => row.host === 'catalog')
    .flatMap((row) => row.ids)
    .sort();
  assert.deepEqual(
    Object.keys(ANALYST_LAYERS).sort(),
    catalogIds,
    'ANALYST_LAYERS must admit every catalog layer that implements getAnalystRecords — and nothing else',
  );
  assert.deepEqual(
    [...schemaAnalystEnum()].sort(),
    catalogIds,
    'the analyst_query voice-schema enum must admit the same set as ANALYST_LAYERS',
  );
  assert.deepEqual(
    schemaAnalystEnum(),
    Object.keys(ANALYST_LAYERS),
    'the two gates keep the same layer order, so their supported-layer listings cannot drift apart',
  );
});

test('analyst seam: frontier-only implementations stay explicitly unadmitted', () => {
  const frontierIds = IMPLEMENTATIONS.filter((row) => row.host === 'frontier')
    .flatMap((row) => row.ids)
    .sort();
  assert.deepEqual(frontierIds, [
    'aurora-ovation',
    'invisible-ocean',
    'lightning',
    'seismic-waves',
  ]);
  for (const id of frontierIds) {
    assert.equal(
      ANALYST_LAYERS[id],
      undefined,
      `${id} is frontier-only; admitting it would silently return []`,
    );
    assert.equal(
      schemaAnalystEnum().includes(id),
      false,
      `${id} must not appear in the analyst_query enum`,
    );
  }
});

test('analyst seam: the engine rejects a frontier-only layer by name, never with an empty success', async () => {
  const engine = createAnalystEngine({
    getRecords: () => [{ id: 'x', lat: 0, lon: 0 }],
    resolveRegionRing: async () => null,
    getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 100 }),
  });
  const result = await engine.query({
    layers: ['seismic-waves'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /seismic-waves/);
  assert.match(result.error, /supported layers:/);
});

// Record shapes below are copied from each layer's own mapAnalystRecord.
const UNLOCKED_CASES = [
  {
    layer: 'aurora',
    records: [
      {
        id: 'aurora-0',
        type: 'aurora',
        kp: 7,
        gScale: 'G3 · Strong',
        timeMs: 1760000000000,
      },
    ],
    query: { sortBy: 'kp', limit: 1 },
    expectId: 'aurora-0',
    expectCount: 1,
  },
  {
    layer: 'buoys',
    records: [
      {
        id: 'buoy-0',
        type: 'buoy',
        stationId: '44013',
        name: 'Boston',
        stationType: 'buoy',
        lat: 42.35,
        lon: -70.65,
      },
      {
        id: 'buoy-1',
        type: 'buoy',
        stationId: '41001',
        name: 'East Hatteras',
        stationType: 'buoy',
        lat: 34.68,
        lon: -72.66,
      },
    ],
    query: { filters: [{ field: 'stationId', op: 'eq', value: '44013' }] },
    expectId: 'buoy-0',
    expectCount: 1,
  },
  {
    layer: 'meteors',
    records: [
      {
        id: 'meteor-0',
        type: 'meteor-shower',
        name: 'Perseids',
        zhr: 100,
        lat: 58,
        lon: 25,
      },
      {
        id: 'meteor-1',
        type: 'meteor-shower',
        name: 'Quadrantids',
        zhr: 80,
        lat: 50,
        lon: 20,
      },
    ],
    query: { sortBy: 'zhr', limit: 1 },
    expectId: 'meteor-0',
    expectCount: 2,
  },
  {
    layer: 'space-weather',
    records: [
      {
        id: 'space-weather-0',
        type: 'space-weather',
        speedKms: 612,
        densityPerCm3: 8.1,
        tempK: 240000,
        bzGsm: -6.2,
        timeMs: 1760000000000,
      },
    ],
    query: { sortBy: 'speedKms', limit: 1 },
    expectId: 'space-weather-0',
    expectCount: 1,
  },
  {
    layer: 'tides',
    records: [
      {
        id: 'tide-0',
        type: 'tide',
        name: 'Boston',
        trend: 'rising',
        nextHigh: null,
        nextLow: null,
        lat: 42.35,
        lon: -71.05,
      },
      {
        id: 'tide-1',
        type: 'tide',
        name: 'Portland',
        trend: 'falling',
        nextHigh: null,
        nextLow: null,
        lat: 43.65,
        lon: -70.25,
      },
    ],
    query: { filters: [{ field: 'trend', op: 'eq', value: 'rising' }] },
    expectId: 'tide-0',
    expectCount: 1,
  },
  {
    layer: 'volcanoes',
    records: [
      {
        id: 'volcano-0',
        type: 'volcano',
        name: 'Kilauea',
        colorCode: 'ORANGE',
        alertLevel: 'WATCH',
        lat: 19.4,
        lon: -155.29,
      },
      {
        id: 'volcano-1',
        type: 'volcano',
        name: 'Mauna Loa',
        colorCode: 'YELLOW',
        alertLevel: 'ADVISORY',
        lat: 19.54,
        lon: -155.59,
      },
    ],
    query: { filters: [{ field: 'alertLevel', op: 'eq', value: 'WATCH' }] },
    expectId: 'volcano-0',
    expectCount: 1,
  },
  {
    layer: 'wspr',
    records: [
      {
        id: 'wspr-0',
        type: 'wspr-spot',
        spotId: '111',
        txCall: 'K1JT',
        rxCall: 'W1AW',
        freqMHz: 14.097,
        band: '20m',
        snrDb: -12,
        time: '2026-11-15T07:16:00Z',
      },
      {
        id: 'wspr-1',
        type: 'wspr-spot',
        spotId: '222',
        txCall: 'G4XYZ',
        rxCall: 'DL1ABC',
        freqMHz: 7.04,
        band: '40m',
        snrDb: -24,
        time: '2026-11-15T07:14:00Z',
      },
    ],
    query: { sortBy: 'snrDb', limit: 1 },
    expectId: 'wspr-0',
    expectCount: 2,
  },
];

test('analyst seam: every unlocked layer answers through the engine from its own record shape', async () => {
  for (const {
    layer,
    records,
    query,
    expectId,
    expectCount,
  } of UNLOCKED_CASES) {
    const engine = createAnalystEngine({
      getRecords: (key) => (key === layer ? records : []),
      resolveRegionRing: async () => null,
      getViewContext: () => ({ lat: 0, lon: 0, viewRadiusKm: 100 }),
    });
    const result = await engine.query({
      layers: [layer],
      scope: { kind: 'anywhere' },
      ...query,
    });
    assert.equal(result.ok, true, `${layer} query must succeed`);
    assert.equal(
      result.count,
      expectCount,
      `${layer} query must match exactly its stub records`,
    );
    assert.equal(
      result.items[0].id,
      expectId,
      `${layer} must return the record drawn from its own snapshot shape`,
    );
    assert.equal(result.coverage.layersQueried[0].layerKey, layer);
    assert.equal(result.coverage.layersQueried[0].records, records.length);
  }
});
