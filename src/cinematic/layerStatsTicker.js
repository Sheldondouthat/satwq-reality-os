/**
 * layerStatsTicker.js — animated numeric readouts for HUD layer stats.
 *
 * animateStatValue(el, from, to, {duration}) drives a rAF loop with an
 * easeOutCubic ramp and writes compact-formatted values into `el.textContent`
 * (or el.value when present). Returns a cancel() function.
 *
 * The rAF implementation is injectable via options.frame for testing.
 */

export function easeOutCubic(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** 1234 → "1.2K", 2500000 → "2.5M", 999 → "999". */
export function formatCompact(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  const abs = Math.abs(num);
  const trim = (v, suffix) => {
    const rounded = Math.round(v * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`;
  };
  if (abs >= 1e9) return trim(num / 1e9, 'B');
  if (abs >= 1e6) return trim(num / 1e6, 'M');
  if (abs >= 1e3) return trim(num / 1e3, 'K');
  return String(Math.round(num));
}

/** 1234567 → "1,234,567". */
export function formatInt(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return Math.round(num).toLocaleString('en-US');
}

const defaultFrame = (cb) =>
  typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(cb)
    : setTimeout(() => cb(Date.now()), 16);

export function animateStatValue(
  el,
  from,
  to,
  { duration = 600, format = formatCompact, frame = defaultFrame } = {},
) {
  if (!el) throw new TypeError('animateStatValue requires an element');
  const start = Number(from) || 0;
  const end = Number(to) || 0;
  const span = end - start;
  const total = Math.max(0, Number(duration) || 0);
  let cancelled = false;
  let t0 = null;

  const write = (value) => {
    const text = format(value);
    if ('value' in el && typeof el.value === 'string') el.value = text;
    else el.textContent = text;
    if (typeof el.classList?.add === 'function') {
      el.classList.remove('stat-ticking');
      // Force reflow so the flash animation restarts on every write.
      void el.offsetWidth;
      el.classList.add('stat-ticking');
    }
  };

  const step = (timestamp) => {
    if (cancelled) return;
    if (t0 === null) t0 = timestamp;
    const elapsed = timestamp - t0;
    const progress = total === 0 ? 1 : Math.min(1, elapsed / total);
    write(start + span * easeOutCubic(progress));
    if (progress < 1) frame(step);
    else write(end); // land exactly on the target
  };

  write(start);
  frame(step);
  return () => {
    cancelled = true;
  };
}
