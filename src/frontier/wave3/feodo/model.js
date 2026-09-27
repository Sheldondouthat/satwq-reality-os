/**
 * Wave 3 Track 2c / 2.12 — Feodo Tracker display model.
 *
 * Pure aggregation over the /api/feodo entries: per-country counts and the
 * dominant malware families. Markers are placed at country centroids
 * (src/frontier/wave3/common/geo.js) — country-level display only.
 */
import { centroidFor } from '../common/geo.js';

/** [{ iso, lon, lat, count, online }] sorted desc, capped. */
export function countryMarkers(byCountry, entries, cap = 60) {
  const onlineByCountry = {};
  const malwareByCountry = {};
  for (const e of entries ?? []) {
    if (!e?.country) continue;
    if (e.status === 'online') onlineByCountry[e.country] = (onlineByCountry[e.country] ?? 0) + 1;
    if (e.malware) {
      const m = (malwareByCountry[e.country] ??= {});
      m[e.malware] = (m[e.malware] ?? 0) + 1;
    }
  }
  const out = [];
  for (const [iso, count] of Object.entries(byCountry ?? {})) {
    const ll = centroidFor(iso);
    if (!ll) continue; // unmappable country code: listed, not plotted
    const malware = Object.entries(malwareByCountry[iso] ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    out.push({ iso, lon: ll[0], lat: ll[1], count, online: onlineByCountry[iso] ?? 0, malware });
  }
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, cap);
}

export function markerSize(count) {
  return Math.max(8, Math.min(34, 8 + 10 * Math.log10(1 + (count ?? 0))));
}

/** Red when any C2 is currently online, amber otherwise. */
export function markerColorCss(online) {
  return online > 0 ? '#ef5350' : '#ffb454';
}
