/**
 * Wave 3 Track 2c / 2.15 — EiBi "on air now" display model.
 *
 * aggregateOnAir: ITU -> { iso, lon, lat, count, stations[] } for the
 * globe's country markers. ITU codes that are not countries
 * (CLA/CLM clandestine, UN, XUU, P) have no centroid -> returned in
 * `unmapped` (listed, never plotted). bandOf maps kHz to the classic
 * shortwave broadcast band label.
 */
import { centroidFor, ITU_TO_ISO2 } from '../common/geo.js';

/** Classic HF broadcast bands (kHz ranges) for labeling. */
const BANDS = [
  [2300, 2500, '120m'],
  [3200, 3400, '90m'],
  [3900, 4000, '75m'],
  [4750, 5060, '60m'],
  [5900, 6200, '49m'],
  [7200, 7450, '41m'],
  [9400, 9900, '31m'],
  [11600, 12100, '25m'],
  [13570, 13870, '22m'],
  [15100, 15830, '19m'],
  [17480, 17900, '16m'],
  [18900, 19020, '15m'],
  [21450, 21750, '13m'],
  [25670, 26100, '11m'],
];

export function bandOf(freqKhz) {
  for (const [lo, hi, label] of BANDS) {
    if (freqKhz >= lo && freqKhz <= hi) return label;
  }
  if (freqKhz < 30000) return 'HF';
  return 'other';
}

/** itu code -> ISO2 or null (non-country codes). */
export function isoForItu(itu) {
  if (!itu) return null;
  const up = String(itu).trim().toUpperCase();
  return ITU_TO_ISO2[up] ?? (/^[A-Z]{2}$/.test(up) ? up : null);
}

export function aggregateOnAir(onAir, cap = 60) {
  const byIso = new Map();
  const unmapped = [];
  for (const e of onAir ?? []) {
    const iso = isoForItu(e.itu);
    const ll = centroidFor(e.itu);
    if (!iso || !ll) {
      if (unmapped.length < 40) unmapped.push(e);
      continue;
    }
    let g = byIso.get(iso);
    if (!g) {
      g = { iso, itu: e.itu, lon: ll[0], lat: ll[1], count: 0, stations: [] };
      byIso.set(iso, g);
    }
    g.count++;
    if (g.stations.length < 8) {
      g.stations.push({
        freqKhz: e.freqKhz,
        station: e.station,
        lang: e.lang,
        target: e.target,
        band: bandOf(e.freqKhz),
        time: e.time,
        site: e.site ?? null,
        persistence: e.persistence ?? null,
        lastHeard: e.lastHeard ?? null,
      });
    }
  }
  const markers = [...byIso.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, cap);
  return { markers, unmapped, unmappedCount: unmapped.length };
}

export function markerSize(count) {
  return Math.max(8, Math.min(36, 8 + 9 * Math.log10(1 + (count ?? 0))));
}
