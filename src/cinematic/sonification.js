/**
 * sonification.js — F8 data sonification for SATWQ Reality OS.
 *
 * Turns data events into sound: deep rumbles for earthquakes, short filtered
 * ticks for lightning strikes, and a soft chime arpeggio for ISS passes.
 *
 * AUDIO SHARING: this module NEVER creates its own AudioContext. It receives
 * one via `init({ getAudioContext })`. To share the AmbientEngine's context
 * without editing ambientEngine.js (which keeps its context private), the
 * app should create the context first and hand the SAME instance to both:
 *
 *   const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
 *   const ambient = new AmbientEngine({ createContext: () => audioCtx });
 *   const son = initSonification({ getAudioContext: () => audioCtx });
 *
 * (Alternative: AmbientEngine._ctx is private by design; a future one-line
 * `getContext()` accessor on AmbientEngine would let sonification attach to
 * an engine-created context instead.)
 *
 * OFF by default. All event methods are no-ops when disabled or when no
 * AudioContext is available (degrades honestly — never throws in production).
 * Voices run through a dedicated sonification bus (gain) so the user volume
 * setting applies without touching the ambient bed. The shared context is
 * never closed here (it's shared); destroy() only disconnects the bus.
 *
 * Pure, unit-testable mappings: quakeSoundParams(), lightningSoundParams(),
 * issChimeParams(), panForLon(). The synth voices below are thin wrappers
 * around those mappings — no real AudioContext needed to test the mapping.
 */

export const SONIFICATION_DEFAULT_VOLUME = 0.8;
export const SONIFICATION_MAX_VOICES = 16;

/** Deep rumble: lower, longer, louder with magnitude (M2.5+ USGS range). */
export function quakeSoundParams(magnitude) {
  const mag = Number.isFinite(magnitude)
    ? Math.min(10, Math.max(2.5, magnitude))
    : 2.5;
  return {
    type: 'sine',
    frequency: 52 - mag * 2.6, // M2.5 → 45.5 Hz … M9 → 28.6 Hz
    duration: 0.9 + mag * 0.32, // M2.5 → 1.7 s … M9 → 3.8 s
    gain: Math.min(0.5, 0.05 + mag * 0.045), // M2.5 → 0.16 … M9 → 0.46
    attack: 0.03,
  };
}

/** Lightning: a short bandpass-filtered tick, not a boom. */
export function lightningSoundParams() {
  return {
    type: 'noise',
    filterType: 'bandpass',
    filterFreq: 2600,
    filterQ: 7,
    duration: 0.09,
    gain: 0.16,
    attack: 0.002,
  };
}

/** ISS pass: soft chime arpeggio — C5 → E5 → G5, staggered 220 ms. */
export const ISS_CHIME_NOTES = Object.freeze([523.25, 659.25, 783.99]);
export const ISS_CHIME_STAGGER_S = 0.22;

export function issChimeParams(noteIndex = 0) {
  const idx =
    ((noteIndex % ISS_CHIME_NOTES.length) + ISS_CHIME_NOTES.length) %
    ISS_CHIME_NOTES.length;
  return {
    type: 'sine',
    frequency: ISS_CHIME_NOTES[idx],
    duration: 1.1,
    gain: 0.1,
    attack: 0.01,
    delay: idx * ISS_CHIME_STAGGER_S,
  };
}

/** Stereo placement from longitude: -180 → full left, +180 → full right. */
export function panForLon(lon) {
  if (!Number.isFinite(lon)) return 0;
  return Math.min(1, Math.max(-1, lon / 180));
}

const clampVolume = (v) =>
  Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : SONIFICATION_DEFAULT_VOLUME;

/**
 * @param {object} options
 * @param {() => (AudioContext|null)} options.getAudioContext — provider for
 *   the SHARED context (see module header). May return null → all events no-op.
 * @param {number} [options.volume] — user volume 0..1 (default 0.8).
 */
export function initSonification({ getAudioContext, volume } = {}) {
  if (typeof getAudioContext !== 'function')
    throw new TypeError('Sonification requires a getAudioContext provider');

  let _enabled = false;
  let _volume = clampVolume(volume);
  let _ctx = null;
  let _bus = null;
  let _noiseBuffer = null;
  const _voices = []; // active { nodes:[...], stopAt } for throttling

  const ctxNow = () => (_ctx ? _ctx.currentTime : 0);

  /** Lazily grab the shared context and build the sonification bus once. */
  function ensure() {
    if (_bus) return _bus;
    let ctx = null;
    try {
      ctx = getAudioContext();
    } catch {
      ctx = null;
    }
    if (!ctx) return null;
    _ctx = ctx;
    _bus = ctx.createGain();
    _bus.gain.value = _volume;
    _bus.connect(ctx.destination);
    return _bus;
  }

  function noiseBuffer() {
    if (_noiseBuffer) return _noiseBuffer;
    const length = Math.max(1, Math.floor(_ctx.sampleRate * 1));
    const buffer = _ctx.createBuffer(1, length, _ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    _noiseBuffer = buffer;
    return buffer;
  }

  function pruneVoices() {
    const t = ctxNow();
    for (let i = _voices.length - 1; i >= 0; i -= 1) {
      if (_voices[i].stopAt <= t) {
        try {
          for (const n of _voices[i].nodes) n.disconnect?.();
        } catch {
          /* ignore */
        }
        _voices.splice(i, 1);
      }
    }
    while (_voices.length > SONIFICATION_MAX_VOICES) {
      const dropped = _voices.shift();
      try {
        for (const n of dropped.nodes) n.stop?.();
      } catch {
        /* ignore */
      }
    }
  }

  /** ADSR-lite envelope: attack → exponential-ish decay to silence. */
  function envelope(gainParam, peak, attack, duration, t0) {
    gainParam.setValueAtTime(0.0001, t0);
    gainParam.linearRampToValueAtTime(peak, t0 + attack);
    gainParam.exponentialRampToValueAtTime(0.0001, t0 + duration);
  }

  function panNode(lon) {
    if (typeof _ctx.createStereoPanner !== 'function') return null;
    const panner = _ctx.createStereoPanner();
    panner.pan.value = panForLon(lon);
    return panner;
  }

  function voice(nodes, stopAt) {
    _voices.push({ nodes, stopAt });
    pruneVoices();
  }

  function playTone({ frequency, duration, gain, attack, type }, lon) {
    const t0 = ctxNow();
    const osc = _ctx.createOscillator();
    osc.type = type || 'sine';
    osc.frequency.value = frequency;
    const g = _ctx.createGain();
    envelope(g.gain, gain, attack, duration, t0);
    const panner = panNode(lon);
    osc.connect(g);
    const tail = panner ?? g;
    if (panner) g.connect(panner);
    tail.connect(_bus);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
    voice([osc, g, ...(panner ? [panner] : [])], t0 + duration + 0.05);
  }

  function playNoise({ filterType, filterFreq, filterQ, duration, gain }, lon) {
    const t0 = ctxNow();
    const src = _ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const filter = _ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = filterQ;
    const g = _ctx.createGain();
    envelope(g.gain, gain, 0.002, duration, t0);
    const panner = panNode(lon);
    src.connect(filter);
    filter.connect(g);
    const tail = panner ?? g;
    if (panner) g.connect(panner);
    tail.connect(_bus);
    src.start(t0);
    src.stop(t0 + duration + 0.05);
    voice([src, filter, g, ...(panner ? [panner] : [])], t0 + duration + 0.05);
  }

  const api = {
    get enabled() {
      return _enabled;
    },

    get volume() {
      return _volume;
    },

    /** Master toggle. Returns the new state. Safe to call before any context exists. */
    setEnabled(on) {
      const want = Boolean(on);
      _enabled = want;
      if (want) {
        ensure(); // best effort; events still no-op if it returns null
        try {
          if (typeof _ctx?.resume === 'function') {
            const r = _ctx.resume();
            if (r && typeof r.catch === 'function') r.catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
      return _enabled;
    },

    toggle() {
      return api.setEnabled(!_enabled);
    },

    /** User volume 0..1 — scales the sonification bus (ambient bed untouched). */
    setVolume(v) {
      _volume = clampVolume(v);
      if (_bus) _bus.gain.value = _volume;
      return _volume;
    },

    /** Deep rumble scaled by magnitude. Event shape matches USGS records. */
    quake({ magnitude, lat = 0, lon = 0 } = {}) {
      if (!_enabled) return false;
      const bus = ensure();
      if (!bus) return false;
      playTone(quakeSoundParams(magnitude), lon);
      return true;
    },

    /** Short filtered tick for a lightning strike. */
    lightningStrike({ lat = 0, lon = 0 } = {}) {
      if (!_enabled) return false;
      const bus = ensure();
      if (!bus) return false;
      playNoise(lightningSoundParams(), lon);
      return true;
    },

    /** Soft three-note chime arpeggio for an ISS pass. */
    issPass({ lat = 0, lon = 0 } = {}) {
      if (!_enabled) return false;
      const bus = ensure();
      if (!bus) return false;
      const t0 = ctxNow();
      for (let i = 0; i < ISS_CHIME_NOTES.length; i += 1) {
        const params = issChimeParams(i);
        // schedule by offsetting start time through a wrapper voice
        const osc = _ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = params.frequency;
        const g = _ctx.createGain();
        envelope(
          g.gain,
          params.gain,
          params.attack,
          params.duration,
          t0 + params.delay,
        );
        const panner = panNode(lon);
        osc.connect(g);
        const tail = panner ?? g;
        if (panner) g.connect(panner);
        tail.connect(_bus);
        osc.start(t0 + params.delay);
        osc.stop(t0 + params.delay + params.duration + 0.05);
        voice(
          [osc, g, ...(panner ? [panner] : [])],
          t0 + params.delay + params.duration + 0.05,
        );
      }
      return true;
    },

    /** Disconnect the bus. Never closes the shared context. */
    destroy() {
      _enabled = false;
      _voices.length = 0;
      if (_bus) {
        try {
          _bus.disconnect();
        } catch {
          /* ignore */
        }
        _bus = null;
      }
      _ctx = null;
      _noiseBuffer = null;
    },
  };
  return api;
}

/** Alias for the exact API surface the brief names. */
export const init = initSonification;
