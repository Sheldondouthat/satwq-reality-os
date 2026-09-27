/**
 * Akashic Records tests — REAL assertions (node:test).
 * Covers schema, store, archiver record builders, and timeline helpers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey,
  dayStartMs,
  shiftDay,
  validateRecord,
  daySummary,
  SIGNIFICANCE,
  ARCHIVE_ALERT_EVENTS,
} from './schema.js';
import { createAkashicStore, createMemoryBackend } from './store.js';
import {
  quakeRecord,
  nwsAlertRecord,
  incidentRecord,
  fireballRecord,
  fireballRowsToObjects,
  launchRecord,
  stormRecord,
  runArchiveSweep,
} from './archiver.js';
import { nearestDayIndex } from './timeline.js';

const T0 = Date.parse('2026-09-27T12:00:00.000Z');

function goodRecord(over = {}) {
  return {
    id: 'akashic:test:1',
    day: '2026-09-27',
    kind: 'quake',
    atMs: T0,
    capturedMs: T0 + 1000,
    title: 'M6.0 test quake',
    detail: 'detail',
    lat: 10,
    lon: 20,
    severity: 'high',
    sources: ['usgs'],
    snapshot: { mag: 6.0 },
    ...over,
  };
}

describe('schema', () => {
  it('dayKey produces UTC day keys', () => {
    assert.equal(dayKey(T0), '2026-09-27');
    assert.equal(dayKey(Date.parse('2026-09-27T00:00:00Z')), '2026-09-27');
    assert.equal(dayKey(NaN), null);
    assert.equal(dayKey('nope'), null);
  });

  it('dayStartMs round-trips day keys', () => {
    assert.equal(dayStartMs('2026-09-27'), Date.parse('2026-09-27T00:00:00Z'));
    assert.equal(dayStartMs('bad'), null);
    assert.equal(dayStartMs(null), null);
  });

  it('shiftDay moves across month boundaries', () => {
    assert.equal(shiftDay('2026-09-27', 1), '2026-09-28');
    assert.equal(shiftDay('2026-03-01', -1), '2026-02-28');
    assert.equal(shiftDay('nope', 1), null);
  });

  it('validateRecord accepts a good record', () => {
    assert.equal(validateRecord(goodRecord()), null);
  });

  it('validateRecord rejects bad fields with reasons', () => {
    assert.equal(validateRecord(null), 'not-an-object');
    assert.equal(validateRecord(goodRecord({ id: '' })), 'bad-id');
    assert.equal(validateRecord(goodRecord({ day: '27/09' })), 'bad-day');
    assert.equal(validateRecord(goodRecord({ kind: 'ufo' })), 'bad-kind');
    assert.equal(validateRecord(goodRecord({ severity: 'extreme' })), 'bad-severity');
    assert.equal(validateRecord(goodRecord({ title: 'x'.repeat(201) })), 'bad-title');
    assert.equal(validateRecord(goodRecord({ detail: 'x'.repeat(281) })), 'bad-detail');
    assert.equal(validateRecord(goodRecord({ sources: ['usgs', 7] })), 'bad-sources');
  });

  it('daySummary formats counts', () => {
    assert.equal(daySummary('2026-09-27', 1), 'Sep 27 — 1 event');
    assert.equal(daySummary('2026-09-27', 4), 'Sep 27 — 4 events');
  });
});

describe('store', () => {
  it('archives, dedupes, lists days sorted', () => {
    const store = createAkashicStore({ backend: createMemoryBackend() });
    assert.equal(store.archive(goodRecord()), 'added');
    assert.equal(store.archive(goodRecord()), 'duplicate');
    assert.equal(store.archive(goodRecord({ id: '' })), 'invalid');
    assert.equal(
      store.archive(goodRecord({ id: 'akashic:test:2', day: '2026-09-26', atMs: T0 - 86400000 })),
      'added',
    );
    assert.deepEqual(store.days(), ['2026-09-26', '2026-09-27']);
    assert.equal(store.eventsForDay('2026-09-27').length, 1);
  });

  it('orders events chronologically within a day', () => {
    const store = createAkashicStore({ backend: createMemoryBackend() });
    store.archive(goodRecord({ id: 'b', atMs: T0 + 5000 }));
    store.archive(goodRecord({ id: 'a', atMs: T0 - 5000 }));
    const ids = store.eventsForDay('2026-09-27').map((r) => r.id);
    assert.deepEqual(ids, ['a', 'b']);
  });

  it('prune drops days beyond retention', () => {
    const store = createAkashicStore({ backend: createMemoryBackend(), maxDays: 2 });
    store.archive(goodRecord({ id: 'old', day: '2026-09-20', atMs: Date.parse('2026-09-20T00:00:00Z') }));
    store.archive(goodRecord({ id: 'new', day: '2026-09-27', atMs: T0 }));
    const removed = store.prune(T0);
    assert.equal(removed, 1);
    assert.deepEqual(store.days(), ['2026-09-27']);
  });

  it('memory backend round-trips through a storage-shaped wrapper', () => {
    const mem = {};
    const fake = {
      getItem: (k) => (k in mem ? mem[k] : null),
      setItem: (k, v) => {
        mem[k] = String(v);
      },
      removeItem: (k) => delete mem[k],
      keys: () => Object.keys(mem),
    };
    const store = createAkashicStore({ backend: fake });
    store.archive(goodRecord());
    assert.equal(store.eventsForDay('2026-09-27')[0].title, 'M6.0 test quake');
  });
});

describe('archiver record builders', () => {
  it('quakeRecord archives M5.5+ and rejects weaker quakes', () => {
    const feat = (mag) => ({
      id: 'us1',
      geometry: { coordinates: [20, 10, 33] },
      properties: { mag, place: '10km S of Testville', time: T0, tsunami: 0, url: 'https://x' },
    });
    assert.equal(quakeRecord(feat(5.4), T0), null);
    const rec = quakeRecord(feat(6.2), T0);
    assert.ok(rec);
    assert.equal(rec.kind, 'quake');
    assert.equal(rec.day, '2026-09-27');
    assert.equal(rec.severity, 'high');
    assert.equal(rec.snapshot.mag, 6.2);
    assert.equal(rec.snapshot.depthKm, 33);
    assert.equal(validateRecord(rec), null);
  });

  it('quakeRecord grades severity: critical >= 7', () => {
    const feat = {
      id: 'us2',
      geometry: { coordinates: [20, 10, 10] },
      properties: { mag: 7.4, place: 'p', time: T0 },
    };
    assert.equal(quakeRecord(feat, T0).severity, 'critical');
  });

  it('nwsAlertRecord keeps warnings, drops watches/advisories', () => {
    const feat = (event) => ({
      properties: {
        id: 'https://api.weather.gov/alerts/urn:oid:1',
        event,
        sent: '2026-09-27T10:00:00Z',
        areaDesc: 'Test County',
        headline: 'headline',
        severity: 'Severe',
      },
      geometry: { type: 'Point', coordinates: [-80, 37] },
    });
    assert.equal(nwsAlertRecord(feat('Heat Advisory'), T0), null);
    const rec = nwsAlertRecord(feat('Tornado Warning'), T0);
    assert.ok(rec);
    assert.equal(rec.kind, 'alert');
    assert.equal(rec.severity, 'critical');
    assert.equal(rec.lat, 37);
    assert.equal(validateRecord(rec), null);
    assert.ok(ARCHIVE_ALERT_EVENTS.includes('Tornado Warning'));
  });

  it('incidentRecord archives only high-severity synthesized incidents', () => {
    const inc = {
      id: 'smoke-traffic:1,2',
      type: 'smoke-near-traffic',
      title: 'Heavy wildfire smoke near dense air traffic',
      detail: 'detail',
      severity: 'moderate',
      confidence: 0.5,
      sources: ['hms-smoke'],
      lat: 40,
      lon: -120,
      at: '2026-09-27T09:00:00.000Z',
    };
    assert.equal(incidentRecord(inc, T0), null); // moderate → not archived
    const rec = incidentRecord({ ...inc, severity: 'high' }, T0);
    assert.ok(rec);
    assert.equal(rec.kind, 'incident');
    assert.equal(validateRecord(rec), null);
  });

  it('fireballRowsToObjects maps the real CNEOS array-row shape', () => {
    const payload = {
      fields: ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'],
      data: [['2025-01-10 21:11:07', '2.7', '0.095', '47.2', 'N', '106.3', 'E', '34.6', '14.0']],
    };
    const rows = fireballRowsToObjects(payload);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, '2025-01-10 21:11:07');
    assert.equal(rows[0]['impact-e'], '0.095');
  });

  it('fireballRecord parses the real row and applies the energy floor', () => {
    const row = {
      date: '2025-01-10 21:11:07',
      energy: '2.7',
      'impact-e': '0.15',
      lat: '47.2',
      'lat-dir': 'N',
      lon: '106.3',
      'lon-dir': 'E',
      alt: '34.6',
      vel: '14.0',
    };
    const rec = fireballRecord(row, T0);
    assert.ok(rec);
    assert.equal(rec.kind, 'fireball');
    assert.equal(rec.day, '2025-01-10');
    assert.equal(rec.lat, 47.2);
    assert.equal(rec.snapshot.velocityKms, 14.0);
    assert.equal(validateRecord(rec), null);
    // below the 0.1 kt floor → dropped
    assert.equal(fireballRecord({ ...row, 'impact-e': '0.05' }, T0), null);
    // southern/western hemispheres negate
    const s = fireballRecord({ ...row, 'lat-dir': 'S', 'lon-dir': 'W' }, T0);
    assert.equal(s.lat, -47.2);
    assert.equal(s.lon, -106.3);
  });

  it('launchRecord and stormRecord apply thresholds', () => {
    const launch = launchRecord(
      {
        id: 'll2-1',
        name: 'Falcon 9 | TestSat',
        net: '2026-09-27T14:00:00Z',
        status: { name: 'Go' },
        launch_service_provider: { name: 'SpaceX' },
        pad: { latitude: 28.5, longitude: -80.6 },
      },
      T0,
    );
    assert.ok(launch);
    assert.equal(launch.kind, 'launch');
    assert.equal(validateRecord(launch), null);
    assert.equal(launchRecord({ name: 'x' }, T0), null); // no date

    const weak = stormRecord({ id: 'al1', name: 'Alfa', lat: 20, lon: -60, windKt: 45 }, T0);
    assert.equal(weak, null); // below 64 kt
    const strong = stormRecord(
      { id: 'al2', name: 'Beta', classification: 'Hurricane', lat: 22, lon: -65, windKt: 100 },
      T0,
    );
    assert.ok(strong);
    assert.equal(strong.severity, 'critical');
    assert.equal(validateRecord(strong), null);
  });
});

describe('runArchiveSweep', () => {
  it('archives significant items, dedupes, isolates source failures', async () => {
    const store = createAkashicStore({ backend: createMemoryBackend() });
    const quakeFeat = {
      id: 'us9',
      geometry: { coordinates: [20, 10, 10] },
      properties: { mag: 6.0, place: 'p', time: T0 },
    };
    const fakeFetch = async (url) => {
      if (url.includes('earthquake.usgs.gov')) return { features: [quakeFeat] };
      if (url === '/api/events') throw new Error('boom'); // per-source failure
      return null; // others: null → counted as errors, sweep continues
    };
    const s1 = await runArchiveSweep(store, { fetchImpl: fakeFetch });
    assert.equal(s1.added, 1);
    assert.equal(store.days().length, 1);
    const s2 = await runArchiveSweep(store, { fetchImpl: fakeFetch });
    assert.equal(s2.added, 0);
    assert.equal(s2.duplicates, 1);
    assert.ok(s2.errors >= 1, 'failed/null sources counted as errors');
  });
});

describe('timeline helpers', () => {
  it('nearestDayIndex finds the closest day', () => {
    const days = ['2026-09-25', '2026-09-26', '2026-09-28'];
    assert.equal(nearestDayIndex(days, '2026-09-27'), 2);
    assert.equal(nearestDayIndex(days, null), 2); // latest
    assert.equal(nearestDayIndex([], '2026-09-27'), -1);
  });

  it('significance thresholds match the brief', () => {
    assert.equal(SIGNIFICANCE.QUAKE_MAG_MIN, 5.5);
  });
});
