/**
 * Wave 3 / Track 2a.4 — NOAA SWPC space-weather layer (Wave A ticker, items #1–#6, #13–#14, #16).
 *
 * WHY A PROXY: services.swpc.noaa.gov JSON is public domain and keyless,
 * but the provider normalizes eleven feeds (1-minute planetary Kp, alert
 * products, solar-wind speed, solar-wind B-field, 3-hourly Kp + forecast,
 * NOAA R/S/G scales, GOES X-ray flux, hamqsl solar ticker, SWPC WWV text,
 * GFZ Kp nowcast) into one small document at /api/space-weather, maps Kp
 * to the NOAA G-scale, and keeps a stale cache so the magnetosphere glow
 * never blinks out on a transient upstream failure.
 *
 * Upstream (VERIFIED live 2026-09-27):
 *   https://services.swpc.noaa.gov/json/planetary_k_index_1m.json          (#3)
 *   https://services.swpc.noaa.gov/products/alerts.json                    (alerts)
 *   https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json (#1)
 *   https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json (#2)
 *   https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json   (#4)
 *   https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json (#4)
 *   https://services.swpc.noaa.gov/products/noaa-scales.json               (#5)
 *   https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json      (#6)
 *   https://www.hamqsl.com/solarxml.php                                     (#13, credit N0NBH)
 *   https://services.swpc.noaa.gov/text/wwv.txt                             (#14)
 *   https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_nowcast.txt        (#16)
 * Keyless. Global fetch only; no node:* imports (Pages-safe).
 *
 * Deferred to Wave B item 44 (NOT fetched here): GOES protons/electrons
 * (#7, #8), GOES magnetometers (#9), geoelectric maps (#11), Ovation (#12),
 * SILSO sunspot numbers (#15).
 *
 * REDIRECT POLICY: every fetch passes `redirect: 'follow'`. The repo's
 * 2026-09-27 edge incident showed workerd rejects `redirect: 'error'`;
 * worse, the GFZ nowcast host permanently 301s
 * (kp.gfz-potsdam.de → kp.gfz.de), so 'error' would break that feed by
 * design. Following redirects is the incident-hardened convention.
 *
 * WAVE B ITEM 44 (2026-09-27): the deferred feeds are now fetched
 * best-effort alongside the core:
 *   https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json      (#7)
 *   https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-6-hour.json  (#8)
 *   https://services.swpc.noaa.gov/json/goes/primary/magnetometers-3-day.json        (#9)
 *   https://services.swpc.noaa.gov/products/animations/geoelectric/InterMagEarthScope.json (#11)
 *   https://services.swpc.noaa.gov/json/ovation_aurora_latest.json                    (#12)
 *   https://www.sidc.be/silso/DATA/SN_d_tot_V2.0.txt                                  (#15)
 * The SILSO file is 2.9 MB; it gets a dedicated 4 MB cap and only its tail
 * is parsed. sidc.be was unreachable from the build VM (curl 000) — parsed
 * defensively and treated as best-effort like the other side feeds.
 */
import { readResponseJsonCapped, readResponseTextCapped } from '../common/http.js';

const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';
const SW_SPEED_URL = 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json';
const SW_MAG_URL = 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json';
const KP_3H_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const KP_FORECAST_URL =
  'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';
const SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
const XRAY_URL = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json';
const HAMQSL_URL = 'https://www.hamqsl.com/solarxml.php';
const WWV_URL = 'https://services.swpc.noaa.gov/text/wwv.txt';
const GFZ_URL = 'https://kp.gfz-potsdam.de/app/files/Kp_ap_Ap_SN_F107_nowcast.txt';
// Wave B item 44 — deferred GOES/Ovation/geoelectric/SILSO feeds (2026-09-27).
const PROTONS_URL = 'https://services.swpc.noaa.gov/json/goes/primary/integral-protons-1-day.json';
const ELECTRONS_URL = 'https://services.swpc.noaa.gov/json/goes/primary/integral-electrons-6-hour.json';
const GOES_MAG_URL = 'https://services.swpc.noaa.gov/json/goes/primary/magnetometers-3-day.json';
const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const GEOELECTRIC_URL =
  'https://services.swpc.noaa.gov/products/animations/geoelectric/InterMagEarthScope.json';
const SILSO_URL = 'https://www.sidc.be/silso/DATA/SN_d_tot_V2.0.txt';
const GEOELECTRIC_IMG_BASE = 'https://services.swpc.noaa.gov';
const USER_AGENT = 'satwq-reality-os/1.0 (NOAA SWPC public space weather; contact via repo)';

const CACHE_TTL_MS = 120_000; // Kp updates every minute
const STALE_MS = 30 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const JSON_CAP = 2 * 1024 * 1024;
const TEXT_CAP = 2 * 1024 * 1024;
const SILSO_CAP = 4 * 1024 * 1024; // SN_d_tot_V2.0.txt is 2.9 MB; only the tail is parsed
const MAX_ALERTS = 12;
const KP_3H_POINTS = 8; // 24 h of 3-hourly Kp
const KP_FORECAST_POINTS = 12; // 3 days of predicted Kp
const WWV_TEXT_CAP = 1600;

/** NOAA geomagnetic storm scale from Kp. */
export function kpToGScale(kp) {
  if (!Number.isFinite(kp)) return null;
  if (kp >= 9) return 'G5';
  if (kp >= 8) return 'G4';
  if (kp >= 7) return 'G3';
  if (kp >= 6) return 'G2';
  if (kp >= 5) return 'G1';
  return 'G0';
}

/** Take the latest entry of the 1-minute Kp feed. */
export function parseKpPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('swpc_kp_unexpected_shape');
  const last = doc[doc.length - 1];
  const kp = Number(last?.kp_index);
  const estimated = Number(last?.estimated_kp);
  if (!Number.isFinite(kp)) throw new Error('swpc_kp_missing');
  return {
    kp,
    estimatedKp: Number.isFinite(estimated) ? estimated : null,
    timeTagMs: Date.parse(last?.time_tag),
    gScale: kpToGScale(kp),
  };
}

/** Keep recent alerts, newest first, with a one-line headline. */
export function parseAlertsPayload(doc, now = Date.now()) {
  if (!Array.isArray(doc)) throw new Error('swpc_alerts_unexpected_shape');
  const cutoff = now - 48 * 3600_000;
  return doc
    .map((a) => {
      const issueMs = Date.parse((a?.issue_datetime ?? '').replace(' ', 'T') + 'Z');
      const message = String(a?.message ?? '');
      const headline =
        message
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && !/^(Space Weather Message Code|Serial Number):/i.test(l)) ??
        '';
      const codeMatch = message.match(/Space Weather Message Code:\s*([A-Z0-9]+)/);
      return {
        productId: a?.product_id ?? null,
        code: codeMatch ? codeMatch[1] : null,
        issueMs: Number.isFinite(issueMs) ? issueMs : null,
        headline: headline.trim().slice(0, 220),
      };
    })
    .filter((a) => a.issueMs != null && a.issueMs >= cutoff)
    .sort((a, b) => b.issueMs - a.issueMs)
    .slice(0, MAX_ALERTS);
}

/** Solar-wind proton speed feed: [{ proton_speed, time_tag }] → { speed, timeTagMs }. */
export function parseSolarWindSpeedPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0)
    throw new Error('swpc_swspeed_unexpected_shape');
  const last = doc[doc.length - 1];
  const speed = Number(last?.proton_speed);
  if (!Number.isFinite(speed)) throw new Error('swpc_swspeed_missing');
  return { speed, timeTagMs: Date.parse(last?.time_tag) };
}

/** Solar-wind B-field feed: [{ bt, bz_gsm, time_tag }] → { bt, bz, timeTagMs }. */
export function parseSolarWindMagPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0)
    throw new Error('swpc_swmag_unexpected_shape');
  const last = doc[doc.length - 1];
  const bt = Number(last?.bt);
  const bz = Number(last?.bz_gsm);
  if (!Number.isFinite(bt) || !Number.isFinite(bz)) throw new Error('swpc_swmag_missing');
  return { bt, bz, timeTagMs: Date.parse(last?.time_tag) };
}

/** 3-hourly Kp history: last KP_3H_POINTS entries, chronological. */
export function parseKp3HourPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('swpc_kp3h_unexpected_shape');
  return doc.slice(-KP_3H_POINTS).map((e) => ({
    timeTagMs: Date.parse(e?.time_tag),
    kp: Number(e?.Kp),
  })).filter((e) => Number.isFinite(e.kp) && Number.isFinite(e.timeTagMs));
}

/** Kp forecast: entries the file marks 'predicted', chronological, capped. */
export function parseKpForecastPayload(doc) {
  if (!Array.isArray(doc)) throw new Error('swpc_kpfcst_unexpected_shape');
  return doc
    .filter((e) => e?.observed === 'predicted')
    .slice(0, KP_FORECAST_POINTS)
    .map((e) => ({
      timeTagMs: Date.parse(e?.time_tag),
      kp: Number(e?.kp),
      noaaScale: e?.noaa_scale ?? null,
    }))
    .filter((e) => Number.isFinite(e.kp) && Number.isFinite(e.timeTagMs));
}

/** NOAA R/S/G scales: current scales from key "0", 24h outlook probs from key "1". */
export function parseScalesPayload(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('swpc_scales_unexpected_shape');
  const cur = doc['0'] ?? {};
  const nxt = doc['1'] ?? {};
  const scaleOf = (entry, key) => {
    const s = entry?.[key] ?? {};
    return {
      scale: s.Scale != null ? String(s.Scale) : null,
      text: s.Text != null ? String(s.Text) : null,
    };
  };
  const prob = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    r: scaleOf(cur, 'R'),
    s: scaleOf(cur, 'S'),
    g: scaleOf(cur, 'G'),
    outlook: {
      rMinorProb: prob(nxt?.R?.MinorProb),
      rMajorProb: prob(nxt?.R?.MajorProb),
      sProb: prob(nxt?.S?.Prob),
    },
  };
}

/** GOES X-ray class letter from flux (W/m²): 4.4e-7 → 'B4.4'. */
export function xrayClass(flux) {
  if (!Number.isFinite(flux) || flux <= 0) return null;
  const tiers = [
    ['X', 1e-4],
    ['M', 1e-5],
    ['C', 1e-6],
    ['B', 1e-7],
    ['A', 0],
  ];
  for (const [letter, base] of tiers) {
    if (flux >= base) {
      const denom = base === 0 ? 1e-8 : base;
      return `${letter}${(flux / denom).toFixed(1)}`;
    }
  }
  return null;
}

/** GOES primary X-ray 1-day: latest 0.1–0.8 nm (long-wave) channel reading. */
export function parseXrayPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('swpc_xray_unexpected_shape');
  const long = doc.filter((e) => e?.energy === '0.1-0.8nm');
  if (long.length === 0) throw new Error('swpc_xray_missing_channel');
  const last = long[long.length - 1];
  const flux = Number(last?.flux);
  if (!Number.isFinite(flux)) throw new Error('swpc_xray_missing');
  return { flux, class: xrayClass(flux), timeTagMs: Date.parse(last?.time_tag) };
}

/** Flat-tag regex extraction — Node/workerd have no DOMParser; hamqsl tags are simple. */
function xmlTag(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}\\s*>([^<]*)</${tag}>`, 'i'));
  return m ? m[1].trim() : null;
}

/** hamqsl solarxml.php → { sfi, aIndex, kIndex, updated }. */
export function parseHamqslPayload(xml) {
  const num = (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const sfi = num(xmlTag(xml, 'solarflux'));
  const aIndex = num(xmlTag(xml, 'aindex'));
  const kIndex = num(xmlTag(xml, 'kindex'));
  if (![sfi, aIndex, kIndex].every((v) => v !== null))
    throw new Error('swpc_hamqsl_missing');
  return { sfi, aIndex, kIndex, updated: xmlTag(xml, 'updated') };
}

/** SWPC WWV geophysical alert message → { issued, text }. */
export function parseWwvPayload(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('swpc_wwv_empty');
  const issued = (t.match(/^:Issued:\s*(.+)$/m)?.[1] ?? '').trim() || null;
  return { issued, text: t.slice(0, WWV_TEXT_CAP) };
}

/**
 * GFZ Kp nowcast text: last data line, most recent non-sentinel Kp block.
 * Columns: YYYY MM DD days days_m Bsr dB Kp1..Kp8 ap1..ap8 Ap SN F10.7obs F10.7adj D.
 * Missing data is -1.000 (Kp) / -1 (ap). timeTagMs is the start of the winning
 * 3-hour block (KpN covers (N-1)*3h..N*3h of the UT day).
 */
export function parseGfzPayload(text) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) throw new Error('swpc_gfz_empty');
  const cols = lines[lines.length - 1].split(/\s+/);
  if (cols.length < 27) throw new Error('swpc_gfz_unexpected_shape');
  const dayMs = Date.UTC(Number(cols[0]), Number(cols[1]) - 1, Number(cols[2]));
  if (!Number.isFinite(dayMs)) throw new Error('swpc_gfz_bad_date');
  const kps = cols.slice(7, 15).map(Number);
  const aps = cols.slice(15, 23).map(Number);
  let idx = -1;
  for (let i = 7; i >= 0; i--) {
    if (Number.isFinite(kps[i]) && kps[i] >= 0) {
      idx = i;
      break;
    }
  }
  if (idx < 0) throw new Error('swpc_gfz_no_valid_kp');
  return {
    kp: kps[idx],
    ap: Number.isFinite(aps[idx]) && aps[idx] >= 0 ? aps[idx] : null,
    timeTagMs: dayMs + idx * 3 * 3600_000,
  };
}

/** Try a parse; a broken side feed degrades to null instead of killing the ticker. */
function tryParse(fn, doc) {
  try {
    return doc == null ? null : fn(doc);
  } catch {
    return null;
  }
}

// ——— Wave B item 44 parsers (all pure, exported for tests) ———

/**
 * GOES integral particle feeds (protons #7, electrons #8):
 * rows are {time_tag, satellite, flux, energy} with one row per energy
 * channel per timestamp. Collects every energy channel of the LATEST
 * timestamp: {timeTag, satellite, bands:{">=10 MeV": n}}.
 */
export function parseGoesParticlesPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0) throw new Error('swpc_particles_unexpected_shape');
  let latestTag = null;
  let latestMs = -Infinity;
  for (const e of doc) {
    const ms = Date.parse(e?.time_tag);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latestTag = e?.time_tag;
    }
  }
  if (latestTag == null) throw new Error('swpc_particles_no_time');
  const bands = {};
  let satellite = null;
  for (const e of doc) {
    if (e?.time_tag !== latestTag) continue;
    const energy = String(e?.energy ?? '').trim();
    const flux = Number(e?.flux);
    if (!energy || !Number.isFinite(flux)) continue;
    bands[energy] = flux;
    if (satellite == null && e?.satellite != null) satellite = e.satellite;
  }
  if (Object.keys(bands).length === 0) throw new Error('swpc_particles_missing');
  return { timeTag: latestTag, timeTagMs: latestMs, satellite, bands };
}

/**
 * GOES primary magnetometers #9: rows are
 * {time_tag, satellite, He, Hp, Hn, total, arcjet_flag} → latest row.
 */
export function parseGoesMagnetometersPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0)
    throw new Error('swpc_goesmag_unexpected_shape');
  const last = doc[doc.length - 1];
  const timeTagMs = Date.parse(last?.time_tag);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  if (!Number.isFinite(timeTagMs) || num(last?.total) == null)
    throw new Error('swpc_goesmag_missing');
  return {
    timeTag: last.time_tag,
    timeTagMs,
    satellite: last?.satellite ?? null,
    he: num(last?.He),
    hp: num(last?.Hp),
    hn: num(last?.Hn),
    total: num(last?.total),
    arcjetFlag: last?.arcjet_flag === true,
  };
}

/**
 * Ovation aurora model #12: GeoJSON-ish {Observation Time, Forecast Time,
 * 'Data Format': '[Longitude, Latitude, Aurora]', coordinates:[[lon,lat,a]]}.
 * The 65k-cell grid is summarized (max + active-cell count), never shipped.
 */
export function parseOvationPayload(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('swpc_ovation_unexpected_shape');
  const cells = doc.coordinates;
  if (!Array.isArray(cells) || cells.length === 0) throw new Error('swpc_ovation_no_cells');
  let maxAurora = -Infinity;
  let activeCells = 0;
  for (const c of cells) {
    const a = Number(c?.[2]);
    if (!Number.isFinite(a)) continue;
    if (a > maxAurora) maxAurora = a;
    if (a > 0) activeCells++;
  }
  if (maxAurora === -Infinity) throw new Error('swpc_ovation_no_values');
  return {
    observationTime: doc['Observation Time'] ?? null,
    forecastTime: doc['Forecast Time'] ?? null,
    dataFormat: doc['Data Format'] ?? null,
    totalCells: cells.length,
    activeCells,
    maxAurora,
  };
}

/**
 * Geoelectric animation frames #11: [{url (root-relative), time_tag}] →
 * {count, latest:{url (absolute), timeTag}, frames:[last 12]}.
 */
export function parseGeoelectricPayload(doc) {
  if (!Array.isArray(doc) || doc.length === 0)
    throw new Error('swpc_geoelectric_unexpected_shape');
  const frames = doc
    .map((e) => ({
      url: e?.url ? GEOELECTRIC_IMG_BASE + e.url : null,
      timeTag: e?.time_tag ?? null,
    }))
    .filter((f) => f.url && f.timeTag);
  if (frames.length === 0) throw new Error('swpc_geoelectric_no_frames');
  const tail = frames.slice(-12);
  return { count: frames.length, latest: tail[tail.length - 1], frames: tail };
}

/**
 * SILSO daily sunspot numbers #15 (SN_d_tot_V2.0.txt):
 * columns YYYY MM DD fracYear dailySSN stddev obsNum flag; -1 = missing.
 * Parses the LAST data line of the (2.9 MB) file.
 */
export function parseSilsoPayload(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(
      /^\s*(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d+\.\d+)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s+(\d+)/,
    );
    if (!m) continue;
    const ssn = Number(m[5]);
    return {
      date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`,
      sunspotNumber: ssn >= 0 ? ssn : null,
      stddev: Number(m[6]) >= 0 ? Number(m[6]) : null,
      observations: Number(m[7]),
      definitive: m[8] === '1',
    };
  }
  throw new Error('swpc_silso_no_data_line');
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 2,
    source: 'NOAA SWPC via local proxy (+ hamqsl.com + GFZ)',
    attribution:
      'Space weather data: NOAA SWPC (public domain). Solar ticker: hamqsl.com (N0NBH). ' +
      'Kp nowcast: GFZ Helmholtz Centre (CC BY 4.0).',
    generatedAt: value ? new Date(value.fetchedAt).toISOString() : null,
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    // legacy flat fields (Wave 3 glow + existing clients)
    kp: value?.kp ?? null,
    estimatedKp: value?.estimatedKp ?? null,
    timeTagMs: value?.timeTagMs ?? null,
    gScale: value?.gScale ?? null,
    alerts: value?.alerts ?? [],
    // Wave A ticker blocks (#1–#6, #13–#14, #16); null = that feed was unreachable
    solarWind: value?.solarWind ?? null,
    kpThreeHour: value?.kpThreeHour ?? null,
    kpForecast: value?.kpForecast ?? null,
    scales: value?.scales ?? null,
    xray: value?.xray ?? null,
    hamqsl: value?.hamqsl ?? null,
    wwv: value?.wwv ?? null,
    gfz: value?.gfz ?? null,
    // Wave B item 44 blocks (#7–#9, #11–12, #15)
    goesParticles: value?.goesParticles ?? { protons: null, electrons: null },
    goesMagnetometers: value?.goesMagnetometers ?? null,
    ovation: value?.ovation ?? null,
    geoelectric: value?.geoelectric ?? null,
    silso: value?.silso ?? null,
  };
}

export function swpcProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let cache = null; // { value, fetchedAt }
  let operation = null;
  let attemptedAt = -Infinity;

  const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' };

  async function fetchUpstream(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { signal, redirect: 'follow', headers });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`swpc_upstream_http_${response.status}`);
    }
    return response;
  }

  async function upstreamJson(url, signal) {
    const response = await fetchUpstream(url, signal);
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    return doc;
  }

  async function upstreamText(url, signal, cap = TEXT_CAP) {
    const response = await fetchUpstream(url, signal);
    const text = await readResponseTextCapped(response, cap, signal);
    signal.throwIfAborted();
    return text;
  }

  async function refresh(signal) {
    const maybe = (promise) => promise.catch(() => null); // side feeds are best-effort
    const [
      kpDoc,
      alertsDoc,
      speedDoc,
      magDoc,
      kp3Doc,
      fcstDoc,
      scalesDoc,
      xrayDoc,
      hamqslXml,
      wwvText,
      gfzText,
      // Wave B item 44 — all best-effort; failures degrade to null below.
      protonsDoc,
      electronsDoc,
      goesMagDoc,
      ovationDoc,
      geoelectricDoc,
      silsoText,
    ] = await Promise.all([
      upstreamJson(KP_URL, signal), // REQUIRED — the core of this route
      maybe(upstreamJson(ALERTS_URL, signal)),
      maybe(upstreamJson(SW_SPEED_URL, signal)),
      maybe(upstreamJson(SW_MAG_URL, signal)),
      maybe(upstreamJson(KP_3H_URL, signal)),
      maybe(upstreamJson(KP_FORECAST_URL, signal)),
      maybe(upstreamJson(SCALES_URL, signal)),
      maybe(upstreamJson(XRAY_URL, signal)),
      maybe(upstreamText(HAMQSL_URL, signal)),
      maybe(upstreamText(WWV_URL, signal)),
      maybe(upstreamText(GFZ_URL, signal)),
      maybe(upstreamJson(PROTONS_URL, signal)),
      maybe(upstreamJson(ELECTRONS_URL, signal)),
      maybe(upstreamJson(GOES_MAG_URL, signal)),
      maybe(upstreamJson(OVATION_URL, signal)),
      maybe(upstreamJson(GEOELECTRIC_URL, signal)),
      maybe(upstreamText(SILSO_URL, signal, SILSO_CAP)),
    ]);
    signal.throwIfAborted();
    const kp = parseKpPayload(kpDoc); // throws → refresh fails → stale-cache path
    let alerts = [];
    try {
      alerts = parseAlertsPayload(alertsDoc ?? [], now());
    } catch {
      alerts = [];
    }
    const speed = tryParse(parseSolarWindSpeedPayload, speedDoc);
    const mag = tryParse(parseSolarWindMagPayload, magDoc);
    const value = {
      ...kp,
      alerts,
      fetchedAt: now(),
      solarWind:
        speed || mag
          ? {
              speed: speed?.speed ?? null,
              bt: mag?.bt ?? null,
              bz: mag?.bz ?? null,
              timeTagMs: speed?.timeTagMs ?? mag?.timeTagMs ?? null,
            }
          : null,
      kpThreeHour: tryParse(parseKp3HourPayload, kp3Doc),
      kpForecast: tryParse(parseKpForecastPayload, fcstDoc),
      scales: tryParse(parseScalesPayload, scalesDoc),
      xray: tryParse(parseXrayPayload, xrayDoc),
      hamqsl: tryParse(parseHamqslPayload, hamqslXml),
      wwv: tryParse(parseWwvPayload, wwvText),
      gfz: tryParse(parseGfzPayload, gfzText),
      // Wave B item 44 blocks (#7–#9, #11–12, #15); null = that feed was unreachable
      goesParticles: {
        protons: tryParse(parseGoesParticlesPayload, protonsDoc),
        electrons: tryParse(parseGoesParticlesPayload, electronsDoc),
      },
      goesMagnetometers: tryParse(parseGoesMagnetometersPayload, goesMagDoc),
      ovation: tryParse(parseOvationPayload, ovationDoc),
      geoelectric: tryParse(parseGeoelectricPayload, geoelectricDoc),
      silso: tryParse(parseSilsoPayload, silsoText),
    };
    cache = { value, fetchedAt: value.fetchedAt };
    return { value, stale: false };
  }

  async function acquire(signal) {
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) {
      return { value: cache.value, stale: false };
    }
    signal.throwIfAborted();
    if (!operation) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS) throw new Error('swpc_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      operation = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        operation = null;
      });
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      operation.then(detach, detach); // both branches resolve: never an unhandled rejection
    });
    return Promise.race([operation, cancelled]);
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      try {
        const { value, stale } = await acquire(controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache.value, { stale: true, reason: 'SWPC unreachable; showing last reading.' })
            : describe(null, { reason: 'NOAA SWPC unreachable and no cached reading exists.' }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'swpc',
    configureServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/space-weather', handler);
    },
  };
}
