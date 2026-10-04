/**
 * Wave 5 — radio-reference client model (pure, no Cesium).
 *
 * HONESTY helpers: callsign lookups are FCC license records (not live);
 * AMSAT TLEs are orbital element sets (positions computed, not measured);
 * numbers-stations results are a reference article DB (NOT live telemetry).
 */

/** Wavelength class of a downlink frequency in Hz. */
export function bandClass(freqHz) {
  const f = Number(freqHz);
  if (!Number.isFinite(f) || f <= 0) return '—';
  if (f < 3_000_000) return 'HF';
  if (f < 30_000_000) return 'HF';
  if (f < 300_000_000) return 'VHF';
  if (f < 3_000_000_000) return 'UHF';
  return 'SHF+';
}

/** Compact "136.659 MHz" formatting. */
export function fmtMhz(freqHz) {
  const f = Number(freqHz);
  if (!Number.isFinite(f) || f <= 0) return '—';
  const mhz = f / 1_000_000;
  return mhz >= 100 ? `${mhz.toFixed(2)} MHz` : `${mhz.toFixed(3)} MHz`;
}

/** One-line honesty label per dataset. */
export function honestyFor(kind) {
  switch (kind) {
    case 'callsign':
      return 'FCC license record via Callook — a lookup, not live telemetry.';
    case 'tle':
      return 'AMSAT element sets; positions are computed, not measured. Complements the CelesTrak layer.';
    case 'numbers':
      return 'Reference article database — NOT live telemetry. There is no public live API for numbers stations.';
    default:
      return '';
  }
}

/** "USB · 136.659 MHz" summary for a transmitter row. */
export function transmitterSummary(tx) {
  const mode = String(tx?.mode ?? '') || '—';
  const f = fmtMhz(tx?.downlinkHz?.low ?? tx?.downlinkHz?.high);
  return `${mode} · ${f}`;
}

/** Keep only live transmitters with a usable downlink, capped. */
export function plottableTransmitters(rows, cap = 100) {
  return (Array.isArray(rows) ? rows : [])
    .filter(
      (t) =>
        t?.alive && Number.isFinite(t?.downlinkHz?.low ?? t?.downlinkHz?.high),
    )
    .slice(0, cap);
}

export function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}
