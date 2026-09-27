/**
 * briefing.test.mjs — F12 tests. Zero network: fixtures for buildBriefing,
 * injected fetchImpl for fetchBriefingEvents, fake camera/speak for
 * runBriefing, and a minimal fake DOM for the button.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchBriefingEvents,
  buildBriefing,
  runBriefing,
  createSpeechSynthesisSpeaker,
  mountBriefMeButton,
} from './briefing.js';

const FIXTURE_EVENTS = {
  earthquakes: [
    { mag: 5.1, place: 'off the coast of Chile', lat: -33.0, lon: -72.0, time: 1_700_000_000_000 },
    { mag: 6.4, place: 'Fiji region', lat: -17.8, lon: 178.1, time: 1_700_010_000_000 },
    { mag: 4.2, place: 'Nevada', lat: 39.0, lon: -119.0, time: 1_700_020_000_000 },
  ],
  cyclones: [
    { name: 'Mawar', lat: 14.2, lon: 142.5, category: 'Category 4', basin: 'Western Pacific' },
  ],
  fires: [{ count: 1234, region: 'CONUS' }],
  sources: { events: false, usgs: true, cyclones: true },
  fetchedAt: 1_700_030_000_000,
};

test('buildBriefing: full fixture → script, ordered stops, not limited', () => {
  const b = buildBriefing(FIXTURE_EVENTS);
  assert.equal(b.limited, false);
  assert.ok(b.script.includes('Earth briefing'));
  assert.ok(b.script.includes('6.4'), 'largest quake wins');
  assert.ok(b.script.includes('Fiji region'));
  assert.ok(b.script.includes('Mawar'));
  assert.ok(b.stops.length >= 4, 'overview + quake + cyclone + fires');
  assert.deepEqual(
    b.stops.map((s) => Object.keys(s).sort()),
    b.stops.map(() => ['label', 'lat', 'lon']),
  );
  const quakeStop = b.stops.find((s) => s.label.includes('6.4'));
  assert.ok(quakeStop, 'quake stop labelled with magnitude');
  assert.equal(quakeStop.lat, -17.8);
  assert.equal(quakeStop.lon, 178.1);
  assert.ok(b.segments.every((s) => typeof s.text === 'string' && s.text.length > 0));
});

test('buildBriefing: empty events → limited data preamble, still valid', () => {
  const b = buildBriefing({});
  assert.equal(b.limited, true);
  assert.ok(b.script.includes('limited data'));
  assert.ok(b.segments.length >= 1, 'preamble segment always exists');
  assert.ok(b.stops.length >= 1);
});

test('buildBriefing: garbage in → no throw, limited out', () => {
  for (const bad of [undefined, null, {}, { earthquakes: 'nope' }, { earthquakes: [{ mag: 'x' }] }]) {
    const b = buildBriefing(bad);
    assert.equal(typeof b.script, 'string');
    assert.ok(Array.isArray(b.stops));
  }
});

test('buildBriefing: no cyclones → cyclone segment omitted', () => {
  const b = buildBriefing({ ...FIXTURE_EVENTS, cyclones: [] });
  assert.ok(!b.script.includes('Mawar'));
});

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, json: async () => data };
}

test('fetchBriefingEvents: /api/events primary path', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({
      earthquakes: [{ mag: 5.5, place: 'Testville', lat: 10, lon: 20 }],
      cyclones: [{ name: 'Zed', lat: 1, lon: 2 }],
      fires: [{ count: 42 }],
    });
  };
  const events = await fetchBriefingEvents({ fetchImpl });
  assert.equal(events.sources.events, true);
  assert.equal(events.earthquakes[0].mag, 5.5);
  assert.equal(events.cyclones[0].name, 'Zed');
  assert.deepEqual(calls, ['/api/events'], 'fallback feeds not touched');
});

test('fetchBriefingEvents: /api/events absent → USGS + /api/cyclones fallback', async () => {
  const fetchImpl = async (url) => {
    if (url === '/api/events') return jsonResponse({}, false, 404);
    if (url.includes('earthquake.usgs.gov')) {
      return jsonResponse({
        features: [
          {
            properties: { mag: 6.1, place: 'Kermadec Islands', time: 123 },
            geometry: { coordinates: [179.0, -29.0] },
          },
          {
            properties: { mag: 'bad', place: 'nowhere' },
            geometry: { coordinates: [0, 0] },
          },
        ],
      });
    }
    if (url === '/api/cyclones') {
      return jsonResponse([{ name: 'Yasa', lat: -15, lon: 170, category: 'Cat 3' }]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const events = await fetchBriefingEvents({ fetchImpl });
  assert.equal(events.sources.events, false);
  assert.equal(events.sources.usgs, true);
  assert.equal(events.sources.cyclones, true);
  assert.equal(events.earthquakes.length, 1, 'bad-mag feature dropped');
  assert.equal(events.earthquakes[0].place, 'Kermadec Islands');
  assert.equal(events.cyclones[0].name, 'Yasa');
});

test('fetchBriefingEvents: everything dead → empty bundle, no throw', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const events = await fetchBriefingEvents({ fetchImpl });
  assert.deepEqual(events.earthquakes, []);
  assert.deepEqual(events.cyclones, []);
  const b = buildBriefing(events);
  assert.equal(b.limited, true);
});

function makeCamera() {
  const flights = [];
  return {
    flights,
    async flyTo(view) {
      flights.push(view);
    },
    cancelFlight() {
      flights.push({ kind: 'cancelFlight' });
    },
  };
}

function makeSpeak(log) {
  const fn = async (text) => {
    log.push(text);
    return { ok: true };
  };
  fn.cancel = () => log.push('[cancel]');
  return fn;
}

test('runBriefing: flies stops in order while narrating', async () => {
  const camera = makeCamera();
  const spoken = [];
  const seen = [];
  const briefing = buildBriefing(FIXTURE_EVENTS);
  const { done } = runBriefing({
    camera,
    speak: makeSpeak(spoken),
    briefing,
    onSegment: (info) => seen.push(info.index),
  });
  const results = await done;
  assert.ok(results.length >= 4);
  assert.deepEqual(seen, [0, 1, 2, 3]);
  assert.equal(spoken.length, results.length);
  assert.ok(spoken[0].includes('Earth briefing'));
  // Camera visited the quake stop (largest magnitude).
  const quakeFlight = camera.flights.find((f) => f.label?.includes('6.4'));
  assert.ok(quakeFlight, 'camera flew to the quake stop');
  assert.equal(quakeFlight.latitude, -17.8);
});

test('runBriefing: borrows the camera from a TourDirector-shaped object', async () => {
  const camera = makeCamera();
  const spoken = [];
  const tourDirector = { _viewer: { camera } };
  const { done } = runBriefing({
    tourDirector,
    speak: makeSpeak(spoken),
    briefing: buildBriefing({}),
  });
  await done;
  assert.ok(camera.flights.length >= 1, 'borrowed camera was flown');
  assert.ok(spoken[0].includes('limited data'));
});

test('runBriefing: cancel() stops narration and the camera', async () => {
  const camera = makeCamera();
  let release;
  const gate = new Promise((r) => { release = r; });
  const speak = async (text) => {
    await gate; // hang until cancelled
    return { ok: true, text };
  };
  speak.cancel = () => {};
  const { cancel, done } = runBriefing({
    camera,
    speak,
    briefing: buildBriefing(FIXTURE_EVENTS),
  });
  // Let the first flight land, then cancel mid-narration.
  await new Promise((r) => setTimeout(r, 20));
  cancel();
  release();
  const results = await done;
  assert.ok(
    results.length < buildBriefing(FIXTURE_EVENTS).segments.length,
    'briefing stopped early',
  );
});

test('runBriefing: fetches + builds when no briefing is supplied', async () => {
  const camera = makeCamera();
  const spoken = [];
  const fetchEvents = async () => ({ ...FIXTURE_EVENTS });
  const { done } = runBriefing({ camera, speak: makeSpeak(spoken), fetchEvents });
  await done;
  assert.ok(spoken.join(' ').includes('Mawar'));
});

test('runBriefing: a throwing camera never stops narration', async () => {
  const spoken = [];
  const badCamera = {
    async flyTo() {
      throw new Error('cesium exploded');
    },
  };
  const { done } = runBriefing({
    camera: badCamera,
    speak: makeSpeak(spoken),
    briefing: buildBriefing(FIXTURE_EVENTS),
  });
  const results = await done;
  assert.ok(results.length >= 4);
  assert.ok(spoken.length >= 4);
});

test('createSpeechSynthesisSpeaker: headless speak resolves, mute works', async () => {
  const speaker = createSpeechSynthesisSpeaker();
  assert.equal(speaker.muted, false);
  const r = await speaker.speak('Hello world');
  assert.equal(r.ok, true);
  speaker.setMuted(true);
  assert.equal(speaker.muted, true);
  const skipped = await speaker.speak('should not play');
  assert.equal(skipped.skipped, true);
  speaker.setMuted(false);
  speaker.cancel(); // must not throw
});

/** Minimal fake DOM for the button (no browser in node). */
function makeFakeDom() {
  const listeners = new Map();
  const mkEl = (tag) => ({
    tag,
    children: [],
    dataset: {},
    disabled: false,
    type: '',
    id: '',
    textContent: '',
    setAttribute(k, v) { this[`attr:${k}`] = v; },
    addEventListener(type, fn) {
      if (!listeners.has(this)) listeners.set(this, new Map());
      listeners.get(this).set(type, fn);
    },
    removeEventListener(type) { listeners.get(this)?.delete(type); },
    remove() { this.removed = true; },
    click() { return listeners.get(this)?.get('click')?.(); },
  });
  const container = {
    children: [],
    ownerDocument: { createElement: mkEl },
    appendChild(el) { this.children.push(el); },
  };
  return { container, mkEl };
}

test('mountBriefMeButton: mounts, clicks through onBrief, unmounts', async () => {
  const { container } = makeFakeDom();
  let briefed = 0;
  const { element, unmount } = mountBriefMeButton(container, {
    onBrief: async () => {
      briefed += 1;
      return { done: Promise.resolve([]), cancel: () => {} };
    },
  });
  assert.equal(container.children.length, 1);
  assert.equal(element.textContent, 'Brief me');
  assert.equal(element['attr:aria-label'], 'Play the daily Earth briefing');
  await element.click();
  assert.equal(briefed, 1);
  assert.equal(element.disabled, false, 'button re-enabled after briefing');
  unmount();
  assert.equal(element.removed, true);
});

test('mountBriefMeButton: rejects a non-container', () => {
  assert.throws(() => mountBriefMeButton(null), /DOM container/);
  assert.throws(() => mountBriefMeButton({}), /DOM container/);
});
