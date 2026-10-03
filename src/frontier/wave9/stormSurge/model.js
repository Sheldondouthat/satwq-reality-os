/**
 * Wave 9 — Storm-surge residuals — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/storm-surge.
 *
 * HONESTY: residuals are observed water level minus the NOAA harmonic-model
 * predicted tide — what already happened, not a surge forecast. Positive =
 * water running above predicted tide (storm/onshore wind/low pressure).
 * Unmatched hours read null on the payload, never interpolated.
 * valueLine returns null when the payload carries no usable summary; the
 * detail line names the max/latest residuals with their timestamps.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/storm-surge';
export const EMOJI = '🌀';
export const LABEL = 'Storm-surge residuals';

function firstOkStation(doc) {
  const stations = Array.isArray(doc?.stations) ? doc.stations : [];
  return stations.find((s) => s && s.ok) ?? null;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const st = firstOkStation(doc);
  const s = st?.summary;
  if (!st || !s || !Number.isFinite(s.maxResidualFeet)) return null;
  const name = st.station?.name ?? st.station?.id ?? '';
  const sign = s.maxResidualFeet >= 0 ? '+' : '';
  const dir = s.maxResidualFeet >= 0 ? 'above' : 'below';
  return withTags(
    `${EMOJI} Surge ${sign}${s.maxResidualFeet} ft ${dir} predicted tide @ ${name}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const st = firstOkStation(doc);
  const s = st?.summary;
  const parts = [];
  if (st && s && Number.isFinite(s.maxResidualFeet)) {
    const day = (t) => String(t ?? '').slice(0, 10);
    const clock = (t) => String(t ?? '').slice(11, 16);
    parts.push(
      `Max ${s.maxResidualFeet >= 0 ? '+' : ''}${s.maxResidualFeet} ft ` +
        `(${s.maxResidualFeet >= 0 ? 'above' : 'below'} predicted tide) ${day(s.maxResidualTime)} ${clock(s.maxResidualTime)} UTC`,
    );
    if (Number.isFinite(s.latestResidualFeet)) {
      parts.push(
        `latest ${s.latestResidualFeet >= 0 ? '+' : ''}${s.latestResidualFeet} ft ${clock(s.latestResidualTime)} UTC`,
      );
    }
    if (Number.isFinite(s.meanResidualFeet)) {
      parts.push(`mean ${s.meanResidualFeet >= 0 ? '+' : ''}${s.meanResidualFeet} ft over ${s.matchedHours}h`);
    }
  } else {
    parts.push('No matched observation/prediction hours in this payload — quiet or gap, not a zero.');
  }
  parts.push('Observed minus NOAA predicted tide; past conditions, not a forecast.');
  return parts.join(' ');
}

export function stationCount(doc) {
  return pickNum(doc?.okCount);
}
