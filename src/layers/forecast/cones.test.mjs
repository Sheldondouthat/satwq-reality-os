import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConeStorms,
  validateConeGeometry,
  coneStormEntity,
  createConeSource,
} from './cones.js';

const ring = (pts) => [...pts.map(([lon, lat]) => [lon, lat]), pts[0]];
const CONE = {
  type: 'Polygon',
  coordinates: [ring([[-60, 20], [-55, 25], [-50, 22], [-55, 18]])],
};
const STORM = {
  id: 'al142026',
  name: 'Test Storm',
  classification: 'HU',
  position: { longitude: -57, latitude: 21 },
  advisoryNumber: '12',
  geometryStatus: 'current',
  cone: CONE,
};

const payload = (storms, extra = {}) => ({ storms, unavailable: false, ...extra });

test('parseConeStorms renders current-geometry storms, skips pending ones', () => {
  const { storms, unavailable } = parseConeStorms(
    payload([STORM, { ...STORM, id: 'al152026', geometryStatus: 'pending' }]),
  );
  assert.equal(unavailable, false);
  assert.equal(storms.length, 1, 'pending geometry must not be rendered');
  assert.equal(storms[0].id, 'al142026');
  assert.equal(storms[0].cone.type, 'Polygon');
});

test('parseConeStorms reports the unavailable/upstream-down state', () => {
  const result = parseConeStorms({ unavailable: true, reason: 'boom', storms: [] });
  assert.equal(result.unavailable, true);
  assert.equal(result.reason, 'boom');
  assert.deepEqual(result.storms, []);
});

test('parseConeStorms rejects malformed payloads instead of rendering junk', () => {
  assert.throws(() => parseConeStorms(null), /Malformed/);
  assert.throws(() => parseConeStorms({ storms: 'x' }), /Malformed/);
  assert.throws(() => parseConeStorms(payload([{ ...STORM, id: 'xx999' }])), /Malformed/);
  assert.throws(
    () => parseConeStorms(payload([{ ...STORM, cone: { type: 'LineString', coordinates: [] } }])),
    /Malformed/,
  );
  assert.throws(
    () => parseConeStorms(payload([{ ...STORM, position: { longitude: 999, latitude: 0 } }])),
    /Malformed/,
  );
});

test('MultiPolygon cones validate too', () => {
  const multi = {
    id: 'ep012026',
    name: 'Multi',
    classification: 'TS',
    position: { longitude: -110, latitude: 15 },
    advisoryNumber: '3A',
    geometryStatus: 'current',
    cone: {
      type: 'MultiPolygon',
      coordinates: [CONE.coordinates, [ring([[-120, 10], [-118, 12], [-116, 11], [-118, 9]])]],
    },
  };
  const { storms } = parseConeStorms(payload([multi]));
  assert.equal(storms.length, 1);
  assert.equal(storms[0].cone.type, 'MultiPolygon');
});

test('validateConeGeometry enforces closed rings and coordinate budgets', () => {
  assert.throws(
    () => validateConeGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }, { count: 0 }),
    /Malformed/,
    'too few ring points',
  );
  assert.throws(
    () =>
      validateConeGeometry(
        { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]] },
        { count: 0 },
      ),
    /Malformed/,
    'unclosed ring',
  );
});

test('coneStormEntity builds one labeled entity per storm', () => {
  const { storms } = parseConeStorms(payload([STORM]));
  const entity = coneStormEntity(storms[0]);
  assert.equal(entity.id, 'forecast-cone:al142026');
  assert.ok(entity.polygon, 'has cone polygon');
  assert.ok(entity.point, 'has center point');
  assert.ok(
    entity.label.text.getValue().includes('Test Storm'),
    'label carries the storm name',
  );
  assert.ok(
    entity.label.text.getValue().includes('Adv 12'),
    'label carries the advisory number',
  );
});

test('createConeSource fetches /api/cyclones with timeout wiring', async () => {
  const body = JSON.stringify(payload([STORM]));
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    return { ok: true, text: async () => body, body: null };
  };
  const source = createConeSource({ fetchImpl, timeoutMs: 1000 });
  const snap = await source.getSnapshot({});
  assert.deepEqual(calls, ['/api/cyclones']);
  assert.equal(snap.storms.length, 1);
});

test('createConeSource throws on HTTP errors', async () => {
  const source = createConeSource({
    fetchImpl: async () => ({ ok: false, status: 500, body: null }),
  });
  await assert.rejects(() => source.getSnapshot({}), /Cone HTTP 500/);
});
