import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmbientEngine,
  AMBIENT_TARGET_GAIN,
  AMBIENT_FADE_S,
  AMBIENT_OSC_FREQ_A,
  AMBIENT_OSC_FREQ_B,
} from './ambientEngine.js';

/** Recording AudioParam stub. */
function makeParam(initial = 0) {
  return {
    value: initial,
    calls: [],
    setValueAtTime(value, time) {
      this.calls.push({ kind: 'setValueAtTime', value, time });
      this.value = value;
    },
    linearRampToValueAtTime(value, time) {
      this.calls.push({ kind: 'linearRampToValueAtTime', value, time });
    },
    cancelScheduledValues(time) {
      this.calls.push({ kind: 'cancelScheduledValues', time });
    },
  };
}

/** Stub AudioContext that records the whole node graph. */
function makeStubContext() {
  const nodes = [];
  const record = (node) => {
    nodes.push(node);
    return node;
  };
  const ctx = {
    nodes,
    sampleRate: 48000,
    currentTime: 42,
    destination: { kind: 'destination' },
    createGain: () =>
      record({ kind: 'gain', gain: makeParam(0), connect: (d) => d }),
    createOscillator: () =>
      record({
        kind: 'oscillator',
        type: '',
        frequency: makeParam(0),
        connect: (d) => d,
        start: () => {},
      }),
    createBiquadFilter: () =>
      record({
        kind: 'filter',
        type: '',
        frequency: makeParam(0),
        Q: makeParam(0),
        connect: (d) => d,
      }),
    createBufferSource: () =>
      record({
        kind: 'bufferSource',
        buffer: null,
        loop: false,
        connect: (d) => d,
        start: () => {},
      }),
    createBuffer: (channels, length, rate) => ({
      getChannelData: () => new Float32Array(length),
    }),
    resumeCalls: 0,
    resume() {
      this.resumeCalls += 1;
      return Promise.resolve();
    },
  };
  return ctx;
}

test('off by default; no AudioContext created until first enable', () => {
  let created = 0;
  const engine = new AmbientEngine({
    createContext: () => {
      created += 1;
      return makeStubContext();
    },
  });
  assert.equal(engine.enabled, false);
  assert.equal(created, 0);
});

test('toggle() fades master gain up to 0.15 over 2s', () => {
  const ctx = makeStubContext();
  const engine = new AmbientEngine({ createContext: () => ctx });
  assert.equal(engine.toggle(), true);
  assert.equal(engine.enabled, true);

  const master = ctx.nodes.find((n) => n.kind === 'gain');
  assert.ok(master, 'expected a master gain node');
  const ramps = master.gain.calls.filter(
    (c) => c.kind === 'linearRampToValueAtTime',
  );
  assert.equal(ramps.length, 1);
  assert.equal(ramps[0].value, AMBIENT_TARGET_GAIN);
  assert.equal(ramps[0].time, ctx.currentTime + AMBIENT_FADE_S);
  const sets = master.gain.calls.filter((c) => c.kind === 'setValueAtTime');
  assert.equal(sets.length, 1);
  assert.equal(sets[0].value, 0); // starts from silence
});

test('graph wiring: detuned triangle pair + LFO + noise wash into master', () => {
  const ctx = makeStubContext();
  const engine = new AmbientEngine({ createContext: () => ctx });
  engine.setEnabled(true);

  const oscs = ctx.nodes.filter((n) => n.kind === 'oscillator');
  const triangles = oscs.filter((o) => o.type === 'triangle');
  assert.equal(triangles.length, 2);
  assert.deepEqual(
    triangles.map((o) => o.frequency.value).sort((a, b) => a - b),
    [AMBIENT_OSC_FREQ_A, AMBIENT_OSC_FREQ_B],
  );
  const lfo = oscs.find((o) => o.type === 'sine');
  assert.ok(lfo, 'expected a sine LFO');
  assert.ok(ctx.nodes.some((n) => n.kind === 'bufferSource' && n.loop === true));
  assert.ok(ctx.nodes.some((n) => n.kind === 'filter' && n.type === 'lowpass'));
});

test('second toggle fades back to 0; context created exactly once', () => {
  let created = 0;
  const ctx = makeStubContext();
  const engine = new AmbientEngine({
    createContext: () => {
      created += 1;
      return ctx;
    },
  });
  engine.toggle();
  engine.toggle();
  assert.equal(engine.enabled, false);
  assert.equal(created, 1);
  const master = ctx.nodes.find((n) => n.kind === 'gain');
  const ramps = master.gain.calls.filter(
    (c) => c.kind === 'linearRampToValueAtTime',
  );
  assert.equal(ramps.length, 2);
  assert.equal(ramps[1].value, 0);
});

test('setEnabled is idempotent — no duplicate fades', () => {
  const ctx = makeStubContext();
  const engine = new AmbientEngine({ createContext: () => ctx });
  engine.setEnabled(true);
  engine.setEnabled(true);
  const master = ctx.nodes.find((n) => n.kind === 'gain');
  const ramps = master.gain.calls.filter(
    (c) => c.kind === 'linearRampToValueAtTime',
  );
  assert.equal(ramps.length, 1);
  assert.equal(engine.setEnabled(false), false);
});
