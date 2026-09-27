/**
 * ambientEngine.js — WebAudio ambient soundscape for SATWQ Reality OS.
 *
 * Two detuned triangle oscillators (55 Hz / 55.5 Hz — the 0.5 Hz beat gives
 * a slow shimmer) plus a filtered noise wash, all routed through a lowpass
 * into a master gain. toggle() fades the master 0 ↔ 0.15 over 2 s.
 *
 * OFF by default. The AudioContext is created lazily on first enable so
 * construction never touches audio hardware — the app enables it from a user
 * gesture (button click), satisfying autoplay policies.
 *
 * Node graph:
 *
 *   osc1 (triangle 55Hz) ─┐
 *   osc2 (triangle 55.5Hz) ├→ lowpass(220Hz, Q 0.7) ─→ master gain ─→ destination
 *   noise → noiseGain → washLowpass(800Hz) ─┘
 *   lfo (sine 0.07Hz) → lfoDepth(±120Hz) ─→ lowpass.frequency (slow sweep)
 */

export const AMBIENT_OSC_FREQ_A = 55;
export const AMBIENT_OSC_FREQ_B = 55.5;
export const AMBIENT_FILTER_CUTOFF = 220;
export const AMBIENT_FILTER_Q = 0.7;
export const AMBIENT_LFO_FREQ = 0.07;
export const AMBIENT_LFO_DEPTH = 120;
export const AMBIENT_NOISE_LEVEL = 0.12;
export const AMBIENT_WASH_CUTOFF = 800;
export const AMBIENT_TARGET_GAIN = 0.15;
export const AMBIENT_FADE_S = 2;

export class AmbientEngine {
  /**
   * @param {object} [options]
   * @param {() => AudioContext} [options.createContext] — factory for the
   *   WebAudio context. Defaults to `new AudioContext()` (browser). Tests
   *   inject a stub.
   */
  constructor({ createContext = null } = {}) {
    this._createContext =
      createContext ??
      (() => new (window.AudioContext || window.webkitAudioContext)());
    this._ctx = null;
    this._master = null;
    this._enabled = false;
  }

  get enabled() {
    return this._enabled;
  }

  /** Flip the state; returns the new state. */
  toggle() {
    return this.setEnabled(!this._enabled);
  }

  /** Set the state explicitly; returns the new state. */
  setEnabled(on) {
    const want = Boolean(on);
    if (want === this._enabled) return this._enabled;
    this._enabled = want;
    if (want) this._ensureGraph();
    if (this._ctx && this._master) {
      if (typeof this._ctx.resume === 'function') {
        try {
          const r = this._ctx.resume();
          if (r && typeof r.catch === 'function') r.catch(() => {});
        } catch {
          /* ignore */
        }
      }
      this._fadeTo(want ? AMBIENT_TARGET_GAIN : 0);
    }
    return this._enabled;
  }

  /** Lazily build the AudioContext + node graph (once). */
  _ensureGraph() {
    if (this._ctx) return;
    const ctx = this._createContext();
    this._ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    this._master = master;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = AMBIENT_FILTER_CUTOFF;
    filter.Q.value = AMBIENT_FILTER_Q;
    filter.connect(master);

    for (const freq of [AMBIENT_OSC_FREQ_A, AMBIENT_OSC_FREQ_B]) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(filter);
      osc.start();
    }

    // Slow LFO sweep on the filter cutoff.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = AMBIENT_LFO_FREQ;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = AMBIENT_LFO_DEPTH;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.frequency);
    lfo.start();

    // Filtered noise wash.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer(ctx);
    noise.loop = true;
    const wash = ctx.createBiquadFilter();
    wash.type = 'lowpass';
    wash.frequency.value = AMBIENT_WASH_CUTOFF;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = AMBIENT_NOISE_LEVEL;
    noise.connect(noiseGain);
    noiseGain.connect(wash);
    wash.connect(filter);
    noise.start();
  }

  _noiseBuffer(ctx) {
    const seconds = 2;
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _fadeTo(target) {
    const t = this._ctx.currentTime;
    const gain = this._master.gain;
    if (typeof gain.cancelScheduledValues === 'function') {
      gain.cancelScheduledValues(t);
    }
    gain.setValueAtTime(gain.value, t);
    gain.linearRampToValueAtTime(target, t + AMBIENT_FADE_S);
  }
}
