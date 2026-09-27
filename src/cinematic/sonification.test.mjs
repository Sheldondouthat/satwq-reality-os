import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initSonification,
  init,
  quakeSoundParams,
  lightningSoundParams,
  issChimeParams,
  panForLon,
  ISS_CHIME_NOTES,
  ISS_CHIME_STAGGER_S,
  SONIFICATION_MAX_VOICES,
  SONIFICATION_DEFAULT_VOLUME,
} from './sonification.js';

/* ---------- pure param mappings ---------- */

test('quakeSoundParams: deep rumble scales with magnitude', () => {
  const small = quakeSoundParams(2.5);
  const big = quakeSoundParams(9);
  assert.ok(big.frequency < small.frequency, 'bigger quake = deeper');
  assert.ok(big.duration > small.duration, 'bigger quake = longer');
  assert.ok(big.gain > small.gain, 'bigger quake = louder');
  assert.ok(small.frequency > 20 && big.frequency > 20, 'stays above infrasonic mud');
  assert.ok(big.gain <= 0.5, 'gain capped');
  assert.equal(small.type, 'sine');
  // clamping, not crashing
  assert.deepEqual(quakeSoundParams(99), quakeSoundParams(10));
  assert.deepEqual(quakeSoundParams(-3), quakeSoundParams(2.5));
  assert.deepEqual(quakeSoundParams(NaN), quakeSoundParams(2.5));
});

test('lightningSoundParams: short filtered tick', () => {
  const p = lightningSoundParams();
  assert.equal(p.type, 'noise');
  assert.equal(p.filterType, 'bandpass');
  assert.ok(p.filterFreq > 1000 && p.filterFreq < 8000);
  assert.ok(p.duration < 0.5, 'tick, not a rumble');
  assert.ok(p.gain > 0 && p.gain < 1);
});

test('issChimeParams: three staggered soft notes', () => {
  assert.equal(ISS_CHIME_NOTES.length, 3);
  const notes = [issChimeParams(0), issChimeParams(1), issChimeParams(2)];
  assert.ok(notes[0].frequency < notes[1].frequency);
  assert.ok(notes[1].frequency < notes[2].frequency);
  assert.equal(notes[1].delay - notes[0].delay, ISS_CHIME_STAGGER_S);
  assert.equal(notes[2].delay - notes[0].delay, ISS_CHIME_STAGGER_S * 2);
  assert.deepEqual(issChimeParams(3), issChimeParams(0), 'wraps note index');
  for (const n of notes) assert.ok(n.gain <= 0.15, 'soft chime');
});

test('panForLon: -180 left, +180 right, clamped', () => {
  assert.equal(panForLon(-180), -1);
  assert.equal(panForLon(180), 1);
  assert.equal(panForLon(0), 0);
  assert.ok(Math.abs(panForLon(-90) - -0.5) < 1e-9);
  assert.equal(panForLon(999), 1);
  assert.equal(panForLon(NaN), 0);
});

/* ---------- fake AudioContext (mirrors ambientEngine.test.mjs stub style) ---------- */

function makeParam(initial = 0) {
  return {
    value: initial,
    calls: [],
    setValueAtTime(v, t) {
      this.calls.push(['set', v, t]);
      this.value = v;
    },
    linearRampToValueAtTime(v, t) {
      this.calls.push(['ramp', v, t]);
    },
    exponentialRampToValueAtTime(v, t) {
      this.calls.push(['exp', v, t]);
    },
    cancelScheduledValues(t) {
      this.calls.push(['cancel', t]);
    },
  };
}

function makeNode(extra = {}) {
  return {
    connections: [],
    connect(target) {
      this.connections.push(target);
    },
    disconnect() {},
    ...extra,
  };
}

function makeStubContext() {
  const nodes = [];
  const ctx = {
    nodes,
    sampleRate: 48000,
    currentTime: 100,
    destination: { kind: 'destination' },
    resumed: 0,
    closeCalled: false,
    resume() {
      this.resumed += 1;
      return Promise.resolve();
    },
    close() {
      this.closeCalled = true;
      return Promise.resolve();
    },
    createOscillator() {
      const n = makeNode({
        kind: 'osc',
        type: '',
        frequency: makeParam(440),
        startedAt: null,
        stoppedAt: null,
        start(t) {
          this.startedAt = t;
        },
        stop(t) {
          this.stoppedAt = t;
        },
      });
      nodes.push(n);
      return n;
    },
    createGain() {
      const n = makeNode({ kind: 'gain', gain: makeParam(1) });
      nodes.push(n);
      return n;
    },
    createBiquadFilter() {
      const n = makeNode({
        kind: 'filter',
        type: '',
        frequency: makeParam(1000),
        Q: makeParam(1),
      });
      nodes.push(n);
      return n;
    },
    createBufferSource() {
      const n = makeNode({
        kind: 'src',
        buffer: null,
        startedAt: null,
        stoppedAt: null,
        start(t) {
          this.startedAt = t;
        },
        stop(t) {
          this.stoppedAt = t;
        },
      });
      nodes.push(n);
      return n;
    },
    createStereoPanner() {
      const n = makeNode({ kind: 'panner', pan: makeParam(0) });
      nodes.push(n);
      return n;
    },
    createBuffer(channels, length, rate) {
      return { getChannelData: () => new Float32Array(length) };
    },
  };
  return ctx;
}

const byKind = (ctx, kind) => ctx.nodes.filter((n) => n.kind === kind);

/* ---------- module behavior ---------- */

test('initSonification requires a getAudioContext provider', () => {
  assert.throws(() => initSonification(), TypeError);
  assert.throws(() => initSonification({ getAudioContext: 42 }), TypeError);
  assert.equal(typeof init, 'function', 'init alias exported');
});

test('disabled or contextless: all events no-op, never throw', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  assert.equal(son.enabled, false);
  assert.equal(son.quake({ magnitude: 6 }), false);
  assert.equal(son.lightningStrike({ lat: 1, lon: 2 }), false);
  assert.equal(son.issPass({ lat: 1, lon: 2 }), false);
  assert.equal(ctx.nodes.length, 0, 'no audio nodes while disabled');

  const nullCtx = initSonification({ getAudioContext: () => null });
  nullCtx.setEnabled(true);
  assert.equal(nullCtx.enabled, true);
  assert.equal(nullCtx.quake({ magnitude: 6 }), false, 'no-op without context');
  assert.equal(nullCtx.lightningStrike({}), false);
  assert.equal(nullCtx.issPass({}), false);

  const throwing = initSonification({
    getAudioContext: () => {
      throw new Error('boom');
    },
  });
  throwing.setEnabled(true);
  assert.equal(throwing.quake({ magnitude: 6 }), false, 'provider throw degrades');
});

test('enabled: quake plays deep rumble through the sonification bus', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx, volume: 0.5 });
  assert.equal(son.setEnabled(true), true);
  assert.equal(ctx.resumed, 1, 'resume attempted on enable');

  assert.equal(son.quake({ magnitude: 7.2, lon: -90 }), true);
  const oscs = byKind(ctx, 'osc');
  assert.equal(oscs.length, 1);
  const expected = quakeSoundParams(7.2);
  assert.ok(
    Math.abs(oscs[0].frequency.value - expected.frequency) < 1e-9,
    `osc freq ${oscs[0].frequency.value} ≈ ${expected.frequency}`,
  );
  assert.equal(oscs[0].type, 'sine');
  assert.ok(oscs[0].startedAt != null && oscs[0].stoppedAt != null);

  const panners = byKind(ctx, 'panner');
  assert.equal(panners.length, 1);
  assert.ok(Math.abs(panners[0].pan.value - panForLon(-90)) < 1e-9);

  // sonification bus: dedicated gain at user volume → destination
  const gains = byKind(ctx, 'gain');
  const bus = gains.find((g) => g.connections.includes(ctx.destination));
  assert.ok(bus, 'bus gain exists');
  assert.equal(bus.gain.value, 0.5);
});

test('lightningStrike plays a bandpassed noise tick', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  son.setEnabled(true);
  assert.equal(son.lightningStrike({ lat: 10, lon: 45 }), true);
  const filters = byKind(ctx, 'filter');
  assert.equal(filters.length, 1);
  assert.equal(filters[0].type, 'bandpass');
  assert.equal(filters[0].frequency.value, lightningSoundParams().filterFreq);
  const srcs = byKind(ctx, 'src');
  assert.equal(srcs.length, 1);
  assert.ok(srcs[0].startedAt != null);
});

test('issPass plays a staggered three-note chime', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  son.setEnabled(true);
  assert.equal(son.issPass({ lat: 0, lon: 120 }), true);
  const oscs = byKind(ctx, 'osc');
  assert.equal(oscs.length, 3);
  const freqs = oscs.map((o) => o.frequency.value);
  assert.deepEqual(freqs, [...ISS_CHIME_NOTES]);
  const starts = oscs.map((o) => o.startedAt).sort((a, b) => a - b);
  assert.ok(Math.abs(starts[1] - starts[0] - ISS_CHIME_STAGGER_S) < 1e-9);
  assert.ok(Math.abs(starts[2] - starts[0] - ISS_CHIME_STAGGER_S * 2) < 1e-9);
});

test('setVolume clamps and drives the bus; toggle flips', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  assert.equal(son.volume, SONIFICATION_DEFAULT_VOLUME);
  assert.equal(son.setVolume(2), 1);
  assert.equal(son.setVolume(-1), 0);
  assert.equal(son.setVolume(0.3), 0.3);
  son.setEnabled(true);
  const bus = byKind(ctx, 'gain').find((g) =>
    g.connections.includes(ctx.destination),
  );
  assert.equal(bus.gain.value, 0.3);
  assert.equal(son.toggle(), false);
  assert.equal(son.toggle(), true);
});

test('voice cap: burst of events never throws, never leaks unbounded', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  son.setEnabled(true);
  for (let i = 0; i < SONIFICATION_MAX_VOICES + 10; i += 1) {
    assert.equal(son.quake({ magnitude: 5 }), true);
  }
  // with a frozen clock nothing expires by time, so the hard cap prunes
  const stopped = byKind(ctx, 'osc').filter((o) => o.stoppedAt != null).length;
  assert.ok(stopped > 0, 'excess voices are stopped');
});

test('destroy disconnects the bus but never closes the shared context', () => {
  const ctx = makeStubContext();
  const son = initSonification({ getAudioContext: () => ctx });
  son.setEnabled(true);
  son.quake({ magnitude: 5 });
  son.destroy();
  assert.equal(son.enabled, false);
  assert.equal(ctx.closeCalled, false, 'shared context must survive');
  assert.equal(son.quake({ magnitude: 5 }), false, 'dead after destroy');
});
