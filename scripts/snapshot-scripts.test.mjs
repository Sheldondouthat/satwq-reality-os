import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArgs as parseIconArgs,
  publishRelease as publishIconRelease,
} from './icon-d2-snapshot.mjs';
import {
  parseArgs as parseHfArgs,
  parseCatalogForRegion,
  listCatalogFilesForRegion,
  parseDdsDims,
  buildAsciiUrl,
  strideLadder,
  thinPoints,
  publishRelease as publishHfRelease,
} from './hfradar-snapshot.mjs';
import {
  parseArgs as parseGtfsArgs,
  decodeGtfsRtFeed,
  publishRelease as publishGtfsRelease,
} from './gtfs-de-snapshot.mjs';

// ——— icon-d2-snapshot.mjs ———

test('icon-d2 parseArgs: defaults', () => {
  const o = parseIconArgs([]);
  assert.deepEqual(o.horizons, [0, 6, 12, 24]);
  assert.equal(o.binDeg, 0.25);
  assert.equal(o.param, 't_2m');
  assert.equal(o.dryRun, false);
  assert.equal(o.outDir, '/tmp/icon-d2-snap');
});

test('icon-d2 parseArgs: accepts valid overrides', () => {
  const o = parseIconArgs([
    '--run',
    '21',
    '--horizons',
    '0,12,48',
    '--bin-deg',
    '0.5',
    '--param',
    't_2m',
    '--dry-run',
    '--out-dir',
    '/tmp/x',
  ]);
  assert.equal(o.run, '21');
  assert.deepEqual(o.horizons, [0, 12, 48]);
  assert.equal(o.binDeg, 0.5);
  assert.equal(o.dryRun, true);
  assert.equal(o.outDir, '/tmp/x');
});

test('icon-d2 parseArgs: rejects garbage', () => {
  assert.throws(() => parseIconArgs(['--bogus']), /unknown argument "--bogus"/);
  assert.throws(
    () => parseIconArgs(['--horizons', '0,abc']),
    /bad horizon "abc"/,
  );
  assert.throws(
    () => parseIconArgs(['--horizons', '0,200']),
    /out of range 0\.\.48/,
  );
  assert.throws(() => parseIconArgs(['--bin-deg', '5']), /0\.05\.\.2/);
  assert.throws(
    () => parseIconArgs(['--bin-deg', 'abc']),
    /0\.05\.\.2, got "abc"/,
  );
  assert.throws(
    () => parseIconArgs(['--param', 'wind']),
    /must be one of t_2m/,
  );
  assert.throws(
    () => parseIconArgs(['--run', '20260926/21']),
    /--run must be HH/,
  );
  assert.throws(() => parseIconArgs(['--horizons']), /missing value/);
});

// ——— hfradar-snapshot.mjs ———

test('hfradar parseArgs: defaults and overrides', () => {
  const d = parseHfArgs([]);
  assert.deepEqual(d.regions, ['rtv-usegc-6km-uwls', 'rtv-gak-6km-uwls']);
  assert.equal(d.stride, 2);
  assert.equal(d.dryRun, false);
  const o = parseHfArgs([
    '--regions',
    'rtv-usegc-6km-uwls',
    '--stride',
    '5',
    '--dry-run',
  ]);
  assert.deepEqual(o.regions, ['rtv-usegc-6km-uwls']);
  assert.equal(o.stride, 5);
  assert.equal(o.dryRun, true);
});

test('hfradar parseArgs: rejects unknown regions and bad strides', () => {
  assert.throws(
    () => parseHfArgs(['--regions', 'rtv-nowhere-1km-uwls']),
    /unknown region/,
  );
  assert.throws(() => parseHfArgs(['--stride', '0']), /1\.\.100/);
  assert.throws(() => parseHfArgs(['--stride', 'abc']), /integer/);
  assert.throws(() => parseHfArgs(['--retries', '0']), /1\.\.10/);
  assert.throws(() => parseHfArgs(['--retries', '11']), /1\.\.10/);
  assert.throws(() => parseHfArgs(['--nope']), /unknown argument/);
});

test('hfradar parseArgs: --retries and --max-lookback defaults and overrides', () => {
  assert.equal(parseHfArgs([]).retries, 5);
  assert.equal(parseHfArgs(['--retries', '3']).retries, 3);
  assert.equal(parseHfArgs([]).maxLookback, 6);
  assert.equal(parseHfArgs(['--max-lookback', '12']).maxLookback, 12);
  assert.throws(() => parseHfArgs(['--max-lookback', '0']), /1\.\.24/);
  assert.throws(() => parseHfArgs(['--max-lookback', '25']), /1\.\.24/);
});

test('hfradar listCatalogFilesForRegion: newest-first ordering', () => {
  const xml = `<catalog>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc"/>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc"/>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609271900000_e202609271900000_c202609272000111.nc"/>
<dataset urlPath="hfradar/rtv-gak-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc"/>
</catalog>`;
  const files = listCatalogFilesForRegion(xml, 'rtv-usegc-6km-uwls').map(
    (e) => e.file,
  );
  assert.deepEqual(files, [
    'rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc',
    'rtv-usegc-6km-uwls_v1r0_hfr_s202609271900000_e202609271900000_c202609272000111.nc',
    'rtv-usegc-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc',
  ]);
  assert.deepEqual(listCatalogFilesForRegion(xml, 'rtv-ushi-2km-uwls'), []);
});

test('hfradar strideLadder: halves down to 1, deduplicated', () => {
  assert.deepEqual(strideLadder(4), [4, 2, 1]);
  assert.deepEqual(strideLadder(20), [20, 10, 5, 3, 2, 1]);
  assert.deepEqual(strideLadder(1), [1]);
  assert.deepEqual(strideLadder(3), [3, 2, 1]);
});

test('hfradar thinPoints: deterministic decimation cap', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = a.map((x) => x * 10);
  const [ta, tb] = thinPoints([a, b], 4);
  assert.deepEqual(ta, [1, 4, 7, 10]);
  assert.deepEqual(tb, [10, 40, 70, 100]);
  // no-op when under the cap (same arrays returned)
  const under = thinPoints([a, b], 10);
  assert.equal(under[0], a);
  assert.equal(under[1], b);
});

test('hfradar parseCatalogForRegion: picks the newest by timestamp, not catalog order', () => {
  const xml = `<catalog>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc"/>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc"/>
<dataset urlPath="hfradar/rtv-gak-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc"/>
</catalog>`;
  assert.equal(
    parseCatalogForRegion(xml, 'rtv-usegc-6km-uwls'),
    'rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc',
  );
  assert.equal(
    parseCatalogForRegion(xml, 'rtv-gak-6km-uwls'),
    'rtv-gak-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc',
  );
  assert.equal(parseCatalogForRegion(xml, 'rtv-ushi-2km-uwls'), null);
  // Newest-first catalog order: timestamp still wins over position.
  const reversed = `<catalog>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc"/>
<dataset urlPath="hfradar/rtv-usegc-6km-uwls_v1r0_hfr_s202609271800000_e202609271800000_c202609271901000.nc"/>
</catalog>`;
  assert.equal(
    parseCatalogForRegion(reversed, 'rtv-usegc-6km-uwls'),
    'rtv-usegc-6km-uwls_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc',
  );
});

test('hfradar parseDdsDims + buildAsciiUrl: subset query is well-formed', () => {
  const dims = parseDdsDims(`Dataset {
    Float32 lat[lat = 460];
    Float32 lon[lon = 701];
    Int16 u[time = 1][lat = 460][lon = 701];
} ;`);
  assert.deepEqual(dims, { latN: 460, lonM: 701 });
  assert.throws(() => parseDdsDims('Dataset { };'), /missing lat\/lon/);
  const url = buildAsciiUrl('rtv-x.nc', dims, 20);
  assert.ok(url.includes('u[0:1:0][0:20:459][0:20:700]'));
  assert.ok(url.includes('v[0:1:0][0:20:459][0:20:700]'));
  assert.ok(url.includes('lat[0:20:459],lon[0:20:700],time[0:1:0]'));
  assert.ok(
    url.startsWith(
      'https://dods.ndbc.noaa.gov/thredds/dodsC/hfradar/rtv-x.nc.ascii?',
    ),
  );
});

// ——— gtfs-de-snapshot.mjs ———

test('gtfs-de parseArgs: defaults, overrides, and strict rejection', () => {
  const d = parseGtfsArgs([]);
  assert.equal(d.topDelayed, 100);
  assert.equal(d.maxAlerts, 50);
  assert.equal(d.retries, 5);
  assert.equal(d.dryRun, false);
  const o = parseGtfsArgs([
    '--top-delayed',
    '50',
    '--max-alerts',
    '10',
    '--retries',
    '2',
    '--dry-run',
  ]);
  assert.equal(o.topDelayed, 50);
  assert.equal(o.maxAlerts, 10);
  assert.equal(o.retries, 2);
  assert.equal(o.dryRun, true);
  assert.throws(() => parseGtfsArgs(['--top-delayed', '0']), /1\.\.1000/);
  assert.throws(() => parseGtfsArgs(['--max-alerts', '501']), /1\.\.500/);
  assert.throws(() => parseGtfsArgs(['--retries', '11']), /1\.\.10/);
  assert.throws(() => parseGtfsArgs(['--top-delayed', '1.5']), /integer/);
  assert.throws(() => parseGtfsArgs(['--what']), /unknown argument/);
});

// ——— GTFS-RT decoder: build a real protobuf with pbf and decode it ———

import { PbfReader, PbfWriter } from 'pbf';

/** Encode a minimal GTFS-RT feed: 1 trip update + 1 alert, via pbf's writer.
 * Field numbers are per the OFFICIAL gtfs-realtime.proto (NOT the
 * implementation's map — a fixture that mirrors the decoder's own numbering
 * reproduces schema mistakes instead of catching them):
 * TripDescriptor: 1 trip_id, 3 start_date, 5 route_id;
 * StopTimeUpdate: 1 stop_sequence, 2 arrival, 3 departure, 4 stop_id,
 *   5 schedule_relationship (varint — must not be read as a message);
 * StopTimeEvent: 1 delay (int32, signed — negative = ahead of schedule).
 */
function encodeFixtureFeed() {
  const pbf = new PbfWriter();
  const writeTranslatedString = (field, text) => {
    pbf.writeMessage(field, () => {
      pbf.writeMessage(1, () => {
        pbf.writeStringField(1, text);
        pbf.writeStringField(2, 'de');
      });
    });
  };
  const writeStopTimeEvent = (field, delay) => {
    pbf.writeMessage(field, () => pbf.writeVarintField(1, delay));
  };
  // FeedHeader (field 1): version + timestamp
  pbf.writeMessage(1, () => {
    pbf.writeStringField(1, '2.0');
    pbf.writeVarintField(3, 1790000000);
  });
  // FeedEntity 1: trip update (field 3)
  pbf.writeMessage(2, () => {
    pbf.writeStringField(1, 'tu-1');
    pbf.writeMessage(3, () => {
      pbf.writeMessage(1, () => {
        pbf.writeStringField(1, 'trip-9');
        pbf.writeStringField(3, '20260927'); // start_date = 3
        pbf.writeStringField(5, 'RE9'); // route_id = 5
      });
      pbf.writeMessage(2, () => {
        pbf.writeVarintField(1, 4);
        writeStopTimeEvent(2, 420); // arrival = 2
        writeStopTimeEvent(3, -90); // departure = 3, negative delay
        pbf.writeStringField(4, 'stop-A'); // stop_id = 4
        pbf.writeVarintField(5, 0); // schedule_relationship = 5 (varint)
      });
      pbf.writeVarintField(5, -45); // trip delay = 5, negative (int32)
    });
  });
  // FeedEntity 2: alert (field 5)
  pbf.writeMessage(2, () => {
    pbf.writeStringField(1, 'alert-1');
    pbf.writeMessage(5, () => {
      pbf.writeVarintField(6, 10); // CONSTRUCTION
      pbf.writeVarintField(7, 3); // SIGNIFICANT_DELAYS
      writeTranslatedString(10, 'Bauarbeiten');
      writeTranslatedString(11, 'Gleis gesperrt');
      pbf.writeMessage(5, () => pbf.writeStringField(2, 'RE9'));
    });
  });
  return pbf.finish();
}

test('gtfs-de decodeGtfsRtFeed: round-trips a real protobuf (official field numbers)', () => {
  const decoded = decodeGtfsRtFeed(encodeFixtureFeed());
  assert.equal(
    decoded.feedTimestamp,
    new Date(1790000000 * 1000).toISOString(),
  );
  assert.equal(decoded.entities.length, 2);
  const tu = decoded.entities[0].tripUpdate;
  assert.equal(tu.trip.tripId, 'trip-9');
  assert.equal(tu.trip.routeId, 'RE9');
  assert.equal(tu.trip.startDate, '20260927');
  assert.equal(tu.delay, -45); // signed int32 trip delay
  assert.deepEqual(tu.stopTimeUpdates, [
    {
      stopId: 'stop-A',
      stopSequence: 4,
      arrivalDelay: 420,
      departureDelay: -90, // negative delay decodes, not a huge varint
    },
  ]);
  const alert = decoded.entities[1].alert;
  assert.equal(alert.header, 'Bauarbeiten');
  assert.equal(alert.description, 'Gleis gesperrt');
  assert.equal(alert.cause, 10);
  assert.equal(alert.effect, 3);
  assert.deepEqual(alert.routes, ['RE9']);
});

test('gtfs-de decodeGtfsRtFeed: rejects a feed without a header timestamp', () => {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, () => pbf.writeStringField(1, '2.0'));
  assert.throws(() => decodeGtfsRtFeed(pbf.finish()), /no usable timestamp/);
});

test('gtfs-de decodeGtfsRtFeed: drops oversize strings', () => {
  const pbf = new PbfWriter();
  pbf.writeMessage(1, () => {
    pbf.writeStringField(1, '2.0');
    pbf.writeVarintField(3, 1790000000);
  });
  pbf.writeMessage(2, () => {
    pbf.writeStringField(1, 'x'.repeat(300)); // oversize entity id
    pbf.writeMessage(3, () => {
      pbf.writeMessage(1, () => pbf.writeStringField(1, 'trip-1'));
    });
  });
  const decoded = decodeGtfsRtFeed(pbf.finish());
  assert.equal(decoded.entities.length, 0);
});

// ——— publishRelease dry-run regression: a dry run must never invoke gh ———
// Each snapshot script exposes publishRelease({snapPath, metaPath, dryRun,
// runGh}); production main() omits runGh so the real gh runs, but tests
// inject a recording stub. These tests prove --dry-run cannot touch the
// release for all three pipelines, and that a live run does call gh.

function dryRunNeverCallsGh(label, publishRelease) {
  test(`${label} publishRelease: dry-run never invokes gh`, () => {
    const calls = [];
    const runGh = (...args) => {
      calls.push(args);
      return '';
    };
    const out = publishRelease({
      snapPath: '/tmp/x-latest.json',
      metaPath: '/tmp/x-meta.json',
      dryRun: true,
      runGh,
    });
    assert.equal(calls.length, 0);
    assert.equal(out.published, false);
  });

  test(`${label} publishRelease: live run invokes gh (view + upload)`, () => {
    const calls = [];
    const runGh = (...args) => {
      calls.push(args);
      return '';
    };
    const out = publishRelease({
      snapPath: '/tmp/x-latest.json',
      metaPath: '/tmp/x-meta.json',
      dryRun: false,
      runGh,
    });
    assert.equal(out.published, true);
    assert.deepEqual(
      calls.map((c) => c.slice(0, 2)),
      [
        ['release', 'view'],
        ['release', 'upload'],
      ],
    );
  });

  test(`${label} publishRelease: creates the release when view fails`, () => {
    const calls = [];
    const runGh = (...args) => {
      calls.push(args);
      if (args[1] === 'view') throw new Error('not found');
      return '';
    };
    const out = publishRelease({
      snapPath: '/tmp/x-latest.json',
      metaPath: '/tmp/x-meta.json',
      dryRun: false,
      runGh,
    });
    assert.equal(out.published, true);
    assert.deepEqual(
      calls.map((c) => c.slice(0, 2)),
      [
        ['release', 'view'],
        ['release', 'create'],
        ['release', 'upload'],
      ],
    );
  });
}

dryRunNeverCallsGh('icon-d2', publishIconRelease);
dryRunNeverCallsGh('hfradar', publishHfRelease);
dryRunNeverCallsGh('gtfs-de', publishGtfsRelease);
