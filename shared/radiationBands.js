/**
 * Radiation dose-band classification — shared neutral module.
 *
 * Used by both the server provider (server/providers/wave3/radiation.js) and
 * the browser client (src/frontier/wave3/radiation/model.js). Pure functions,
 * no DOM, no Node APIs. Bands are display-only; they are not health advice.
 */

export const DOSE_BANDS = ['low', 'background', 'elevated', 'high', 'unknown'];

/** µSv/h → display band. Background ~0.05–0.3; >1 is elevated. Display-only. */
export function doseBand(usvH) {
  if (!Number.isFinite(usvH)) return 'unknown';
  if (usvH < 0.1) return 'low';
  if (usvH < 0.3) return 'background';
  if (usvH < 1) return 'elevated';
  return 'high';
}
