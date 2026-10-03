/**
 * Wave 9 — mempool.space Bitcoin network state — dock ticker.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Thin spec over the
 * shared ticker factory in src/frontier/wave3/common/ticker.js.
 */
import { createTickerInit } from '../../wave3/common/ticker.js';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

export const init = createTickerInit({
  themeKey: 'feature.mempool',
  fallbackLabel: LABEL,
  emoji: EMOJI,
  route: ROUTE,
  pollMs: 600000,
  valueLine,
  detailLine,
});
