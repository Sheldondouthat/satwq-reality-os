/**
 * Validate the SWPC planetary-K JSON feed and return the latest reading.
 * The feed is a time-ordered array; the last well-formed entry wins.
 */
export function normalizeAuroraSnapshot(payload) {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  for (let i = payload.length - 1; i >= 0; i--) {
    const entry = payload[i];
    if (!entry || typeof entry !== 'object') continue;
    const kp = Number(entry.estimated_kp ?? entry.kp_index);
    const timeMs = Date.parse(entry.time_tag);
    if (!Number.isFinite(kp) || kp < 0 || kp > 9) continue;
    if (!Number.isFinite(timeMs)) continue;
    return { kp, timeMs };
  }
  return null;
}
