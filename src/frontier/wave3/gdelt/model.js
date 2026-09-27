/**
 * Wave 3 Track 2c / 2.13 — GDELT planetary-attention display model.
 *
 * clusterMentions: grid-clusters raw mentions into heat bubbles —
 * { lon, lat, count, avgTone, names[], urls[] }. Tone in [-100, 100];
 * null tones are ignored in the average.
 */

/** Round-half-degree grid clustering. Pure; exported for tests. */
export function clusterMentions(mentions, cellDeg = 0.5) {
  const cells = new Map();
  for (const m of mentions ?? []) {
    if (!Number.isFinite(m?.lon) || !Number.isFinite(m?.lat)) continue;
    const key = `${Math.round(m.lon / cellDeg)}:${Math.round(m.lat / cellDeg)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        lon: 0, lat: 0, count: 0, toneSum: 0, toneN: 0, names: [], urls: [],
      };
      cells.set(key, cell);
    }
    cell.count++;
    cell.lon += m.lon;
    cell.lat += m.lat;
    if (Number.isFinite(m.tone)) { cell.toneSum += m.tone; cell.toneN++; }
    if (m.name && cell.names.length < 6 && !cell.names.includes(m.name)) {
      cell.names.push(m.name);
    }
    if (m.url && cell.urls.length < 4 && !cell.urls.includes(m.url)) {
      cell.urls.push(m.url);
    }
  }
  const out = [];
  for (const cell of cells.values()) {
    out.push({
      lon: Math.round((cell.lon / cell.count) * 100) / 100,
      lat: Math.round((cell.lat / cell.count) * 100) / 100,
      count: cell.count,
      avgTone: cell.toneN ? Math.round((cell.toneSum / cell.toneN) * 10) / 10 : null,
      names: cell.names,
      urls: cell.urls,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

export function bubbleSize(count) {
  return Math.max(8, Math.min(40, 8 + 12 * Math.log10(1 + (count ?? 0))));
}

/** Tone -> bubble color: negative red, positive green, neutral gold. */
export function toneColorCss(avgTone) {
  if (avgTone == null) return '#ffd54f';
  if (avgTone < -1.5) return '#ef5350';
  if (avgTone > 1.5) return '#66bb6a';
  return '#ffd54f';
}
