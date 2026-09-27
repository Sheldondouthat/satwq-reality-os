/**
 * Wave 5 / Track A — volcano alert-ticker client model (pure, no Cesium).
 *
 * HONESTY: GeoNet VAL is New Zealand only; AVO's front page shows
 * ELEVATED-alert Alaska volcanoes only (normal-status ones are invisible
 * to the scrape). "No active volcanoes" means none at elevated alert in
 * these two feeds — not a global all-clear. The ticker says so.
 */

/** Badge color from a GeoNet `acc` color or AVO color code. */
export function levelColor(color) {
  switch (String(color ?? '').toUpperCase()) {
    case 'GREEN': return '#3ddc84';
    case 'YELLOW': return '#ffd23d';
    case 'ORANGE': return '#ff8a3d';
    case 'RED': return '#ff4d4d';
    default: return '#8a93a6';
  }
}

const SEVERITY_RANK = { RED: 0, ORANGE: 1, YELLOW: 2, GREEN: 3 };

/** Sort the ticker: RED > ORANGE > YELLOW, then by name. */
export function rankActive(entries) {
  return [...(entries ?? [])].sort((a, b) =>
    (SEVERITY_RANK[String(a.color ?? '').toUpperCase()] ?? 4) -
    (SEVERITY_RANK[String(b.color ?? '').toUpperCase()] ?? 4) ||
    String(a.name).localeCompare(String(b.name)),
  );
}

/** One-line ticker label for an active entry. */
export function tickerLabel(entry) {
  const color = String(entry.color ?? '').toUpperCase();
  return `${entry.name} · ${color}${entry.region ? ` · ${entry.region}` : ''}`;
}

/** True when nothing at elevated alert is visible in either feed. */
export function noElevated(entries) {
  return rankActive(entries).length === 0;
}

/** Compact "last N of M" for the ticker header. */
export function tickerStatus(count, warnings = []) {
  const base = count === 0
    ? 'no elevated-alert volcanoes in NZ/Alaska feeds'
    : `${count} elevated-alert ${count === 1 ? 'volcano' : 'volcanoes'}`;
  return warnings.length ? `${base} (${warnings.length} source ${warnings.length === 1 ? 'issue' : 'issues'})` : base;
}
