import * as Cesium from 'cesium';

/**
 * Arc styling. Two payload fields carry the style, chosen per the
 * data: COLOR is the band (categorical — a web of a thousand arcs
 * reads as propagation geography when each band keeps one hue), and
 * WIDTH + ALPHA are the SNR (BM4 §5's styling field — a strong copy
 * draws thick and bright, a threshold copy thin and faint).
 */
export const WSPR_BAND_COLORS = Object.freeze({
  '2200m': '#38bdf8',
  '630m': '#818cf8',
  '160m': '#a78bfa',
  '80m': '#e879f9',
  '60m': '#f472b6',
  '40m': '#fb7185',
  '30m': '#f87171',
  '20m': '#fb923c',
  '17m': '#facc15',
  '15m': '#a3e635',
  '12m': '#4ade80',
  '10m': '#2dd4bf',
  '6m': '#22d3ee',
  '2m': '#60a5fa',
  other: '#94a3b8',
});

/** Width/alpha steps by SNR (dB, WSPR's 2.5 kHz reference bandwidth). */
export function snrStyle(snrDb) {
  if (typeof snrDb !== 'number' || !Number.isFinite(snrDb))
    return { width: 1.1, alpha: 0.38 };
  if (snrDb >= -10) return { width: 2.6, alpha: 0.95 };
  if (snrDb >= -20) return { width: 1.8, alpha: 0.7 };
  if (snrDb >= -30) return { width: 1.3, alpha: 0.5 };
  return { width: 1.1, alpha: 0.38 };
}

/** Cesium material color for one arc: band hue at the SNR's alpha. */
export function arcColor(band, snrDb) {
  const css = WSPR_BAND_COLORS[band] || WSPR_BAND_COLORS.other;
  return Cesium.Color.fromCssColorString(css).withAlpha(snrStyle(snrDb).alpha);
}

/** Flatten [lon, lat, heightM] triples into Cesium positions. */
export function arcPositions(points) {
  const flat = [];
  for (const [lon, lat, heightM] of points) flat.push(lon, lat, heightM);
  return Cesium.Cartesian3.fromDegreesArrayHeights(flat);
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `wspr-${index}`,
    type: 'wspr-spot',
    // The wspr.rx row id — the cross-face join key (BM4 §7).
    spotId: raw.spotId ?? null,
    txCall: raw.txCall ?? null,
    rxCall: raw.rxCall ?? null,
    freqMHz: raw.freqMHz ?? null,
    band: raw.band ?? null,
    snrDb: raw.snrDb ?? null,
    time: raw.time ?? null,
  };
}
