/**
 * Wave 3 / Track 3b.8 — Volcano infrasound pure helpers (Cesium-free, node-testable).
 */

/** Format a Pascal value for display; '—' when unknown. */
export function fmtPa(v, digits = 3) {
  return Number.isFinite(v) ? `${v.toFixed(digits)} Pa` : '—';
}

/** Render a tiny sparkline of the pressure envelope as an SVG string. */
export function envelopeSparkline(envelope, color) {
  if (!Array.isArray(envelope) || !envelope.length) return '';
  const w = 220;
  const h = 44;
  const peak = Math.max(...envelope, 1e-9);
  const pts = envelope
    .map(
      (v, i) =>
        `${((i / (envelope.length - 1)) * w).toFixed(1)},` +
        `${(h - (v / peak) * (h - 4) - 2).toFixed(1)}`,
    )
    .join(' ');
  return (
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `style="display:block;background:#0b1226;border-radius:4px">` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`
  );
}

/**
 * Envelope audification (model). Plays an 8 s sub-audio rumble whose loudness
 * follows the measured 10-min pressure envelope. Creates its own AudioContext
 * on the user click (gesture-gated). Returns true when playback started,
 * false in non-browser environments or when audio is unavailable.
 */
export function audifyEnvelope(envelope, { lon = 0 } = {}) {
  if (!Array.isArray(envelope) || !envelope.length) return false;
  if (typeof window === 'undefined') return false;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    const ctx = new AC();
    const dur = 8;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 55; // sub-audio rumble carrier, clearly labeled as model
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    const peak = Math.max(...envelope, 1e-9);
    const t0 = ctx.currentTime + 0.05;
    for (let i = 0; i < envelope.length; i++) {
      const t = t0 + (i / (envelope.length - 1)) * dur;
      g.gain.linearRampToValueAtTime(
        0.0001 + 0.5 * Math.min(1, envelope[i] / (peak || 1)),
        t,
      );
    }
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur + 0.1);
    let tail = g;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, lon / 180));
      g.connect(p);
      tail = p;
    }
    osc.connect(g);
    tail.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.2);
    osc.onended = () => ctx.close().catch(() => {});
    return true;
  } catch {
    return false;
  }
}
