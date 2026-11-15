/**
 * Wave 6 — WSPR (live propagation spots) dock ticker.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Thin spec over the
 * shared ticker factory in src/frontier/wave3/common/ticker.js.
 * Poll matches the provider's 3-minute cache (wspr.live courtesy:
 * ~20 req/min ceiling — never poll faster).
 */
import { createTickerInit } from '../../wave3/common/ticker.js';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

export const init = createTickerInit({
  themeKey: 'feature.wspr',
  fallbackLabel: LABEL,
  emoji: EMOJI,
  route: ROUTE,
  pollMs: 180000,
  valueLine,
  detailLine,
});
