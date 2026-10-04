/**
 * Wave 7 — Air quality (model) dock ticker.
 *
 * Fail-soft init({ viewer, mount, chip, trackLayer, t }). Thin spec over the
 * shared ticker factory in src/frontier/wave3/common/ticker.js.
 */
import { createTickerInit } from '../../wave3/common/ticker.js';
import {
  ROUTE,
  EMOJI,
  LABEL,
  valueLine,
  detailLine,
  locationQuery,
} from './model.js';

export const init = createTickerInit({
  themeKey: 'feature.aqModel',
  fallbackLabel: LABEL,
  emoji: EMOJI,
  route: ROUTE,
  pollMs: 300000,
  valueLine,
  detailLine,
  locationQuery,
});
