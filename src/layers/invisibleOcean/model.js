/**
 * Invisible Ocean (F13) — pure model.
 *
 * Everything here is dependency-free ESM: no Cesium, no DOM, no node: imports,
 * so this module is safe to import from BOTH the browser layer and the
 * server-side proxy (server/providers/invisibleOceanProxy.js), including the
 * Cloudflare Pages Functions registry.
 *
 * What it covers:
 *  - Maidenhead grid-square -> lat/lon (volunteer spot locators -> globe points)
 *  - Great-circle arc math (TX->RX propagation paths)
 *  - Spot normalization + age/fade (WSPRnet + PSK Reporter -> one shape)
 *  - Band table (frequency -> amateur band + color)
 *  - SWPC "EM weather" parsing (solar wind, Kp, X-ray flux)
 *  - MUF *intuition* model — a heuristic, explicitly labelled model-not-measurement
 *
 * Honesty boundary (also in about.js): we visualize that a signal propagated
 * between two volunteer stations. Never message content, never devices, never
 * people. Resolution math does not close on any of those, so we do not try.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371;

// ---------------------------------------------------------------------------
// Maidenhead grid squares
// ---------------------------------------------------------------------------

const GRID_RE = /^[A-Ra-r]{2}[0-9]{2}([A-Xa-x]{2}([0-9]{2})?)?$/;

/** True when the value is a parseable Maidenhead locator (4, 6 or 8 chars). */
export function isValidGrid(grid) {
  return typeof grid === 'string' && GRID_RE.test(grid.trim());
}

/**
 * Convert a Maidenhead grid square to the CENTER of its smallest subsquare.
 * Returns { lat, lon } in degrees, or null for invalid input.
 */
export function maidenheadToLatLon(grid) {
  if (!isValidGrid(grid)) return null;
  const g = grid.trim().toUpperCase();
  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += Number(g[2]) * 2;
  lat += Number(g[3]) * 1;
  if (g.length >= 6) {
    lon += (g.charCodeAt(4) - 65) * (5 / 60);
    lat += (g.charCodeAt(5) - 65) * (2.5 / 60);
    if (g.length >= 8) {
      lon += Number(g[6]) * (5 / 600);
      lat += Number(g[7]) * (2.5 / 600);
    }
    // Center within the smallest subsquare rather than its SW corner.
    const lonStep = g.length >= 8 ? 5 / 600 : 5 / 60;
    const latStep = g.length >= 8 ? 2.5 / 600 : 2.5 / 60;
    lon += lonStep / 2;
    lat += latStep / 2;
  } else {
    lon += 1; // center of the 2° x 1° field
    lat += 0.5;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------------------
// Great-circle arc math
// ---------------------------------------------------------------------------

function toVec(latDeg, lonDeg) {
  const lat = latDeg * RAD;
  const lon = lonDeg * RAD;
  return [
    Math.cos(lat) * Math.cos(lon),
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
  ];
}

function toLatLon([x, y, z]) {
  return { lat: Math.asin(Math.max(-1, Math.min(1, z))) * DEG, lon: Math.atan2(y, x) * DEG };
}

/** Haversine distance in km between two {lat, lon} points. */
export function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Great-circle interpolation (slerp) between two {lat, lon} points.
 * Returns an array of [lon, lat] in degrees, length = segments + 1.
 * Slerp on the unit sphere is antimeridian-safe by construction.
 */
export function greatCirclePath(a, b, segments = 24) {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  const steps = Math.max(1, Math.floor(segments));
  const path = [];
  if (omega < 1e-9) {
    for (let i = 0; i <= steps; i++) path.push([a.lon, a.lat]);
    return path;
  }
  const sinOmega = Math.sin(omega);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const k0 = Math.sin((1 - t) * omega) / sinOmega;
    const k1 = Math.sin(t * omega) / sinOmega;
    const p = toLatLon([
      k0 * va[0] + k1 * vb[0],
      k0 * va[1] + k1 * vb[1],
      k0 * va[2] + k1 * vb[2],
    ]);
    path.push([p.lon, p.lat]);
  }
  return path;
}

/** Midpoint of the great-circle path between two points (for labels/arcs). */
export function arcMidpoint(a, b) {
  const va = toVec(a.lat, a.lon);
  const vb = toVec(b.lat, b.lon);
  const len = Math.hypot(va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]);
  if (len < 1e-9) return { lat: a.lat, lon: a.lon };
  return toLatLon([(va[0] + vb[0]) / len, (va[1] + vb[1]) / len, (va[2] + vb[2]) / len]);
}

/**
 * Apex height (km above the ellipsoid) for a propagation arc.
 * Longer hops arc higher — a visual metaphor for ionospheric skip, NOT a
 * measured reflection height.
 */
export function arcApexKm(distanceKm) {
  return Math.min(1200, Math.max(180, 150 + distanceKm * 0.12));
}

/** Segment budget for an arc: enough to look smooth, capped for perf. */
export function arcSegments(distanceKm) {
  return Math.min(48, Math.max(8, Math.round(distanceKm / 250)));
}

// ---------------------------------------------------------------------------
// Band table
// ---------------------------------------------------------------------------

/** Amateur bands we actually see in WSPR/PSK traffic. freqHz -> band. */
const BANDS = [
  { name: '160m', meters: 160, lowHz: 1_800_000, highHz: 2_000_000, color: '#7b5cff', typicalMHz: 1.9 },
  { name: '80m', meters: 80, lowHz: 3_500_000, highHz: 4_000_000, color: '#5aa2ff', typicalMHz: 3.6 },
  { name: '60m', meters: 60, lowHz: 5_300_000, highHz: 5_410_000, color: '#4fd1c5', typicalMHz: 5.35 },
  { name: '40m', meters: 40, lowHz: 7_000_000, highHz: 7_300_000, color: '#48bb78', typicalMHz: 7.1 },
  { name: '30m', meters: 30, lowHz: 10_100_000, highHz: 10_150_000, color: '#a3e635', typicalMHz: 10.12 },
  { name: '20m', meters: 20, lowHz: 14_000_000, highHz: 14_350_000, color: '#f6e05e', typicalMHz: 14.2 },
  { name: '17m', meters: 17, lowHz: 18_068_000, highHz: 18_168_000, color: '#f6ad55', typicalMHz: 18.1 },
  { name: '15m', meters: 15, lowHz: 21_000_000, highHz: 21_450_000, color: '#fc8181', typicalMHz: 21.2 },
  { name: '12m', meters: 12, lowHz: 24_890_000, highHz: 24_990_000, color: '#f687b3', typicalMHz: 24.94 },
  { name: '10m', meters: 10, lowHz: 28_000_000, highHz: 29_700_000, color: '#e53e3e', typicalMHz: 28.5 },
  { name: '6m', meters: 6, lowHz: 50_000_000, highHz: 54_000_000, color: '#ff7ab8', typicalMHz: 50.3 },
  { name: '2m', meters: 2, lowHz: 144_000_000, highHz: 148_000_000, color: '#e2e8f0', typicalMHz: 144.5 },
];

/** Band descriptor for a frequency in Hz, or null when off-band. */
export function frequencyToBand(freqHz) {
  const f = Number(freqHz);
  if (!Number.isFinite(f) || f <= 0) return null;
  return BANDS.find((b) => f >= b.lowHz && f <= b.highHz) ?? null;
}

export function bandColor(bandName) {
  return BANDS.find((b) => b.name === bandName)?.color ?? '#94a3b8';
}

// ---------------------------------------------------------------------------
// Spot normalization + aging
// ---------------------------------------------------------------------------

export const SPOT_TTL_MS = 15 * 60 * 1000; // arcs fade out over 15 minutes
export const MIN_ARC_KM = 50; // skip self-spots / degenerate hops
export const MAX_ARCS = 350; // perf cap per sweep

function hashId(parts) {
  const s = parts.join('|');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `spot-${(h >>> 0).toString(16)}`;
}

/**
 * Normalize one raw spot into the canonical shape both providers produce.
 * Returns null when the spot is unusable (bad grids, off-band, self-spot).
 *
 * Canonical spot: {
 *   id, provider: 'pskreporter'|'wsprnet', txLat, txLon, rxLat, rxLon,
 *   freqHz, band, mode, snrDb, timeMs, txCall, rxCall, distanceKm
 * }
 */
export function normalizeSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = raw.provider === 'wsprnet' ? 'wsprnet' : 'pskreporter';
  const tx = maidenheadToLatLon(raw.txGrid);
  const rx = maidenheadToLatLon(raw.rxGrid);
  if (!tx || !rx) return null;
  const band = frequencyToBand(raw.freqHz);
  if (!band) return null;
  const timeMs = Number(raw.timeMs);
  if (!Number.isFinite(timeMs) || timeMs <= 0) return null;
  const distanceKm = haversineKm(tx, rx);
  if (distanceKm < MIN_ARC_KM) return null;
  const snrDb = Number(raw.snrDb);
  return {
    id: hashId([provider, String(raw.txCall ?? ''), String(raw.rxCall ?? ''), String(raw.freqHz), String(timeMs)]),
    provider,
    txLat: tx.lat,
    txLon: tx.lon,
    rxLat: rx.lat,
    rxLon: rx.lon,
    freqHz: Number(raw.freqHz),
    band: band.name,
    color: band.color,
    mode: typeof raw.mode === 'string' ? raw.mode.slice(0, 12) : '—',
    snrDb: Number.isFinite(snrDb) ? snrDb : null,
    timeMs,
    txCall: typeof raw.txCall === 'string' ? raw.txCall.slice(0, 16) : '—',
    rxCall: typeof raw.rxCall === 'string' ? raw.rxCall.slice(0, 16) : '—',
    distanceKm: Math.round(distanceKm),
  };
}

/** Milliseconds since the spot was heard. */
export function spotAgeMs(spot, now = Date.now()) {
  return Math.max(0, now - spot.timeMs);
}

/** True while the spot is still inside its fade TTL. */
export function isSpotAlive(spot, now = Date.now(), ttlMs = SPOT_TTL_MS) {
  return spotAgeMs(spot, now) <= ttlMs;
}

/**
 * Render alpha for a spot: full at birth, linear fade to 0 at TTL end.
 * Oldest living spots are ghosts; dead spots are culled, never frozen.
 */
export function spotAlpha(spot, now = Date.now(), ttlMs = SPOT_TTL_MS) {
  const age = spotAgeMs(spot, now);
  if (age >= ttlMs) return 0;
  return 1 - age / ttlMs;
}

/**
 * Sort newest-first and cap the count for perf. Returns { spots, dropped }.
 */
export function capSpots(spots, max = MAX_ARCS) {
  const sorted = [...spots].sort((a, b) => b.timeMs - a.timeMs);
  return { spots: sorted.slice(0, max), dropped: Math.max(0, sorted.length - max) };
}

// ---------------------------------------------------------------------------
// Upstream text parsers (run server-side in the proxy; pure string code)
// ---------------------------------------------------------------------------

/**
 * Parse PSK Reporter /query XML (encap=2 wraps it in <js><![CDATA[ ... ]]>).
 * Extracts <receptionReport .../> attribute sets -> raw spot records.
 * Returns { reports: [...], truncated }.
 */
export function parsePskXml(text, now = Date.now()) {
  const reports = [];
  if (typeof text !== 'string' || !text) return { reports, truncated: false };
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const xml = cdata ? cdata[1] : text;
  const tagRe = /<receptionReport\b([^>]*?)\/>/g;
  const attrRe = /(\w+)="([^"]*)"/g;
  let tag;
  while ((tag = tagRe.exec(xml))) {
    const attrs = {};
    let attr;
    attrRe.lastIndex = 0;
    while ((attr = attrRe.exec(tag[1]))) attrs[attr[1]] = attr[2];
    const freqHz = Number(attrs.frequency);
    const flowSeconds = Number(attrs.flowStartSeconds);
    if (!Number.isFinite(freqHz) || !isValidGrid(attrs.senderLocator) || !isValidGrid(attrs.receiverLocator)) continue;
    reports.push({
      provider: 'pskreporter',
      txCall: attrs.senderCallsign || '—',
      rxCall: attrs.receiverCallsign || '—',
      txGrid: attrs.senderLocator,
      rxGrid: attrs.receiverLocator,
      freqHz,
      mode: attrs.mode || '—',
      snrDb: attrs.sNR ?? null,
      // flowStartSeconds is epoch seconds at the reporter; trust but bound it.
      timeMs:
        Number.isFinite(flowSeconds) && flowSeconds > 1_500_000_000 && flowSeconds * 1000 <= now + 600_000
          ? flowSeconds * 1000
          : now,
    });
    if (reports.length >= 2000) break;
  }
  return { reports, truncated: reports.length >= 2000 };
}

function stripTags(s) {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse WSPRnet olddb HTML table rows -> raw spot records.
 * Columns: Date | Call | Frequency(MHz) | SNR | Drift | Grid | dBm | W |
 *          Reporter | ReporterGrid | km | mi | Mode | Version
 * Returns { reports: [...], truncated }.
 */
export function parseWsprHtml(text, now = Date.now()) {
  const reports = [];
  if (typeof text !== 'string' || !text) return { reports, truncated: false };
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(text))) {
    const cells = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell;
    while ((cell = cellRe.exec(row[1]))) cells.push(stripTags(cell[1]));
    // Header rows and nav rows have few/different cells; spot rows have >= 13.
    if (cells.length < 13) continue;
    const [dateStr, call, freqMHzStr, snrStr, , grid, , , reporter, reporterGrid, , , mode] = cells;
    const freqHz = Number(freqMHzStr) * 1_000_000;
    if (!call || !Number.isFinite(freqHz) || !isValidGrid(grid) || !isValidGrid(reporterGrid)) continue;
    const parsed = Date.parse(`${dateStr} UTC`);
    reports.push({
      provider: 'wsprnet',
      txCall: call,
      rxCall: reporter || '—',
      txGrid: grid,
      rxGrid: reporterGrid,
      freqHz,
      mode: mode || 'WSPR',
      snrDb: snrStr ?? null,
      timeMs: Number.isFinite(parsed) ? parsed : now,
    });
    if (reports.length >= 2000) break;
  }
  return { reports, truncated: reports.length >= 2000 };
}

// ---------------------------------------------------------------------------
// EM weather (SWPC) parsing + MUF intuition
// ---------------------------------------------------------------------------

function latestValid(rows, pick) {
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v !== null && v !== undefined && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** GOES X-ray class from 0.1–0.8 nm flux in W/m². Null-safe: missing data -> null, never 'A'. */
export function classifyGoesXray(fluxWm2) {
  if (fluxWm2 === null || fluxWm2 === undefined || fluxWm2 === '') return null;
  const f = Number(fluxWm2);
  if (!Number.isFinite(f) || f < 0) return null;
  if (f >= 1e-4) return 'X';
  if (f >= 1e-5) return 'M';
  if (f >= 1e-6) return 'C';
  if (f >= 1e-7) return 'B';
  return 'A';
}

/** Subclass digit, e.g. flux 4.6e-7 -> 'B4.6'. */
export function goesSubclass(fluxWm2) {
  const cls = classifyGoesXray(fluxWm2);
  if (!cls) return null;
  const thresholds = { X: 1e-4, M: 1e-5, C: 1e-6, B: 1e-7, A: 1e-8 };
  return `${cls}${(Number(fluxWm2) / thresholds[cls]).toFixed(1)}`;
}

/**
 * Parse the four SWPC summary feeds into one EM-weather state object.
 * Every field is null-tolerant: partial data still yields a usable state.
 */
export function parseEmWeather({ speedRows, magRows, xrayRows, kpRows, sfiRows } = {}) {
  const solarWindKms = latestValid(speedRows, (r) => r?.proton_speed);
  const bzGsm = latestValid(magRows, (r) => r?.bz_gsm);
  const bt = latestValid(magRows, (r) => r?.bt);
  // X-ray long channel (0.1–0.8 nm) is the GOES class channel.
  let xrayFlux = null;
  if (Array.isArray(xrayRows)) {
    for (let i = xrayRows.length - 1; i >= 0; i--) {
      const r = xrayRows[i];
      if (r?.energy === '0.1-0.8nm' && Number.isFinite(Number(r.flux))) {
        xrayFlux = Number(r.flux);
        break;
      }
    }
  }
  const kp = latestValid(kpRows, (r) => r?.kp_index);
  const estimatedKp = latestValid(kpRows, (r) => r?.estimated_kp);
  const sfi = latestValid(sfiRows, (r) => r?.flux);
  return {
    solarWindKms,
    bzGsm,
    bt,
    kp,
    estimatedKp,
    sfi,
    xrayFlux,
    xrayClass: classifyGoesXray(xrayFlux),
    xraySubclass: goesSubclass(xrayFlux),
    fetchedAt: Date.now(),
  };
}

/**
 * MUF *intuition* — a rough heuristic, NOT a measurement.
 *
 * Real MUF comes from ionosonde soundings; this blends day/night geometry,
 * solar flux, geomagnetic activity and flare absorption into a plausible
 * number so the panel can tell a causal story ("sun sneezes → arcs change").
 * Always surfaced with the label MODEL — NEVER presented as observed.
 *
 * Returns { mufMHz, basis: 'intuition', drivers: [...] }.
 */
export function estimateMuf(em, { dayFactor = 0.5 } = {}) {
  const day = Math.max(0, Math.min(1, Number(dayFactor) || 0));
  const sfi = Number.isFinite(em?.sfi) ? em.sfi : 110;
  const kp = Number.isFinite(em?.kp) ? em.kp : 2;
  const xrayClass = em?.xrayClass ?? null;
  const drivers = [];
  // Base: daytime F2 supports higher frequencies; night drops to low bands.
  let muf = 7 + 14 * day;
  drivers.push(day >= 0.5 ? 'daylit ionosphere' : 'night ionosphere');
  // Solar flux lifts the ceiling.
  const sfiTerm = (Math.max(65, Math.min(300, sfi)) - 100) * 0.07;
  muf += sfiTerm;
  if (Math.abs(sfiTerm) >= 1) drivers.push(`SFI ${Math.round(sfi)}`);
  // Geomagnetic storms depress MUF, especially at high latitudes.
  const stormTerm = Math.max(0, kp - 3) * 2.2;
  muf -= stormTerm;
  if (stormTerm > 0) drivers.push(`Kp ${kp} storm depression`);
  // Day-side flare absorption can black out HF entirely for minutes.
  const flaring = (xrayClass === 'M' || xrayClass === 'X') && day > 0.5;
  if (flaring) {
    muf -= 9;
    drivers.push(`${xrayClass}-class flare absorption (day side)`);
  }
  // Sanity bounds: the model is not allowed to claim the absurd.
  const mufMHz = Math.round(Math.max(3, Math.min(60, muf)) * 10) / 10;
  return { mufMHz, basis: 'intuition', drivers, flaring };
}

/** HF bands whose typical working frequency fits under the MUF intuition. */
export function bandsUnderMuf(mufMHz) {
  return BANDS.filter((b) => b.typicalMHz <= mufMHz + 0.5).map((b) => b.name);
}

/**
 * "Best HF bands now" hint. Heuristic: under the MUF intuition, prefer low
 * bands at night (D-layer absorption drops) and high bands by day.
 */
export function bestBandsHint(em, { dayFactor = 0.5 } = {}) {
  const { mufMHz } = estimateMuf(em, { dayFactor });
  const usable = BANDS.filter((b) => b.typicalMHz <= mufMHz + 0.5);
  const night = dayFactor < 0.5;
  const preferred = usable.filter((b) =>
    night ? b.meters >= 30 : b.meters <= 20,
  );
  const picks = (preferred.length ? preferred : usable).slice(-3).map((b) => b.name);
  return { mufMHz, bands: picks, night, basis: 'intuition' };
}

/**
 * One-line EM weather summary with the causality chain spelled out.
 * Pure function of (em, dayFactor) — the panel renders these strings.
 */
export function emWeatherSummary(em, { dayFactor = 0.5 } = {}) {
  const lines = [];
  if (Number.isFinite(em?.solarWindKms)) {
    const v = em.solarWindKms;
    lines.push(
      `Solar wind ${Math.round(v)} km/s — ` +
        (v < 400 ? 'calm breeze' : v < 550 ? 'brisk stream' : 'gale conditions'),
    );
  }
  if (Number.isFinite(em?.kp)) {
    lines.push(
      `Kp ${em.kp} — ` +
        (em.kp <= 3 ? 'quiet geomagnetic field' : em.kp <= 5 ? 'unsettled field' : 'geomagnetic storm'),
    );
  }
  if (em?.xraySubclass) {
    const flaring = em.xrayClass === 'M' || em.xrayClass === 'X';
    lines.push(
      `X-ray ${em.xraySubclass} — ` +
        (flaring ? 'flare in progress; day-side HF may fade' : 'no significant flare'),
    );
  }
  if (Number.isFinite(em?.bzGsm)) {
    lines.push(
      `IMF Bz ${em.bzGsm >= 0 ? '+' : ''}${em.bzGsm.toFixed(1)} nT — ` +
        (em.bzGsm < -5 ? 'southward; coupling into the magnetosphere' : 'not strongly coupling'),
    );
  }
  const hint = bestBandsHint(em, { dayFactor });
  lines.push(
    `Best HF bands now (intuition): ${hint.bands.join(', ') || 'none usable'} — ` +
      `MUF ≈ ${hint.mufMHz} MHz, ${hint.night ? 'night' : 'day'} side favored. ` +
      `Model, not measurement.`,
  );
  return lines;
}

/** Analyst-record shape, consistent with sibling layers. */
export function mapAnalystRecord(summary, index = 0) {
  return {
    id: `invisible-ocean-${index}`,
    type: 'invisible-ocean',
    spotCount: summary?.spotCount ?? null,
    providers: summary?.providers ?? null,
    kp: summary?.em?.kp ?? null,
    solarWindKms: summary?.em?.solarWindKms ?? null,
    timeMs: summary?.timeMs ?? null,
  };
}

export const INVISIBLE_OCEAN_OVERLAY_SOURCE_ID = 'invisible-ocean';
