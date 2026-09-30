/**
 * Wave 9 — SNOTEL snowpack — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/snotel.
 *
 * HONESTY: the provider re-serves USDA NRCS AWDB daily telemetry — WTEQ
 * (snow water equivalent, in) and SNWD (snow depth, in) — for 18 pinned
 * western-US SNOTEL stations. 0 = the sensor reported no snow (a real
 * reading; early-season zeros are expected). valueLine returns null when
 * the payload carries no usable station counts; withTags() appends
 * (stale)/(partial) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/snotel';
export const EMOJI = '❄️';
export const LABEL = 'SNOTEL snowpack';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const withSnow = pickNum(doc.summary?.withSnow);
  const total = pickNum(doc.summary?.total);
  if (withSnow == null || total == null) return null;
  const maxSnwd = pickNum(doc.summary?.maxSnwdIn);
  const maxStation = pickStr(doc.summary?.maxSnwdStation);
  const maxBit = maxSnwd != null && maxStation ? ` · max ${maxSnwd}in ${maxStation}` : '';
  return withTags(`${EMOJI} SNOTEL ${withSnow}/${total} stations w/ snow${maxBit}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const stations = Array.isArray(doc.stations) ? doc.stations : [];
  const snowy = stations
    .filter((s) => s && s.hasSnow && s.snwdIn != null)
    .sort((a, b) => b.snwdIn - a.snwdIn)
    .slice(0, 3)
    .map((s) => `${s.name}, ${s.state} ${s.snwdIn}in`);
  const parts = [];
  if (snowy.length) parts.push(`Deepest: ${snowy.join(' · ')}.`);
  parts.push('WTEQ = snow water equivalent (in); SNWD = snow depth (in). 0 = sensor reported no snow (real reading).');
  return parts.join(' ');
}
