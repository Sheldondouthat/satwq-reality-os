/**
 * Wave 3 Track 2c / 2.11 — RIPEstat routing-pulse display model.
 *
 * RRC_TABLE: RIPE NCC RIS route-collector locations, transcribed from the
 * RIPE NCC ris-docs route-collector table (github.com/ripe-ncc/ris-docs,
 * docs/10_routecollectors.md, retrieved 2026-09-27). Coordinates are city
 * centers (display anchors, not measurement). Type/scope are RIPE's.
 * Attribution is repeated in the /api/ripestat document.
 */
export const RRC_TABLE = {
  rrc00: { city: 'Amsterdam', country: 'NL', ixp: 'multihop (global)', lon: 4.9, lat: 52.37 },
  rrc01: { city: 'London', country: 'GB', ixp: 'LINX / LONAP', lon: -0.13, lat: 51.51 },
  rrc03: { city: 'Amsterdam', country: 'NL', ixp: 'AMS-IX / NL-IX', lon: 4.9, lat: 52.37 },
  rrc04: { city: 'Geneva', country: 'CH', ixp: 'CIXP', lon: 6.14, lat: 46.2 },
  rrc05: { city: 'Vienna', country: 'AT', ixp: 'VIX', lon: 16.37, lat: 48.21 },
  rrc06: { city: 'Tokyo', country: 'JP', ixp: 'DIX-IE / JPIX', lon: 139.69, lat: 35.68 },
  rrc07: { city: 'Stockholm', country: 'SE', ixp: 'Netnod', lon: 18.07, lat: 59.33 },
  rrc10: { city: 'Milan', country: 'IT', ixp: 'MIX', lon: 9.19, lat: 45.46 },
  rrc11: { city: 'New York', country: 'US', ixp: 'NYIIX', lon: -74.01, lat: 40.71 },
  rrc12: { city: 'Frankfurt', country: 'DE', ixp: 'DE-CIX', lon: 8.68, lat: 50.11 },
  rrc13: { city: 'Moscow', country: 'RU', ixp: 'MSK-IX', lon: 37.62, lat: 55.76 },
  rrc14: { city: 'Palo Alto', country: 'US', ixp: 'PAIX', lon: -122.16, lat: 37.44 },
  rrc15: { city: 'São Paulo', country: 'BR', ixp: 'PTTMetro-SP', lon: -46.63, lat: -23.55 },
  rrc16: { city: 'Miami', country: 'US', ixp: 'Equinix Miami', lon: -80.19, lat: 25.76 },
  rrc18: { city: 'Barcelona', country: 'ES', ixp: 'CATNIX', lon: 2.17, lat: 41.39 },
  rrc19: { city: 'Johannesburg', country: 'ZA', ixp: 'NAPAfrica JB', lon: 28.05, lat: -26.2 },
  rrc20: { city: 'Zurich', country: 'CH', ixp: 'SwissIX', lon: 8.54, lat: 47.38 },
  rrc21: { city: 'Paris', country: 'FR', ixp: 'France-IX', lon: 2.35, lat: 48.86 },
  rrc22: { city: 'Bucharest', country: 'RO', ixp: 'InterLAN', lon: 26.1, lat: 44.43 },
  rrc23: { city: 'Singapore', country: 'SG', ixp: 'Equinix SG', lon: 103.82, lat: 1.35 },
  rrc24: { city: 'Montevideo', country: 'UY', ixp: 'LACNIC multihop', lon: -56.16, lat: -34.9 },
  rrc25: { city: 'Amsterdam', country: 'NL', ixp: 'multihop (global)', lon: 4.9, lat: 52.37 },
  rrc26: { city: 'Dubai', country: 'AE', ixp: 'UAE-IX', lon: 55.27, lat: 25.2 },
};

/** Collector rows that have a known table entry -> located collectors. */
export function locateCollectors(collectors) {
  const out = [];
  for (const c of collectors ?? []) {
    const site = RRC_TABLE[c.rrc];
    if (site) out.push({ ...c, ...site });
  }
  return out;
}

/**
 * Star-topology pulse arcs: hub = collector with most peers, spokes to the
 * rest (cap `maxSpokes`). Pure geometry descriptors; the layer lifts them.
 */
export function starArcs(located, maxSpokes = 9) {
  if (!Array.isArray(located) || located.length < 2) return [];
  const sorted = [...located].sort((a, b) => b.peers - a.peers);
  const hub = sorted[0];
  return sorted.slice(1, 1 + maxSpokes).map((spoke) => ({ hub, spoke }));
}

/** Pulse point size from peer count (log-scaled, clamped). */
export function pulseSize(peers) {
  return Math.max(6, Math.min(26, 6 + 8 * Math.log10(1 + (peers ?? 0))));
}

export const PREFIX_COLORS = {
  '1.1.1.0/24': '#4dd0e1',
  '8.8.8.0/24': '#ffd54f',
  '9.9.9.0/24': '#ba68c8',
  '208.67.222.0/24': '#81c784',
};
