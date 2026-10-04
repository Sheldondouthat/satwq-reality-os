/**
 * Wave 6 — Weather stations (ext) dock ticker.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Thin spec over the
 * shared ticker factory in src/frontier/wave3/common/ticker.js.
 */
import { createTickerInit } from '../../wave3/common/ticker.js';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

export const init = createTickerInit({
  themeKey: 'feature.stationsExt',
  fallbackLabel: LABEL,
  emoji: EMOJI,
  route: ROUTE,
  pollMs: 300000,
  valueLine,
  detailLine,
});
