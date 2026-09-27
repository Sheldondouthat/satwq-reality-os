/**
 * Cosmic-ray weather (3.1) — pure model over W5's normalized /api/nmdb
 * snapshot. Station-relative pulses + a coarse Forbush-decrease watch.
 *
 * Metric honesty: W5's provider reports per-station `deviation` (latest −
 * 1-day median, native NEST series units) and `deviationMAD` (deviation in
 * units of median absolute deviation — a robust z-score). Percent-of-median
 * is deliberately NOT used: the corr_for_efficiency series is itself
 * deviation-scale with a near-zero median, so % blew up to −2934% on live
 * data (W5, 2026-09-27). All thresholds below are in MAD units.
 *
 * Forbush honesty: real Forbush decreases are identified from
 * pressure-corrected multi-station data with a sharp onset over hours.
 * This detector sees only 1-day-window, efficiency-corrected series and
 * station-relative baselines, so it is a COARSE WATCH, not an
 * identification. Every alert carries that label.
 */

export const COSMIC_HONESTY =
  'NMDB neutron-monitor deviations are station-relative and DERIVED: ' +
  'deviation = latest − 1-day median (native NEST units), deviationMAD = ' +
  'deviation in median-absolute-deviation units (robust z-score). They ' +
  'model cosmic-ray intensity change at each site — not absolute flux, ' +
  'and not a global field. The Forbush watch is coarse (≤ −3 MAD at ≥3 ' +
  'stations, 1-day window) — a real identification needs ' +
  'pressure-corrected data and onset analysis we do not do.';

/** Coarse Forbush watch: ≤ −3 MAD simultaneous drop… */
export const FORBUSH_THRESHOLD_MAD = -3;
/** …at this many stations. */
export const FORBUSH_MIN_STATIONS = 3;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Defensive coercion of a W5 station row. Null on garbage. */
export function coerceStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = numOrNull(raw.lat);
  const lon = numOrNull(raw.lon);
  if (lat === null || Math.abs(lat) > 90) return null;
  if (lon === null || Math.abs(lon) > 180) return null;
  return {
    code: String(raw.code ?? 'UNK'),
    name: String(raw.name ?? raw.code ?? 'Unknown'),
    lat,
    lon,
    deviation: numOrNull(raw.deviation),
    deviationMAD: numOrNull(raw.deviationMAD),
    samples: Number.isFinite(Number(raw.samples)) ? Number(raw.samples) : 0,
    status: raw.status === 'ok' ? 'ok' : 'nodata',
    latestT: raw.latest && typeof raw.latest.t === 'string' ? raw.latest.t : null,
  };
}

/** A station counts as "live" when it has a finite robust deviation. */
export function isLive(s) {
  return s.status === 'ok' && Number.isFinite(s.deviationMAD);
}

/**
 * Globe-node pulse for a station: size grows with |deviationMAD|, color
 * encodes sign. Drops (solar shielding) go amber→red; rises go cyan.
 */
export function stationPulse(deviationMAD) {
  const mad = Number.isFinite(deviationMAD) ? deviationMAD : 0;
  const mag = Math.min(12, Math.abs(mad));
  const size = Math.round(6 + mag * 1.6);
  let color;
  if (mad <= FORBUSH_THRESHOLD_MAD) color = '#ff3b3b';
  else if (mad < -1) color = '#ff9f5a';
  else if (mad <= 1) color = '#7ee2a8';
  else color = '#59c2ff';
  return { size, color, deviationMAD: mad };
}

/** Compact "−4.2σ" style label for a MAD value. */
export function formatMAD(mad) {
  if (!Number.isFinite(mad)) return '—';
  return `${mad >= 0 ? '+' : ''}${mad.toFixed(1)}σ`;
}

/**
 * Pulse phase for an alerted station node: numeric milliseconds → 0..1.
 * Kept in the model (not inline in the Cesium callback) because the
 * CallbackProperty hands us a JulianDate object — `Math.sin(julianDate/450)`
 * would be NaN. Callers convert via JulianDate.toDate(t).getTime() first.
 */
export function pulsePhase(timeMs) {
  if (!Number.isFinite(timeMs)) return 0;
  return Math.abs(Math.sin(timeMs / 450));
}

/**
 * Coarse Forbush-decrease watch over coerced stations.
 * @returns {{level:'alert'|'watch'|'quiet', drops: object[], maxDropMAD,
 *   stationsChecked: number, note: string}}
 */
export function detectForbush(stations) {
  const ok = stations.filter(isLive);
  const drops = ok
    .filter((s) => s.deviationMAD <= FORBUSH_THRESHOLD_MAD)
    .sort((a, b) => a.deviationMAD - b.deviationMAD);
  const level =
    drops.length >= FORBUSH_MIN_STATIONS ? 'alert'
    : drops.length >= 2 ? 'watch'
    : 'quiet';
  return {
    level,
    drops,
    maxDropMAD: drops.length ? drops[0].deviationMAD : null,
    stationsChecked: ok.length,
    note:
      'coarse watch: 1-day window, station-relative MAD baselines — ' +
      'not a Forbush identification',
  };
}

/** Global mood line from the median station deviationMAD. */
export function globalMood(stations) {
  const mads = stations.filter(isLive).map((s) => s.deviationMAD).sort((a, b) => a - b);
  if (!mads.length) return { label: 'NO DATA', color: '#8a93a6', median: null };
  const mid = Math.floor(mads.length / 2);
  const median = mads.length % 2 ? mads[mid] : (mads[mid - 1] + mads[mid]) / 2;
  if (median <= FORBUSH_THRESHOLD_MAD) return { label: 'SUPPRESSED', color: '#ff3b3b', median };
  if (median < -1) return { label: 'DIPPING', color: '#ff9f5a', median };
  if (median <= 1) return { label: 'QUIET', color: '#7ee2a8', median };
  return { label: 'ELEVATED', color: '#59c2ff', median };
}

/** Sort stations by |deviationMAD| for the panel. */
export function rankStations(stations) {
  return [...stations].sort(
    (a, b) => Math.abs(b.deviationMAD ?? 0) - Math.abs(a.deviationMAD ?? 0),
  );
}
