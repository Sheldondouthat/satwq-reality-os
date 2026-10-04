/**
 * Wave 9 — King-tide calendar — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/king-tides.
 *
 * HONESTY: king tides here are the highest PREDICTED high tides of the year
 * (NOAA harmonic model via CO-OPS), not observed water levels — real levels
 * can exceed predictions in storms. Moon phase/perigee are computed from the
 * repo's low-precision lunar ephemeris, labeled as such on the payload.
 * valueLine returns null when the payload carries no usable summary; the
 * detail line names the top-3 king tides with their lunar context.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/king-tides';
export const EMOJI = '🌊';
export const LABEL = 'King-tide calendar';

function firstOkStation(doc) {
  const stations = Array.isArray(doc?.stations) ? doc.stations : [];
  return stations.find((s) => s && s.ok) ?? null;
}

function topKings(doc, n) {
  const st = firstOkStation(doc);
  const kings = Array.isArray(st?.kingTides) ? st.kingTides : [];
  return kings.slice(0, n);
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const [top] = topKings(doc, 1);
  if (!top) return null;
  const date = String(top.time ?? '').slice(0, 10);
  const lunar = top.perigean ? ' perigean' : top.springWindow ? ' spring' : '';
  return withTags(
    `${EMOJI} King tides ${doc.year ?? ''}: ${top.feet} ft on ${date}${lunar}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const tops = topKings(doc, 3);
  const parts = [];
  if (tops.length) {
    parts.push(
      tops
        .map(
          (k) =>
            `#${k.rank} ${String(k.time).slice(0, 10)} ${k.feet} ft` +
            ` (${k.moonPhase}${k.perigean ? ', perigean' : ''}${k.springWindow && !k.perigean ? ', spring' : ''})`,
        )
        .join(' · '),
    );
  } else {
    parts.push(
      'No king-tide predictions in this payload — quiet seas are real data, not a gap.',
    );
  }
  parts.push(
    'Predicted highs (NOAA model), not observed levels; lunar geometry is computed.',
  );
  return parts.join(' ');
}

export function stationCount(doc) {
  return pickNum(doc?.okCount);
}
