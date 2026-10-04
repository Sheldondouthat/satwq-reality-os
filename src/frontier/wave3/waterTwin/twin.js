/**
 * Water twin — pure presentation/model logic (Wave 3, Track 1c, item 1.10).
 * DOM-free; tested in waterTwin.test.mjs.
 *
 * Public surface:
 *   bandLabel(band) -> human label
 *   bandColor(band) -> hex color
 *   reservoirBand(pctFull) -> 'critical' | 'low' | 'moderate' | 'healthy' | 'unknown'
 *   reservoirBandColor(band) -> hex
 *   summarizeTwin(payload) -> { reservoirsLive, riversLive, worstRiver, driestReservoir }
 */

/** Height bands from the server provider (classifyFloodBand). */
const BAND_LABELS = Object.freeze({
  'major-flood': 'Major flooding',
  'moderate-flood': 'Moderate flooding',
  'minor-flood': 'Minor flooding',
  action: 'Action stage',
  normal: 'Normal',
  unknown: 'No reading',
});

const BAND_COLORS = Object.freeze({
  'major-flood': '#ff3b3b',
  'moderate-flood': '#ff7a1a',
  'minor-flood': '#ffd21a',
  action: '#7ac7ff',
  normal: '#4dd07a',
  unknown: '#8a93a6',
});

export function bandLabel(band) {
  return BAND_LABELS[band] ?? 'No reading';
}

export function bandColor(band) {
  return BAND_COLORS[band] ?? '#8a93a6';
}

const BAND_ORDER = [
  'unknown',
  'normal',
  'action',
  'minor-flood',
  'moderate-flood',
  'major-flood',
];
export function bandRank(band) {
  const i = BAND_ORDER.indexOf(band);
  return i === -1 ? 0 : i;
}

/** Storage bands. Thresholds are presentation buckets, not agency categories. */
export function reservoirBand(pctFull) {
  if (!Number.isFinite(pctFull)) return 'unknown';
  if (pctFull < 25) return 'critical';
  if (pctFull < 50) return 'low';
  if (pctFull < 75) return 'moderate';
  return 'healthy';
}

export function reservoirBandColor(band) {
  switch (band) {
    case 'critical':
      return '#ff3b3b';
    case 'low':
      return '#ff9d1a';
    case 'moderate':
      return '#ffd21a';
    case 'healthy':
      return '#4dd07a';
    default:
      return '#8a93a6';
  }
}

export function reservoirBandLabel(band) {
  switch (band) {
    case 'critical':
      return 'Critically low';
    case 'low':
      return 'Low';
    case 'moderate':
      return 'Moderate';
    case 'healthy':
      return 'Healthy';
    default:
      return 'No reading';
  }
}

export function summarizeTwin(payload) {
  const reservoirs = payload?.reservoirs ?? [];
  const rivers = payload?.rivers ?? [];
  const liveR = reservoirs.filter((r) => r.status === 'live');
  const liveV = rivers.filter((r) => r.status === 'live');
  let worstRiver = null;
  for (const r of liveV) {
    if (!worstRiver || bandRank(r.band) > bandRank(worstRiver.band))
      worstRiver = r;
  }
  let driestReservoir = null;
  for (const r of liveR) {
    if (!Number.isFinite(r.pctFull)) continue;
    if (!driestReservoir || r.pctFull < driestReservoir.pctFull)
      driestReservoir = r;
  }
  return {
    reservoirsLive: liveR.length,
    riversLive: liveV.length,
    worstRiver,
    driestReservoir,
  };
}
