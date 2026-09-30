/**
 * Wave 9 — U.S. Drought Monitor weekly summary — dock ticker.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Thin spec over the
 * shared ticker factory in src/frontier/wave3/common/ticker.js.
 */
import { createTickerInit } from '../../wave3/common/ticker.js';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

export const init = createTickerInit({
  themeKey: 'feature.usdm',
  fallbackLabel: LABEL,
  emoji: EMOJI,
  route: ROUTE,
  pollMs: 21600000, // weekly upstream cadence — 6h poll is plenty
  valueLine,
  detailLine,
});
