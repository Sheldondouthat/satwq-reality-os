/**
 * Wave 6 — merged scoreboards (NFL + MLB + NHL + NBA + MLS, ESPN).
 *
 * Ticker model (pure, no DOM) for GET /api/sports.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickArr,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/sports';
export const EMOJI = '🏟️';
export const LABEL = 'Sports scores';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const games = pickArr(doc.games);
  if (!games.length) return null;
  const live = games.filter((g) =>
    /live|in.?progress|q[1-4]|half|period/i.test(pickStr(g.state)),
  ).length;
  return withTags(
    `${EMOJI} ${games.length} games${live ? ` · ${live} live` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  return pickArr(doc.games)
    .slice(0, 3)
    .map(
      (g) =>
        `${pickStr(g.away, '?')} ${g.awayScore ?? '?'} @ ${pickStr(g.home, '?')} ${g.homeScore ?? '?'} (${pickStr(g.state, g.detail, 'n/a')})`,
    )
    .join(' · ');
}
