/**
 * Wave 9 — edge self-probe ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/self-probe.
 *
 * HONESTY: this route is a connectivity census from the Cloudflare edge —
 * a 200 is NOT proof of a machine-readable feed. valueLine names the
 * money metric (hosts the VM could not reach that the edge can);
 * detailLine carries the verdict breakdown. bot-wall verdicts are recorded,
 * never bypassed.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/self-probe';
export const EMOJI = '📡';
export const LABEL = 'Edge self-probe (honest-failure census)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const total = pickNum(doc.summary?.total);
  if (total == null) return null;
  const newlyReachable = pickNum(doc.summary?.edgeNewlyReachable) ?? 0;
  const reachable = pickNum(doc.summary?.reachable) ?? 0;
  return withTags(`${EMOJI} Edge self-probe: ${reachable}/${total} hosts reachable · ${newlyReachable} revived from edge`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const s = doc.summary ?? {};
  const parts = [
    `Reachable ${s.reachable ?? '?'} · feed candidates ${s.feedCandidates ?? '?'} · bot-walls ${s.botWalls ?? '?'} · not-found ${s.notFound ?? '?'} · unreachable ${s.unreachable ?? '?'} · rate-limited ${s.rateLimited ?? '?'} · server errors ${s.serverErrors ?? '?'}.`,
  ];
  if ((s.edgeNewlyReachable ?? 0) > 0) {
    parts.push(`${s.edgeNewlyReachable} host(s) the VM could not reach answered 200 from the edge.`);
  }
  parts.push('Connectivity census only — a 200 is not proof of a machine-readable feed.');
  return parts.join(' ');
}
