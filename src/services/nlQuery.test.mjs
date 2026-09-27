/**
 * nlQuery.test.mjs — F7 parser + executor tests. Zero network: every
 * dependency is injected (fake geocoder, fake layers, fake camera).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  parseQueryAsync,
  executePlan,
  ruleBasedProvider,
  openAIProvider,
  createLLMProvider,
  resolveLayerId,
  resolveLayerIds,
  LAYER_SYNONYMS,
  HELP_HINT,
} from './nlQuery.js';

/** parseQuery is the ergonomic surface; these all exercise it. */
const parseCases = [
  // [query, expectedIntent, expectedPlanSummary]
  ['show wildfires', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['Show Wildfires', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['show wildfires!', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['display active fires', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['turn on the fire detections', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['hide traffic', 'layer', [{ type: 'layer', layer: 'traffic', op: 'hide' }]],
  ['turn off weather', 'layer', [{ type: 'layer', layer: 'weather', op: 'hide' }]],
  ['toggle satellites', 'layer', [{ type: 'layer', layer: 'satellites', op: 'toggle' }]],
  ['wildfires', 'layer', [{ type: 'layer', layer: 'firms', op: 'show' }]],
  ['show planes', 'layer', [{ type: 'layer', layer: 'flights', op: 'show' }]],
  ['show ships', 'layer', [{ type: 'layer', layer: 'vessels', op: 'show' }]],
  ['show hurricanes', 'layer', [{ type: 'layer', layer: 'cyclones', op: 'show' }]],
  ['show earthquakes and volcanoes', 'layer', [
    { type: 'layer', layer: 'earthquakes', op: 'show' },
    { type: 'layer', layer: 'volcanoes', op: 'show' },
  ]],
  ['hide traffic and weather', 'layer', [
    { type: 'layer', layer: 'traffic', op: 'hide' },
    { type: 'layer', layer: 'weather', op: 'hide' },
  ]],
  ['hide traffic, show wildfires', 'layer', [
    { type: 'layer', layer: 'traffic', op: 'hide' },
    { type: 'layer', layer: 'firms', op: 'show' },
  ]],
  ['hide rain radar', 'layer', [{ type: 'layer', layer: 'rainviewerRadar', op: 'hide' }]],
  ['show northern lights', 'layer', [{ type: 'layer', layer: 'aurora', op: 'show' }]],
  ['show sea surface temperature', 'layer', [{ type: 'layer', layer: 'gibsSst', op: 'show' }]],
  ['show night lights', 'layer', [{ type: 'layer', layer: 'gibsNightlights', op: 'show' }]],
  ['show 3d buildings', 'layer', [{ type: 'layer', layer: 'osmBuildings3d', op: 'show' }]],
  ['show submarine cables', 'layer', [{ type: 'layer', layer: 'submarineCables', op: 'show' }]],
  ['show bike share', 'layer', [{ type: 'layer', layer: 'bikeshare', op: 'show' }]],
  ['show license plate readers', 'layer', [{ type: 'layer', layer: 'alpr', op: 'show' }]],
  ['fly to Tokyo', 'fly', [{ type: 'fly', place: 'tokyo' }]],
  ['go to Paris', 'fly', [{ type: 'fly', place: 'paris' }]],
  ['take me to the Grand Canyon', 'fly', [{ type: 'fly', place: 'the grand canyon' }]],
  ['where is Mount Everest', 'fly', [{ type: 'fly', place: 'mount everest' }]],
  ['show me Tokyo', 'fly', [{ type: 'fly', place: 'tokyo' }]],
  ['zoom in', 'zoom', [{ type: 'zoom', direction: 'in' }]],
  ['zoom out', 'zoom', [{ type: 'zoom', direction: 'out' }]],
  ['start tour', 'tour', [{ type: 'tour', op: 'start' }]],
  ['start the tour', 'tour', [{ type: 'tour', op: 'start' }]],
  ['stop tour', 'tour', [{ type: 'tour', op: 'stop' }]],
  ['brief me', 'brief', [{ type: 'brief' }]],
  ['give me the daily brief', 'brief', [{ type: 'brief' }]],
  ["what's happening", 'brief', [{ type: 'brief' }]],
  ['mute', 'mute', [{ type: 'mute', muted: true }]],
  ['unmute', 'unmute', [{ type: 'mute', muted: false }]],
  ['help', 'help', null], // plan is a say step; asserted separately
  ['', 'unknown', null],
  ['blorp florp', 'unknown', null],
];

test('parseQuery: 25+ cases across every intent', () => {
  assert.ok(parseCases.length >= 25, `need 25+ cases, have ${parseCases.length}`);
  for (const [query, intent, plan] of parseCases) {
    const result = parseQuery(query);
    assert.equal(result.intent, intent, `intent for ${JSON.stringify(query)}`);
    assert.equal(result.provider, 'rule-based');
    if (plan) assert.deepEqual(result.plan, plan, `plan for ${JSON.stringify(query)}`);
    else assert.ok(result.plan.length >= 1, `non-empty plan for ${JSON.stringify(query)}`);
  }
});

test('unknown queries get the helpful hint, never a crash', () => {
  for (const q of ['', '   ', 'blorp florp zzz', '!!!']) {
    const { intent, plan } = parseQuery(q);
    assert.equal(intent, 'unknown');
    assert.equal(plan[0].type, 'say');
    assert.ok(plan[0].text.includes("show wildfires"));
    assert.ok(plan[0].text.includes('fly to Tokyo'));
  }
  assert.ok(HELP_HINT.includes("show wildfires"));
});

test('resolveLayerId covers every src/layers/* id', () => {
  const expected = [
    'aircraft', 'alpr', 'aurora', 'awareness', 'bikeshare', 'buoys', 'cctv',
    'cyclones', 'directions', 'earthquakes', 'firms', 'flights',
    'gibsChlorophyll', 'gibsNightlights', 'gibsSst', 'gibsTruecolor',
    'hmsSmoke', 'imageryTile', 'installations', 'launches', 'localAdsb',
    'meteors', 'military', 'moon', 'osmBuildings3d', 'perimeters', 'radio',
    'rainviewerRadar', 'rainviewerSatellite', 'recentImagery', 'satellites',
    'spaceWeather', 'submarineCables', 'terminator', 'tides', 'traffic',
    'transit', 'vessels', 'volcanoes', 'weather', 'wind',
  ];
  const synonymIds = Object.keys(LAYER_SYNONYMS).sort();
  assert.deepEqual(synonymIds, expected.sort());
  for (const id of expected) {
    assert.ok(
      LAYER_SYNONYMS[id].length >= 1,
      `layer ${id} needs at least one synonym`,
    );
  }
});

test('synonym spot checks: wildfires→firms, planes→flights', () => {
  assert.equal(resolveLayerId('wildfires are spreading'), 'firms');
  assert.equal(resolveLayerId('show me the planes'), 'flights');
  assert.equal(resolveLayerId('show the adsb layer'), 'localAdsb');
  assert.equal(resolveLayerId('local adsb'), 'localAdsb');
  assert.equal(resolveLayerId('show traffic'), 'traffic');
  assert.equal(resolveLayerId('northern lights tonight'), 'aurora');
  assert.equal(resolveLayerId('day night line'), 'terminator');
  assert.equal(resolveLayerId('sea surface temperature'), 'gibsSst');
});

test('layer verb disambiguation: toggle/hide beat show', () => {
  assert.equal(parseQuery('toggle the wildfire layer').plan[0].op, 'toggle');
  assert.equal(parseQuery('hide wildfires').plan[0].op, 'hide');
  assert.equal(parseQuery('show wildfires').plan[0].op, 'show');
});

test('mute wins over the mute-substring in unmute', () => {
  assert.equal(parseQuery('unmute').intent, 'unmute');
  assert.equal(parseQuery('please unmute the briefing').intent, 'unmute');
  assert.equal(parseQuery('mute the narration').intent, 'mute');
});

test('createLLMProvider defaults to rule-based; openAI is inert without a key', async () => {
  const def = createLLMProvider();
  assert.equal(def.name, 'rule-based');
  assert.equal(def.keyless, true);

  const inert = openAIProvider();
  assert.equal(inert.keyless, false);
  const degraded = await parseQueryAsync('show wildfires', { provider: inert });
  assert.equal(degraded.provider, 'openai');
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.plan[0].type, 'say');

  const named = createLLMProvider({ name: 'openai' });
  assert.equal(named.name, 'openai');
});

test('parseQuery rejects async providers with a clear error', () => {
  assert.throws(
    () => parseQuery('hi', { provider: openAIProvider({ apiKey: 'x' }) }),
    /parseQueryAsync/,
  );
});

/** Fake deps: layers record calls, camera records flights, geocoder is canned. */
function makeDeps() {
  const calls = [];
  const layers = {};
  for (const id of ['firms', 'traffic', 'weather']) {
    layers[id] = {
      show: async () => calls.push(`${id}.show`),
      hide: async () => calls.push(`${id}.hide`),
      toggle: async () => calls.push(`${id}.toggle`),
    };
  }
  const camera = {
    flights: [],
    async flyTo(view) {
      this.flights.push(view);
    },
  };
  const said = [];
  return {
    calls,
    said,
    deps: {
      layers,
      camera,
      geocoder: async (q) =>
        q === 'tokyo'
          ? { place: { lat: 35.68, lng: 139.69, label: 'Tokyo, Japan', types: ['locality'] } }
          : null,
      tour: {
        start: () => calls.push('tour.start') ?? true,
        stop: () => calls.push('tour.stop') ?? true,
      },
      briefing: {
        run: async () => calls.push('briefing.run'),
        setMuted: (m) => calls.push(`briefing.muted=${m}`),
      },
      say: (t) => said.push(t),
    },
  };
}

test('executePlan: layer show/hide/toggle via injected deps', async () => {
  const { deps, calls } = makeDeps();
  const results = await executePlan(
    [
      { type: 'layer', layer: 'firms', op: 'show' },
      { type: 'layer', layer: 'traffic', op: 'hide' },
      { type: 'layer', layer: 'weather', op: 'toggle' },
    ],
    deps,
  );
  assert.deepEqual(calls, ['firms.show', 'traffic.hide', 'weather.toggle']);
  assert.ok(results.every((r) => r.ok));
});

test('executePlan: unknown layer id degrades to a say, not a throw', async () => {
  const { deps, said } = makeDeps();
  const results = await executePlan(
    [{ type: 'layer', layer: 'nope', op: 'show' }],
    deps,
  );
  assert.equal(results[0].ok, false);
  assert.ok(said.length >= 1);
});

test('executePlan: fly resolves via fake geocoder and flies the camera', async () => {
  const { deps } = makeDeps();
  const results = await executePlan([{ type: 'fly', place: 'tokyo' }], deps);
  assert.equal(results[0].ok, true);
  assert.deepEqual(deps.camera.flights[0].latitude, 35.68);
  assert.deepEqual(deps.camera.flights[0].longitude, 139.69);
  assert.equal(deps.camera.flights[0].label, 'Tokyo, Japan');
});

test('executePlan: fly with a geocode miss says so and keeps going', async () => {
  const { deps, said } = makeDeps();
  const results = await executePlan(
    [
      { type: 'fly', place: 'nowhereville' },
      { type: 'layer', layer: 'firms', op: 'show' },
    ],
    deps,
  );
  assert.equal(results[0].ok, false);
  assert.ok(said.some((s) => s.includes('nowhereville')));
  assert.equal(results[1].ok, true, 'plan continues after a miss');
});

test('executePlan: fly accepts a pre-resolved place object', async () => {
  const { deps } = makeDeps();
  const results = await executePlan(
    [{ type: 'fly', place: { lat: 40.7, lng: -74.0, label: 'NYC' } }],
    deps,
  );
  assert.equal(results[0].ok, true);
  assert.equal(deps.camera.flights[0].label, 'NYC');
});

test('executePlan: tour start/stop, brief, mute/unmute', async () => {
  const { deps, calls } = makeDeps();
  await executePlan(
    [
      { type: 'tour', op: 'start' },
      { type: 'tour', op: 'stop' },
      { type: 'brief' },
      { type: 'mute', muted: true },
      { type: 'mute', muted: false },
    ],
    deps,
  );
  assert.deepEqual(calls, [
    'tour.start',
    'tour.stop',
    'briefing.run',
    'briefing.muted=true',
    'briefing.muted=false',
  ]);
});

test('executePlan: unknown step type gets the hint, never throws', async () => {
  const { deps, said } = makeDeps();
  const results = await executePlan([{ type: 'teleport' }], deps);
  assert.equal(results[0].ok, false);
  assert.ok(said.some((s) => s.includes("show wildfires")));
});

test('executePlan: a throwing layer cannot take the plan down', async () => {
  const { deps } = makeDeps();
  deps.layers.firms.show = async () => {
    throw new Error('boom');
  };
  const results = await executePlan(
    [
      { type: 'layer', layer: 'firms', op: 'show' },
      { type: 'say', text: 'still here' },
    ],
    deps,
  );
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
});

test('executePlan: zoom falls back to getPosition+flyTo when no zoom()', async () => {
  const { deps } = makeDeps();
  deps.camera.getPosition = async () => ({ latitude: 10, longitude: 20, heightM: 8_000_000 });
  const results = await executePlan([{ type: 'zoom', direction: 'in' }], deps);
  assert.equal(results[0].ok, true);
  assert.equal(deps.camera.flights[0].heightM, 4_000_000);
});

test('executePlan: missing deps degrade gracefully', async () => {
  const results = await executePlan(
    [{ type: 'tour', op: 'start' }, { type: 'brief' }],
    {},
  );
  assert.ok(results.every((r) => r.ok === false));
});

test('end-to-end: parse then execute "hide traffic and show wildfires"', async () => {
  const { deps, calls } = makeDeps();
  const { plan } = parseQuery('hide traffic and show wildfires');
  assert.equal(plan.length, 2);
  const results = await executePlan(plan, deps);
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(calls, ['traffic.hide', 'firms.show']);
});
