/**
 * Wave 9 — GOES Earth full-disk imagery liveness — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/goes.
 *
 * HONESTY: the provider reports imagery AVAILABILITY (latest CMIPF scan
 * parsed from NOAA S3 object keys), not rendered pictures. valueLine
 * returns null when the payload carries no usable satellite counts;
 * withTags() appends (stale)/(partial) from the envelope. The live
 * full-disk GeoColor JPEGs are NESDIS STAR CDN renders — the detail line
 * says so, and the payload carries their URLs for a future image layer.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/goes';
export const EMOJI = '🛰️';
export const LABEL = 'GOES Earth imagery';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const fresh = pickNum(doc.summary?.fresh);
  const total = pickNum(doc.summary?.total);
  const dark = pickNum(doc.summary?.dark);
  if (fresh == null || total == null) return null;
  const darkBit = dark != null && dark > 0 ? ` · ${dark} dark` : '';
  return withTags(`${EMOJI} GOES ${fresh}/${total} sats fresh (full-disk ≤20m)${darkBit}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const sats = Array.isArray(doc.satellites) ? doc.satellites : [];
  const live = sats
    .filter((s) => s && !s.dark && s.latestScan)
    .map((s) => `${s.sat} ${s.latestScan.slice(11, 16)}Z`);
  const parts = [];
  if (live.length) parts.push(`Latest full-disk scans: ${live.join(' · ')}`);
  parts.push('CMIPF = gridded radiances (NetCDF), not a rendered picture; live JPEGs are NOAA STAR CDN GeoColor renders.');
  return parts.join(' ');
}
