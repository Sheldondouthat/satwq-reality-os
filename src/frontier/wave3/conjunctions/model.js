/**
 * SOCRATES conjunction theater (3.3) — pure model + SGP4 helpers.
 * satellite.js is pure JS (no DOM), so these functions are unit-testable in
 * Node. Works on normalized /api/conjunctions events:
 * {id,tcaUtc,noradId1,noradId2,name1,ops1,name2,ops2,minRangeKm,relSpeedKms,
 *  maxProb,dse1,dse2,tle1:{name,line1,line2}|null,tle2|null}.
 */

import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';

export const CONJUNCTION_HONESTY =
  'CelesTrak SOCRATES Plus: SGP4 screening of active payloads against the ' +
  'public catalog, ≤5 km at time of closest approach, next 7 days. Maximum ' +
  'probability is a conservative risk proxy (Alfano method), not a true ' +
  'collision probability. Convergence arcs use the same GP data SOCRATES ' +
  'screened with — positions at TCA are model outputs, not observations.';

const RAD2DEG = 180 / Math.PI;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Defensive coercion of a provider event. Null on garbage. */
export function coerceConjunction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tcaMs = Date.parse(raw.tcaUtc);
  const minRangeKm = numOrNull(raw.minRangeKm);
  const maxProb = numOrNull(raw.maxProb);
  if (!Number.isFinite(tcaMs) || minRangeKm === null || maxProb === null) return null;
  if (minRangeKm < 0 || minRangeKm > 5) return null;
  const tle = (t) => (t && typeof t.line1 === 'string' && typeof t.line2 === 'string' ? t : null);
  return {
    id: typeof raw.id === 'string' ? raw.id : `soc-${tcaMs}`,
    tcaUtc: new Date(tcaMs).toISOString(),
    tcaMs,
    noradId1: String(raw.noradId1 ?? ''),
    noradId2: String(raw.noradId2 ?? ''),
    name1: String(raw.name1 ?? 'UNKNOWN'),
    ops1: raw.ops1 ?? null,
    name2: String(raw.name2 ?? 'UNKNOWN'),
    ops2: raw.ops2 ?? null,
    minRangeKm,
    relSpeedKms: numOrNull(raw.relSpeedKms),
    maxProb,
    dse1: numOrNull(raw.dse1),
    dse2: numOrNull(raw.dse2),
    tle1: tle(raw.tle1),
    tle2: tle(raw.tle2),
  };
}

/** Risk tier from SOCRATES max-probability + miss distance. */
export function riskTier(ev) {
  if (ev.maxProb >= 1e-4 || ev.minRangeKm < 0.5)
    return { key: 'critical', label: 'CRITICAL', color: '#ff3b3b' };
  if (ev.maxProb >= 1e-5 || ev.minRangeKm < 1)
    return { key: 'high', label: 'HIGH', color: '#ff9f5a' };
  return { key: 'watch', label: 'WATCH', color: '#ffd166' };
}

/** "T-2d 04:11:33" countdown; "T+…" once past TCA. */
export function formatCountdown(tcaMs, nowMs = Date.now()) {
  let diff = tcaMs - nowMs;
  const sign = diff < 0 ? '+' : '-';
  diff = Math.abs(diff);
  const d = Math.floor(diff / 86400_000);
  const h = Math.floor((diff % 86400_000) / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  const s = Math.floor((diff % 60_000) / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `T${sign}${d}d ${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Geodetic position of a TLE at an epoch ms via SGP4.
 * @returns {{lat, lon, altKm}|null}
 */
export function tcaPosition(tle, epochMs) {
  try {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    const date = new Date(epochMs);
    const pv = propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const geo = eciToGeodetic(pv.position, gstime(date));
    if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return null;
    return { lat: geo.latitude * RAD2DEG, lon: geo.longitude * RAD2DEG, altKm: geo.height };
  } catch {
    return null;
  }
}

/**
 * Convergence arc between the two TCA positions: lifted polyline so a ≤5 km
 * encounter reads on the globe. Returns [lon,lat,heightM] triples.
 */
export function convergenceArc(posA, posB, { segments = 16, liftKm = 60 } = {}) {
  const out = [];
  const baseAlt = Math.max(posA.altKm, posB.altKm);
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const lat = posA.lat + (posB.lat - posA.lat) * f;
    let dLon = posB.lon - posA.lon;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    const lon = posA.lon + dLon * f;
    const alt = posA.altKm + (posB.altKm - posA.altKm) * f + Math.sin(Math.PI * f) * liftKm;
    out.push([lon, lat, Math.max(1000, alt * 1000)]);
  }
  return out;
}

/** Sort by risk: highest maxProb first, then smallest miss distance. */
export function rankConjunctions(events) {
  return [...events].sort((a, b) => b.maxProb - a.maxProb || a.minRangeKm - b.minRangeKm);
}
