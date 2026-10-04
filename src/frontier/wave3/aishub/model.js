/**
 * Wave 3 Track 2c / 2.17 — AISHub receiver-station display model.
 *
 * Pure helpers over /api/aishub stations: freshness bucketing for marker
 * color and a render cap. Stations only — no vessel data exists in this
 * feature by design.
 */

/** Freshness bucket from lastSeen unix seconds. */
export function freshnessBucket(
  lastSeen,
  nowSec = Math.floor(Date.now() / 1000),
) {
  if (!Number.isFinite(lastSeen)) return 'unknown';
  const age = nowSec - lastSeen;
  if (age < 0) return 'unknown';
  if (age <= 3600) return 'live';
  if (age <= 86400) return 'day';
  return 'stale';
}

export function freshnessColorCss(bucket) {
  switch (bucket) {
    case 'live':
      return '#4dd0a6';
    case 'day':
      return '#ffd54f';
    case 'stale':
      return '#8aa4d6';
    default:
      return '#9e9e9e';
  }
}

/** Sort live-first and cap for rendering. */
export function pickStations(stations, nowSec, cap = 1500) {
  const rank = { live: 0, day: 1, stale: 2, unknown: 3 };
  return [...(stations ?? [])]
    .sort(
      (a, b) =>
        rank[freshnessBucket(a.lastSeen, nowSec)] -
        rank[freshnessBucket(b.lastSeen, nowSec)],
    )
    .slice(0, cap);
}
