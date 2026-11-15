import assert from 'node:assert/strict';
import test from 'node:test';
import { fusionRiverProxy, _fusionRiverInternals } from './fusionRiver.js';

const {
  parseUpstreamPayload,
  parseTrendSeries,
  computeTrend,
  parseRadarIndex,
  classifyAlerts,
  buildFusionRecord,
  clearCaches,
} = _fusionRiverInternals;

const NOW = Date.parse('2026-11-15T08:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// Parsed-shape inputs mirroring the live fetches of 2026-11-15 ~07:58Z:
// gauge 2.94 ft / 1,390 ft^3/s @ 07:30Z; upstream Radford 1,480 @ 07:15Z,
// Allisonia 1,280 / Walker 47.2 / Wolf 48.1 @ 07:30Z; radar frame 07:50Z;
// 3 VA alerts, none for Giles.
function freshInputs() {
  return {
    gauge: {
      gageHeight: {
        name: 'Gage height',
        value: 2.94,
        unit: 'ft',
        time: '2026-11-15T07:30:00.000Z',
        approvalStatus: 'Provisional',
        lastModified: '2026-11-15T07:42:23.602Z',
      },
      discharge: {
        name: 'Streamflow',
        value: 1390,
        unit: 'ft^3/s',
        time: '2026-11-15T07:30:00.000Z',
        approvalStatus: 'Provisional',
        lastModified: '2026-11-15T07:42:19.259Z',
      },
      lat: 37.3728986,
      lon: -80.8606347,
    },
    trendSeries: [
      { time: '2026-11-15T04:30:00.000Z', value: 2.95 },
      { time: '2026-11-15T06:00:00.000Z', value: 2.94 },
      { time: '2026-11-15T07:30:00.000Z', value: 2.94 },
    ],
    upstream: [
      {
        site: '03168000',
        name: 'NEW RIVER AT ALLISONIA, VA',
        role: 'mainstem-upstream',
        dischargeCfs: 1280,
        time: '2026-11-15T07:30:00.000Z',
        approvalStatus: 'Provisional',
      },
      {
        site: '03171000',
        name: 'NEW RIVER AT RADFORD, VA',
        role: 'mainstem-upstream',
        dischargeCfs: 1480,
        time: '2026-11-15T07:15:00.000Z',
        approvalStatus: 'Provisional',
      },
      {
        site: '03173000',
        name: 'WALKER CREEK AT BANE, VA',
        role: 'tributary-upstream',
        dischargeCfs: 47.2,
        time: '2026-11-15T07:30:00.000Z',
        approvalStatus: 'Provisional',
      },
      {
        site: '03175500',
        name: 'WOLF CREEK NEAR NARROWS, VA',
        role: 'tributary-upstream',
        dischargeCfs: 48.1,
        time: '2026-11-15T07:30:00.000Z',
        approvalStatus: 'Provisional',
      },
    ],
    radar: { latestFrameTime: '2026-11-15T07:50:00.000Z', frameCount: 13 },
    alerts: {
      virginiaActiveCount: 3,
      gilesFloodAlertActive: false,
      gilesAlerts: [],
    },
    alertsFetchedAt: '2026-11-15T08:00:00.000Z',
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

test('fusionRiverProxy mounts /api/fusion-river on both server shapes', () => {
  const routes = mount(fusionRiverProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/fusion-river', '/api/fusion-river']);
});

test('full fresh house: NORMAL verdict, weakest-link confidence, SNOTEL excluded by name', () => {
  const rec = buildFusionRecord(freshInputs(), NOW);
  assert.equal(rec.stack, 'S6 RIVER');
  assert.equal(rec.verdict.condition, 'NORMAL');
  assert.equal(rec.verdict.stageFt, 2.94);
  assert.equal(rec.verdict.dischargeCfs, 1390);
  assert.equal(rec.verdict.dataTime, '2026-11-15T07:30:00.000Z');
  assert.equal(rec.verdict.stale, false);
  assert.equal(rec.verdict.trend.direction, 'STEADY');
  // Weakest load-bearing leg is the radar (Modeled) — the fused label
  // inherits it; the anchor keeps Measured on its own line.
  assert.equal(rec.confidence.fused, 'Modeled');
  assert.equal(rec.confidence.atAnchor, 'Measured');
  assert.equal(rec.confidence.weakestLink, 'rain-radar');
  assert.equal(rec.weakestLink, 'rain-radar');
  assert.deepEqual(rec.confidence.degradedBecause, []);
  assert.deepEqual(rec.disagreements, []);
  assert.equal(rec.corroborations.length, 1);
  assert.equal(rec.corroborations[0].kind, 'ALERT_GAUGE_AGREEMENT');
  assert.equal(rec.legsExcluded.length, 1);
  assert.equal(rec.legsExcluded[0].id, 'snowpack-snotel');
  assert.match(rec.legsExcluded[0].reason, /zero SNOTEL stations/);
  const gauge = rec.legs.find((l) => l.id === 'gauge');
  assert.equal(gauge.ageSeconds, 1800);
  assert.equal(gauge.values.approvalStatus, 'Provisional');
  assert.equal(rec.degraded, false);
});

test('STALE PATH: a 2 h-old gauge reading degrades the verdict and is named', () => {
  const inputs = freshInputs();
  const old = iso(NOW - 2 * 3600_000);
  inputs.gauge.gageHeight.time = old;
  inputs.gauge.discharge.time = old;
  const rec = buildFusionRecord(inputs, NOW);
  const gauge = rec.legs.find((l) => l.id === 'gauge');
  assert.equal(gauge.status, 'stale');
  assert.equal(gauge.ageSeconds, 7200);
  assert.equal(rec.verdict.stale, true);
  // The value is still the gauge's own — labeled, never replaced.
  assert.equal(rec.verdict.stageFt, 2.94);
  assert.equal(rec.confidence.fused, 'Estimated');
  assert.ok(
    rec.confidence.degradedBecause.some((s) => s.startsWith('gauge leg stale')),
    'the stale anchor is named in degradedBecause',
  );
});

test('FALSIFIER: killing the alerts leg degrades confidence and names the leg', () => {
  const inputs = freshInputs();
  inputs.alerts = null;
  const rec = buildFusionRecord(inputs, NOW);
  const alerts = rec.legs.find((l) => l.id === 'alerts');
  assert.equal(alerts.status, 'missing');
  assert.equal(rec.verdict.condition, 'NORMAL'); // the number never moves
  assert.equal(rec.confidence.fused, 'Estimated'); // one step down from Modeled
  assert.ok(
    rec.confidence.degradedBecause.some((s) =>
      s.startsWith('alerts leg missing'),
    ),
  );
  assert.deepEqual(rec.corroborations, []); // no silent claim of agreement
});

test('FALSIFIER: killing the radar leg degrades confidence and names the leg', () => {
  const inputs = freshInputs();
  inputs.radar = null;
  const rec = buildFusionRecord(inputs, NOW);
  const radar = rec.legs.find((l) => l.id === 'rain-radar');
  assert.equal(radar.status, 'missing');
  assert.equal(rec.weakestLink, 'rain-radar');
  assert.ok(
    rec.confidence.degradedBecause.some((s) =>
      s.startsWith('rain-radar leg missing'),
    ),
  );
  // Base rises to Measured without the Modeled leg, minus one named
  // degradation = Modeled. The ladder is mechanical, not vibes.
  assert.equal(rec.confidence.fused, 'Modeled');
});

test('threshold grammar: CAUTION at 13 ft (local rule), FLOOD at 15 ft (NWS)', () => {
  const caution = freshInputs();
  caution.gauge.gageHeight.value = 13.4;
  const recCaution = buildFusionRecord(caution, NOW);
  assert.equal(recCaution.verdict.condition, 'CAUTION');
  assert.equal(
    recCaution.verdict.thresholds.cautionSource.includes('LOCAL RULE'),
    true,
  );
  // A caution gauge with quiet alerts is a drawn disagreement.
  assert.ok(
    recCaution.disagreements.some((d) => d.kind === 'GAUGE_AHEAD_OF_ALERTS'),
  );

  const flood = freshInputs();
  flood.gauge.gageHeight.value = 16.2;
  flood.gauge.discharge.value = 45200;
  const recFlood = buildFusionRecord(flood, NOW);
  assert.equal(recFlood.verdict.condition, 'FLOOD');
});

test('disagreement drawn: a Giles flood alert under a calm gauge is the headline', () => {
  const inputs = freshInputs();
  inputs.alerts = {
    virginiaActiveCount: 4,
    gilesFloodAlertActive: true,
    gilesAlerts: [
      {
        event: 'Flood Warning',
        severity: 'Moderate',
        headline: 'Flood Warning issued for Giles County',
        effective: '2026-11-15T07:00:00.000Z',
        expires: '2026-11-16T07:00:00.000Z',
      },
    ],
  };
  const rec = buildFusionRecord(inputs, NOW);
  assert.equal(rec.verdict.condition, 'NORMAL');
  assert.ok(rec.disagreements.some((d) => d.kind === 'ALERT_AHEAD_OF_GAUGE'));
  assert.deepEqual(rec.corroborations, []);
});

test('disagreement drawn: upstream mainstem carrying a rise in transit (P6)', () => {
  const inputs = freshInputs();
  inputs.upstream = inputs.upstream.map((g) =>
    g.site === '03171000' ? { ...g, dischargeCfs: 2200 } : g,
  );
  const rec = buildFusionRecord(inputs, NOW);
  assert.ok(rec.disagreements.some((d) => d.kind === 'UPSTREAM_LEAD'));
});

test('upstream leg degrades by name when a named gage is absent', () => {
  const inputs = freshInputs();
  inputs.upstream = inputs.upstream.map((g) =>
    g.site === '03175500' ? { ...g, dischargeCfs: null, time: null } : g,
  );
  const rec = buildFusionRecord(inputs, NOW);
  const upstream = rec.legs.find((l) => l.id === 'upstream');
  assert.equal(upstream.status, 'degraded');
  assert.ok(
    rec.confidence.degradedBecause.some((s) =>
      s.startsWith('upstream leg degraded'),
    ),
  );
});

test('no anchor, no verdict: a missing gauge yields verdict null, never a fabrication', () => {
  const inputs = freshInputs();
  inputs.gauge = null;
  const rec = buildFusionRecord(inputs, NOW);
  assert.equal(rec.verdict, null);
  assert.equal(rec.confidence.fused, null);
  assert.equal(rec.weakestLink, 'gauge');
  assert.equal(rec.degraded, true);
});

test('trend: rising series reads RISING with its delta; a missing series is UNKNOWN with a reason', () => {
  const rising = [
    { time: '2026-11-15T04:30:00.000Z', value: 2.8 },
    { time: '2026-11-15T06:00:00.000Z', value: 2.95 },
    { time: '2026-11-15T07:30:00.000Z', value: 3.1 },
  ];
  const t = computeTrend(rising);
  assert.equal(t.direction, 'RISING');
  assert.equal(t.deltaFt, 0.3);
  assert.equal(t.overHours, 3);
  const unknown = computeTrend(null);
  assert.equal(unknown.direction, 'UNKNOWN');
  assert.ok(unknown.reason);
});

test('parsers: WDFN upstream payload maps stations by monitoring_location_id', () => {
  const payload = {
    type: 'FeatureCollection',
    features: [
      {
        properties: {
          monitoring_location_id: 'USGS-03175500',
          parameter_code: '00060',
          value: '48.1',
          unit_of_measure: 'ft^3/s',
          time: '2026-11-15T07:30:00+00:00',
          approval_status: 'Provisional',
        },
      },
    ],
  };
  const gages = parseUpstreamPayload(payload);
  const wolf = gages.find((g) => g.site === '03175500');
  assert.equal(wolf.dischargeCfs, 48.1);
  assert.equal(wolf.time, '2026-11-15T07:30:00.000Z');
  const radford = gages.find((g) => g.site === '03171000');
  assert.equal(radford.dischargeCfs, null); // absent stays absent, never invented
});

test('parsers: RainViewer index yields the latest past frame; alerts classify Giles flood state', () => {
  const radar = parseRadarIndex({
    radar: { past: [{ time: 1794727800 }, { time: 1794729000 }], nowcast: [] },
  });
  assert.equal(radar.latestFrameTime, '2026-11-15T07:50:00.000Z');
  assert.equal(radar.frameCount, 2);
  const facts = classifyAlerts([
    {
      event: 'Frost Advisory',
      headline: 'h',
      severity: 'Minor',
      area: 'Giles; Mercer',
    },
    {
      event: 'Flood Warning',
      headline: 'h2',
      severity: 'Moderate',
      area: 'Giles',
    },
    {
      event: 'Freeze Warning',
      headline: 'h3',
      severity: 'Severe',
      area: 'Gates; Bertie',
    },
  ]);
  assert.equal(facts.virginiaActiveCount, 3);
  assert.equal(facts.gilesFloodAlertActive, true);
  assert.equal(facts.gilesAlerts.length, 2);
});

test('parsers: trend series sorts and filters to gage height', () => {
  const series = parseTrendSeries({
    features: [
      {
        properties: {
          parameter_code: '00065',
          value: '2.94',
          time: '2026-11-15T07:30:00+00:00',
        },
      },
      {
        properties: {
          parameter_code: '00060',
          value: '1390',
          time: '2026-11-15T07:30:00+00:00',
        },
      },
      {
        properties: {
          parameter_code: '00065',
          value: '2.95',
          time: '2026-11-15T04:00:00+00:00',
        },
      },
    ],
  });
  assert.equal(series.length, 2);
  assert.equal(series[0].value, 2.95);
  assert.equal(series[1].value, 2.94);
});

// ——— Handler assembly over stubbed upstreams ———

const GAUGE_GEOJSON = {
  type: 'FeatureCollection',
  features: [
    {
      properties: {
        parameter_code: '00065',
        time: '2026-11-15T07:30:00+00:00',
        value: '2.94',
        unit_of_measure: 'ft',
        approval_status: 'Provisional',
        last_modified: '2026-11-15T07:42:23.602+00:00',
      },
      geometry: { type: 'Point', coordinates: [-80.8606347, 37.3728986] },
    },
    {
      properties: {
        parameter_code: '00060',
        time: '2026-11-15T07:30:00+00:00',
        value: '1390',
        unit_of_measure: 'ft^3/s',
        approval_status: 'Provisional',
        last_modified: '2026-11-15T07:42:19.259+00:00',
      },
      geometry: { type: 'Point', coordinates: [-80.8606347, 37.3728986] },
    },
  ],
};

function stubFetch({ failGauge = false } = {}) {
  return async (url) => {
    const u = String(url);
    const body = (obj) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode(JSON.stringify(obj)).buffer,
    });
    if (u.includes('latest-continuous') && u.includes('03176500')) {
      if (failGauge) throw new Error('network down');
      return body(GAUGE_GEOJSON);
    }
    if (u.includes('latest-continuous'))
      return body({ type: 'FeatureCollection', features: [] });
    if (u.includes('collections/continuous'))
      return body({ type: 'FeatureCollection', features: [] });
    if (u.includes('api.weather.gov')) return body({ features: [] });
    if (u.includes('rainviewer'))
      return body({ radar: { past: [{ time: 1794729000 }] } });
    throw new Error(`unstubbed url ${u}`);
  };
}

test('handler: assembles the record from live-shaped upstreams', async () => {
  clearCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch();
  try {
    const [{ handler }] = mount(fusionRiverProxy());
    const res = fakeRes();
    await handler({ method: 'GET', url: '/api/fusion-river' }, res);
    assert.equal(res.statusCode, 200);
    const rec = JSON.parse(res.body);
    assert.equal(rec.verdict.condition, 'NORMAL');
    assert.equal(rec.verdict.stageFt, 2.94);
    assert.equal(rec.verdict.dischargeCfs, 1390);
  } finally {
    globalThis.fetch = originalFetch;
    clearCaches();
  }
});

test('handler: anchor down with no cached round answers an honest 502', async () => {
  clearCaches();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch({ failGauge: true });
  try {
    const [{ handler }] = mount(fusionRiverProxy());
    const res = fakeRes();
    await handler({ method: 'GET', url: '/api/fusion-river' }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'fusion_river_unavailable');
  } finally {
    globalThis.fetch = originalFetch;
    clearCaches();
  }
});
