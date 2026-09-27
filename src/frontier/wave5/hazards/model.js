/**
 * Wave 5 / Track A — GDACS multi-hazard client model (pure, no Cesium).
 *
 * HONESTY: GDACS alert levels are JRC-analyst severity scores (Red/Orange),
 * not predictions of local impact; `severityText` is JRC's own wording.
 * iscurrent marks episodes GDACS still considers live.
 */

/** Marker color per GDACS event type. */
export function hazardColor(eventtype) {
  switch (eventtype) {
    case 'EQ': return '#ff5a5a'; // earthquake
    case 'TC': return '#c44dff'; // tropical cyclone
    case 'FL': return '#4da3ff'; // flood
    case 'WF': return '#ffb454'; // wildfire
    case 'VO': return '#ff3d71'; // volcano
    case 'DR': return '#b07a4f'; // drought
    default: return '#8a93a6';
  }
}

/** Glyph per hazard type for dock rows. */
export function hazardGlyph(eventtype) {
  switch (eventtype) {
    case 'EQ': return '🌐';
    case 'TC': return '🌀';
    case 'FL': return '🌊';
    case 'WF': return '🔥';
    case 'VO': return '🌋';
    case 'DR': return '🏜️';
    default: return '⚠️';
  }
}

/** Sort: live first, then Red > Orange, then JRC alert score. */
export function rankHazards(events) {
  const rank = { Red: 0, Orange: 1, Green: 2 };
  return [...(events ?? [])].sort((a, b) =>
    Number(b.iscurrent ?? false) - Number(a.iscurrent ?? false) ||
    (rank[a.alertlevel] ?? 1) - (rank[b.alertlevel] ?? 1) ||
    (b.alertscore ?? 0) - (a.alertscore ?? 0),
  );
}

/** Dock label: name + alert level + live badge. */
export function hazardLabel(event) {
  const parts = [event.name || event.eventtype];
  if (event.alertlevel) parts.push(event.alertlevel);
  if (event.iscurrent) parts.unshift('● LIVE');
  if (event.country) parts.push(event.country);
  return parts.join(' · ');
}

/** Short type name for legends. */
export function hazardTypeName(eventtype) {
  return {
    EQ: 'earthquake', TC: 'tropical cyclone', FL: 'flood',
    WF: 'wildfire', VO: 'volcano', DR: 'drought',
  }[eventtype] ?? 'other';
}
