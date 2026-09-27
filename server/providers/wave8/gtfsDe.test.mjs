import assert from 'node:assert/strict';
import test from 'node:test';
import { gtfsDeProxy, _gtfsDeInternals } from './gtfsDe.js';

const {
  SNAPSHOT_URL,
  buildGtfsDeSnapshot,
  validateGtfsDeSnapshot,
  clearCaches,
} = _gtfsDeInternals;

// ——— fixtures ———

function fixtureDecoded() {
  return {
    feedTimestamp: '2026-09-27T21:40:00.000Z',
    entities: [
      {
        id: 'e1',
        isDeleted: false,
        tripUpdate: {
          trip: { tripId: 't1', routeId: 'RE1', startDate: '20260927' },
          delay: 600,
          stopTimeUpdates: [
            {
              stopId: 's1',
              stopSequence: 1,
              arrivalDelay: 300,
              departureDelay: 600,
            },
            {
              stopId: 's2',
              stopSequence: 2,
              arrivalDelay: 900,
              departureDelay: null,
            },
          ],
        },
      },
      {
        id: 'e2',
        isDeleted: false,
        tripUpdate: {
          trip: { tripId: 't2', routeId: 'S2', startDate: '20260927' },
          delay: null,
          stopTimeUpdates: [
            {
              stopId: 's3',
              stopSequence: 1,
              arrivalDelay: 120,
              departureDelay: 120,
            },
          ],
        },
      },
      {
        id: 'e3',
        isDeleted: false,
        tripUpdate: {
          trip: { tripId: 't3', routeId: 'RB3', startDate: '20260927' },
          delay: 0,
          stopTimeUpdates: [],
        },
      },
      { id: 'e4', isDeleted: true },
      {
        id: 'a1',
        isDeleted: false,
        alert: {
          header: 'Bauarbeiten',
          description: 'Gleis gesperrt',
          cause: 10,
          effect: 3,
          routes: ['RE1'],
          agencyIds: ['db'],
        },
      },
    ],
  };
}

function fixtureSnapshot(opts) {
  return buildGtfsDeSnapshot(fixtureDecoded(), {
    fetchedAt: '2026-09-27T21:45:00.000Z',
    ...opts,
  });
}

function snapshotResponse(snap) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(snap),
  };
}

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body) {
      chunks.push(body);
      res.body = chunks.join('');
    },
    once() {},
    removeListener() {},
  };
  return res;
}

function mount(provider) {
  const calls = [];
  provider.configureServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  provider.configurePreviewServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  return calls;
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

// ——— build unit tests ———

test('buildGtfsDeSnapshot extracts delays, alerts, and counts', () => {
  const snap = fixtureSnapshot();
  assert.equal(snap.format, 'gtfs-de-snapshot');
  assert.equal(snap.formatVersion, 1);
  assert.equal(snap.feedTimestamp, '2026-09-27T21:40:00.000Z');
  assert.deepEqual(snap.counts, {
    entities: 5,
    tripUpdates: 3,
    alerts: 1,
    deleted: 1,
  });
  // t1's worst delay is the 900 s arrival at s2; t3 (delay 0) is excluded.
  assert.deepEqual(
    snap.topDelayed.map((t) => [t.tripId, t.delaySec, t.worstStopId]),
    [
      ['t1', 900, 's2'],
      ['t2', 120, 's3'],
    ],
  );
  assert.equal(snap.topDelayed[0].routeId, 'RE1');
  assert.equal(snap.alerts.length, 1);
  assert.deepEqual(snap.alerts[0], {
    id: 'a1',
    header: 'Bauarbeiten',
    description: 'Gleis gesperrt',
    cause: 10,
    causeLabel: 'CONSTRUCTION',
    effect: 3,
    effectLabel: 'SIGNIFICANT_DELAYS',
    routes: ['RE1'],
    agencyIds: ['db'],
  });
  assert.ok(validateGtfsDeSnapshot(snap));
});

test('buildGtfsDeSnapshot honors topN and maxAlerts caps', () => {
  const snap = fixtureSnapshot({ topN: 1, maxAlerts: 0 });
  assert.equal(snap.topDelayed.length, 1);
  assert.equal(snap.topDelayed[0].tripId, 't1');
  assert.equal(snap.alerts.length, 0);
});

test('buildGtfsDeSnapshot rejects a feed without a timestamp', () => {
  assert.throws(
    () =>
      buildGtfsDeSnapshot(
        { feedTimestamp: null, entities: [] },
        { fetchedAt: new Date().toISOString() },
      ),
    /bad feedTimestamp/,
  );
});

// ——— validate unit tests ———

test('validateGtfsDeSnapshot rejects malformed snapshots', () => {
  assert.throws(() => validateGtfsDeSnapshot({}), /bad format marker/);
  const snap = fixtureSnapshot();
  const unsorted = JSON.parse(JSON.stringify(snap));
  unsorted.topDelayed.reverse();
  assert.throws(() => validateGtfsDeSnapshot(unsorted), /not sorted desc/);
  const badCause = JSON.parse(JSON.stringify(snap));
  badCause.alerts[0].cause = 99;
  assert.throws(() => validateGtfsDeSnapshot(badCause), /unknown cause 99/);
  const badCounts = JSON.parse(JSON.stringify(snap));
  badCounts.counts.tripUpdates = 99;
  assert.throws(() => validateGtfsDeSnapshot(badCounts), /bad counts/);
  const badDelay = JSON.parse(JSON.stringify(snap));
  badDelay.topDelayed[0].delaySec = -5;
  assert.throws(() => validateGtfsDeSnapshot(badDelay), /bad delaySec/);
});

// ——— handler tests ———

test('handler mounts /api/gtfs-de and serves the snapshot (redirect:follow)', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return snapshotResponse(snap);
  };
  const provider = gtfsDeProxy({
    fetchImpl,
    now: () => Date.parse('2026-09-27T21:50:00Z'),
  });
  const calls = mount(provider);
  assert.deepEqual(
    calls.map((c) => c.route),
    ['/api/gtfs-de', '/api/gtfs-de'],
  );
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gtfs-de' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, false);
  assert.equal(body.counts.tripUpdates, 3);
  assert.equal(body.topDelayed[0].tripId, 't1');
  assert.equal(body.alerts[0].causeLabel, 'CONSTRUCTION');
  assert.ok(body.attribution.includes('TripUpdates + Alerts only'));
  assert.equal(seen[0].url, SNAPSHOT_URL);
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
});

test('handler 405s on non-GET', async () => {
  clearCaches();
  const provider = gtfsDeProxy({
    fetchImpl: async () => snapshotResponse(fixtureSnapshot()),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/gtfs-de' }, res);
  assert.equal(res.statusCode, 405);
});

test('handler 502s honestly when the snapshot is unreachable (no cache)', async () => {
  clearCaches();
  const provider = gtfsDeProxy({
    fetchImpl: async () => {
      throw abortError();
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gtfs-de' }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'gtfs_de_unavailable');
});

test('handler 502s on a corrupt snapshot asset', async () => {
  clearCaches();
  const provider = gtfsDeProxy({
    fetchImpl: async () => snapshotResponse({ format: 'nope' }),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/gtfs-de' }, res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).detail, /bad format marker/);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const t0 = Date.parse('2026-09-27T21:50:00Z');
  const good = gtfsDeProxy({
    fetchImpl: async () => snapshotResponse(snap),
    now: () => t0,
  });
  const callsGood = mount(good);
  const res1 = fakeRes();
  await callsGood[0].handler({ method: 'GET', url: '/api/gtfs-de' }, res1);
  assert.equal(res1.statusCode, 200);

  const bad = gtfsDeProxy({
    fetchImpl: async () => {
      throw abortError();
    },
    now: () => t0 + 3600_000, // past the 15 min TTL, inside the 2 h stale window
  });
  const callsBad = mount(bad);
  const res2 = fakeRes();
  await callsBad[0].handler({ method: 'GET', url: '/api/gtfs-de' }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).stale, true);
});
