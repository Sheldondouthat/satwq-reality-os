/**
 * Wave 3 — S6 RIVER fused verdict record (GET /api/fusion-river).
 * Filed beside glenLyn.js, whose WDFN parser it reuses, so the record
 * ships on BOTH stacks under the dual-registry rule (the wave-9
 * synthesis family it conceptually joins is Pages-only today — the
 * U-6 divergence — and a first-class endpoint does not inherit it).
 *
 * The first fused artifact God's Eye has ever produced (Delta Sweep II
 * §5 build #2): one verdict record for the New River at Glen Lyn, VA,
 * built ONLY from legs that ship as GEV endpoints today, per the
 * fusion atlas's S6 definition (atlas-fusion.md) and X-Ray Fusion v6
 * law — fused output inherits the WEAKEST confidence of its
 * load-bearing inputs, and disagreement is drawn, never averaged away.
 *
 * Legs (each verified live in production 2026-11-15 before building):
 *   gauge    USGS Glen Lyn 03176500 via WDFN latest-continuous — the
 *            same upstream the shipped /api/usgs-water-glen-lyn serves
 *            (registry record glen-lyn-03176500 v0.2.0). Truth-anchor,
 *            LOAD-BEARING, Measured, max-age 3,600 s (registry v2).
 *            Its own recent series (WDFN continuous) gives the trend.
 *   upstream The Giles station set's upstream half — New River at
 *            Allisonia 03168000 + Radford 03171000 (mainstem) and
 *            Walker Creek 03173000 + Wolf Creek 03175500 (tributaries)
 *            via WDFN latest-continuous; the same readings the shipped
 *            /api/usgs-water-newriver-valley bundle serves over
 *            WaterServices (values verified identical on both paths).
 *            Upstream-lead (P6), LOAD-BEARING, Measured; per-gage
 *            staleness at the bundle's own D-4 rule (24 h).
 *   radar    RainViewer precipitation radar index — the shipped
 *            client-direct layer's own source. Mortar, LOAD-BEARING.
 *            The leg contributes the latest frame's timestamp only:
 *            tiles are images, and this record does not pretend to
 *            read rainfall amounts out of them. Class Modeled (an
 *            aggregator's mosaicked composite), max-age 1,800 s.
 *   alerts   NWS active alerts for Virginia — the upstream of the
 *            shipped /api/nws-alerts-va. Trigger, enhancement (not
 *            load-bearing), Measured (official NWS product).
 *   snowpack USDA SNOTEL — EXCLUDED, named on every record: the
 *            shipped /api/snotel endpoint is live but pins an
 *            18-station WESTERN spread; Virginia has zero SNOTEL
 *            stations (the atlas premise was corrected in canon), so
 *            the leg carries no upstream-lead signal for this reach.
 *            Excluded by geography — never stubbed, never borrowed.
 *
 * Verdict grammar: stage vs the registry thresholds — ≥15 ft FLOOD
 * (NWS flood stage for this gauge), ≥13 ft CAUTION (a LOCAL rule from
 * river_bot, labeled as such wherever it appears), else NORMAL. The
 * verdict is a threshold function of the anchor gauge alone; the
 * other legs corroborate, contest, or degrade — they never move the
 * number. Stage/discharge on the record are the gauge endpoint's own
 * values for the same dataTime, never a smoothed substitute.
 *
 * Confidence (the ladder is printed on the record): base = weakest
 * class among PRESENT load-bearing legs (gauge/upstream Measured,
 * radar Modeled → base Modeled on a full house); every leg that is
 * stale, degraded, or missing drops the fused class one step (floor
 * Estimated) and is named in confidence.degradedBecause. Two-tone
 * honesty per atlas S6: confidence.atAnchor stays Measured — the
 * fused label governs the record, the anchor keeps its own class on
 * its own leg line. A missing anchor means NO verdict: the record
 * says so (verdict: null) rather than fabricating one.
 *
 * Disagreement is drawn: an active Giles flood alert under a calm
 * gauge (alert ahead of the water), a caution/flood gauge with no
 * alert (the local rule speaking first), an upstream mainstem
 * carrying ≥15% more water than Glen Lyn (P6 lead — a rise in
 * transit, labeled inference), and freshness divergence between
 * load-bearing legs are each emitted as named disagreement entries.
 *
 * Honesty rules (Liveness Law): every age is computed from the DATA's
 * own timestamp, never from generatedAt; legs are fetched in parallel
 * (allSettled — never sequential timeouts); a failed leg is a named
 * missing leg, never a silent hole; on total anchor failure with no
 * cached round, the route answers 502 — a fused record without its
 * anchor is not a record.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * no node: imports, no WASM). USGS data are U.S. public domain; NWS
 * data are public; RainViewer is personal/educational use with
 * attribution (its atlas terms) — this record is exactly that use.
 */

import { parseGlenLynPayload } from './glenLyn.js';
import { parseNwsAlerts } from '../wave6/alerts.js';

const GAUGE_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?monitoring_location_number=03176500&parameter_code=00060,00065';
const TREND_COLLECTION =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?monitoring_location_number=03176500&parameter_code=00065&limit=200';
const UPSTREAM_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?monitoring_location_number=03168000,03171000,03173000,03175500&parameter_code=00060';
const ALERTS_URL = 'https://api.weather.gov/alerts/active?area=VA';
const RADAR_URL = 'https://api.rainviewer.com/public/weather-maps.json';

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const ALERTS_CAP_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 300_000; // gauge cadence is 900 s; 5-min cache is polite and fresher

const SITE = '03176500';
const SITE_NAME = 'NEW RIVER AT GLEN LYN, VA';
const CAUTION_FT = 13.0; // local rule (river_bot), labeled as such wherever used
const FLOOD_STAGE_FT = 15.0; // NWS flood stage for this gauge

const GAUGE_MAX_AGE_SECONDS = 3600; // registry record v2 freshness.max_age_seconds
const UPSTREAM_MAX_AGE_SECONDS = 86_400; // the bundle's per-gage D-4 rule (24 h)
const RADAR_MAX_AGE_SECONDS = 1800; // ~3 missed 10-min frames

const TREND_LOOKBACK_MS = 3 * 3600_000;
const TREND_TOLERANCE_MS = 45 * 60_000;
const TREND_DEADBAND_FT = 0.02;
const LEAD_RATIO = 1.15; // upstream mainstem carrying ≥15% more water = a rise in transit
const RECEDE_RATIO = 0.85;

const USER_AGENT = 'Gods Eye View (S6 RIVER fusion context)';

// The upstream half of the Giles station set (atlas-fusion S6 row).
// Names are the stations' canonical NWIS names (as served by the
// shipped basin bundle); WDFN latest-continuous carries no name field.
const UPSTREAM_STATIONS = [
  {
    site: '03168000',
    name: 'NEW RIVER AT ALLISONIA, VA',
    role: 'mainstem-upstream',
  },
  {
    site: '03171000',
    name: 'NEW RIVER AT RADFORD, VA',
    role: 'mainstem-upstream',
  },
  {
    site: '03173000',
    name: 'WALKER CREEK AT BANE, VA',
    role: 'tributary-upstream',
  },
  {
    site: '03175500',
    name: 'WOLF CREEK NEAR NARROWS, VA',
    role: 'tributary-upstream',
  },
];

const CLASS_ORDER = { Estimated: 1, Modeled: 2, Measured: 3 };
const CLASS_BY_ORDER = { 1: 'Estimated', 2: 'Modeled', 3: 'Measured' };

let cache = null; // {at, inputs}
let inflight = null;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchTextCapped(
  url,
  capBytes = BODY_CAP_BYTES,
  accept = 'application/json',
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok)
      throw Object.assign(new Error(`fusion_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('fusion_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function num(value, decimals) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function toIsoUtc(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function ageSecondsAt(isoTime, nowMs) {
  const ms = Date.parse(isoTime);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 1000));
}

// ---------------------------------------------------------------------------
// Leg parsers (pure, exported for tests)
// ---------------------------------------------------------------------------

/** WDFN latest-continuous multi-station payload → named gage readings. */
export function parseUpstreamPayload(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const features = Array.isArray(doc?.features) ? doc.features : [];
  const bySite = new Map();
  for (const feature of features) {
    const p = feature?.properties || {};
    if (p.parameter_code !== '00060') continue;
    const id = String(p.monitoring_location_id ?? '');
    const site = id.replace(/^USGS-/, '');
    const value = num(p.value, 1);
    const time = toIsoUtc(p.time);
    if (!site || value == null || time == null) continue;
    bySite.set(site, {
      dischargeCfs: value,
      time,
      approvalStatus:
        typeof p.approval_status === 'string' ? p.approval_status : null,
    });
  }
  return UPSTREAM_STATIONS.map((station) => ({
    ...station,
    ...(bySite.get(station.site) ?? {
      dischargeCfs: null,
      time: null,
      approvalStatus: null,
    }),
  }));
}

/** WDFN continuous payload → sorted [{time, value}] stage series. */
export function parseTrendSeries(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const features = Array.isArray(doc?.features) ? doc.features : [];
  const points = [];
  for (const feature of features) {
    const p = feature?.properties || {};
    if (p.parameter_code !== '00065') continue;
    const value = num(p.value, 2);
    const time = toIsoUtc(p.time);
    if (value == null || time == null) continue;
    points.push({ time, value });
  }
  points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return points;
}

/**
 * Trend of the anchor's own series: latest point vs the point closest
 * to (latest − 3 h). A derivative of the gauge leg, not a second
 * witness — labeled as such on the record.
 */
export function computeTrend(series) {
  if (!Array.isArray(series) || series.length < 2)
    return {
      direction: 'UNKNOWN',
      deltaFt: null,
      overHours: null,
      fromTime: null,
      toTime: null,
      reason:
        'the anchor series carries fewer than two points in the lookback window',
    };
  const latest = series[series.length - 1];
  const targetMs = Date.parse(latest.time) - TREND_LOOKBACK_MS;
  let best = null;
  for (const point of series) {
    const dist = Math.abs(Date.parse(point.time) - targetMs);
    if (dist <= TREND_TOLERANCE_MS && (!best || dist < best.dist))
      best = { point, dist };
  }
  if (!best)
    return {
      direction: 'UNKNOWN',
      deltaFt: null,
      overHours: null,
      fromTime: null,
      toTime: latest.time,
      reason: 'no series point within ±45 min of the 3 h lookback target',
    };
  const delta = num(latest.value - best.point.value, 2);
  const direction =
    delta > TREND_DEADBAND_FT
      ? 'RISING'
      : delta < -TREND_DEADBAND_FT
        ? 'FALLING'
        : 'STEADY';
  return {
    direction,
    deltaFt: delta,
    overHours: num(
      (Date.parse(latest.time) - Date.parse(best.point.time)) / 3600_000,
      2,
    ),
    fromTime: best.point.time,
    toTime: latest.time,
    reason: null,
  };
}

/** RainViewer index → latest past radar frame (the leg's whole claim). */
export function parseRadarIndex(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const past = Array.isArray(doc?.radar?.past) ? doc.radar.past : [];
  const times = past
    .map((f) => Number(f?.time))
    .filter((t) => Number.isFinite(t) && t > 0);
  if (!times.length) return { latestFrameTime: null, frameCount: 0 };
  const latestSec = Math.max(...times);
  return {
    latestFrameTime: new Date(latestSec * 1000).toISOString(),
    frameCount: times.length,
  };
}

const FLOOD_EVENT_RE = /flood|hydrolog/i;

/** Trimmed NWS alerts (parseNwsAlerts shape) → the record's alert facts. */
export function classifyAlerts(alerts) {
  const items = Array.isArray(alerts) ? alerts : [];
  const gilesAlerts = items.filter((a) => /giles/i.test(a.area ?? ''));
  const gilesFloodAlerts = gilesAlerts.filter((a) =>
    FLOOD_EVENT_RE.test(a.event ?? ''),
  );
  return {
    virginiaActiveCount: items.length,
    gilesFloodAlertActive: gilesFloodAlerts.length > 0,
    gilesAlerts: gilesAlerts.map((a) => ({
      event: a.event,
      severity: a.severity,
      headline: a.headline,
      effective: a.effective ?? null,
      expires: a.expires ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// The fused record (pure: leg inputs + now → record)
// ---------------------------------------------------------------------------

function buildGaugeLeg(gauge, nowMs) {
  if (!gauge)
    return {
      id: 'gauge',
      role: 'truth-anchor',
      loadBearing: true,
      status: 'missing',
      confidenceClass: 'Measured',
      source:
        'USGS WDFN latest-continuous via /api/usgs-water-glen-lyn (registry record glen-lyn-03176500 v0.2.0)',
      dataTime: null,
      ageSeconds: null,
      maxAgeSeconds: GAUGE_MAX_AGE_SECONDS,
      stale: null,
      values: null,
    };
  const times = [gauge.gageHeight?.time, gauge.discharge?.time]
    .filter(Boolean)
    .map((t) => Date.parse(t));
  const dataTime = new Date(Math.min(...times)).toISOString();
  const age = ageSecondsAt(dataTime, nowMs);
  const stale = age > GAUGE_MAX_AGE_SECONDS;
  return {
    id: 'gauge',
    role: 'truth-anchor',
    loadBearing: true,
    status: stale ? 'stale' : 'ok',
    confidenceClass: 'Measured',
    source:
      'USGS WDFN latest-continuous via /api/usgs-water-glen-lyn (registry record glen-lyn-03176500 v0.2.0)',
    dataTime,
    ageSeconds: age,
    maxAgeSeconds: GAUGE_MAX_AGE_SECONDS,
    stale,
    values: {
      gageHeightFt: gauge.gageHeight ? gauge.gageHeight.value : null,
      dischargeCfs: gauge.discharge ? gauge.discharge.value : null,
      approvalStatus:
        gauge.gageHeight?.approvalStatus ??
        gauge.discharge?.approvalStatus ??
        null,
    },
  };
}

function buildUpstreamLeg(gages, nowMs) {
  const base = {
    id: 'upstream',
    role: 'upstream-lead',
    loadBearing: true,
    confidenceClass: 'Measured',
    source:
      'USGS WDFN latest-continuous — the readings /api/usgs-water-newriver-valley serves over WaterServices (dual-path agreement verified 2026-11-15)',
    maxAgeSeconds: UPSTREAM_MAX_AGE_SECONDS,
  };
  if (!gages)
    return {
      ...base,
      status: 'missing',
      stale: null,
      dataTime: null,
      ageSeconds: null,
      values: null,
    };
  const rows = gages.map((g) => {
    const age = g.time ? ageSecondsAt(g.time, nowMs) : null;
    return {
      site: g.site,
      name: g.name,
      role: g.role,
      dischargeCfs: g.dischargeCfs,
      dataTime: g.time,
      ageSeconds: age,
      stale: g.time == null ? null : age > UPSTREAM_MAX_AGE_SECONDS,
      approvalStatus: g.approvalStatus,
    };
  });
  const present = rows.filter((r) => r.dischargeCfs != null);
  const anyStale = rows.some((r) => r.stale === true);
  const status = !present.length
    ? 'missing'
    : present.length < rows.length || anyStale
      ? 'degraded'
      : 'ok';
  const newest = present
    .map((r) => r.dataTime)
    .filter(Boolean)
    .sort()
    .pop();
  return {
    ...base,
    status,
    stale: status === 'ok' ? false : anyStale || null,
    dataTime: newest ?? null,
    ageSeconds: newest ? ageSecondsAt(newest, nowMs) : null,
    values: { gages: rows },
  };
}

function buildRadarLeg(radar, nowMs) {
  const base = {
    id: 'rain-radar',
    role: 'mortar',
    loadBearing: true,
    confidenceClass: 'Modeled',
    source:
      'RainViewer precipitation radar index (the shipped client-direct layer\u2019s source); frame timestamp only — this record reads no rainfall amounts out of tile images',
    maxAgeSeconds: RADAR_MAX_AGE_SECONDS,
  };
  if (!radar || !radar.latestFrameTime)
    return {
      ...base,
      status: 'missing',
      stale: null,
      dataTime: null,
      ageSeconds: null,
      values: null,
    };
  const age = ageSecondsAt(radar.latestFrameTime, nowMs);
  const stale = age > RADAR_MAX_AGE_SECONDS;
  return {
    ...base,
    status: stale ? 'stale' : 'ok',
    stale,
    dataTime: radar.latestFrameTime,
    ageSeconds: age,
    values: {
      latestFrameTime: radar.latestFrameTime,
      pastFrameCount: radar.frameCount,
    },
  };
}

function buildAlertsLeg(alertFacts, fetchedAtIso) {
  const base = {
    id: 'alerts',
    role: 'trigger',
    loadBearing: false,
    confidenceClass: 'Measured',
    source:
      'NWS active alerts, Virginia — the upstream of /api/nws-alerts-va (api.weather.gov)',
    maxAgeSeconds: null,
  };
  if (!alertFacts)
    return {
      ...base,
      status: 'missing',
      stale: null,
      dataTime: null,
      ageSeconds: null,
      values: null,
    };
  return {
    ...base,
    status: 'ok',
    stale: false,
    dataTime: fetchedAtIso,
    ageSeconds: 0,
    values: alertFacts,
  };
}

const SNOTEL_EXCLUSION = {
  id: 'snowpack-snotel',
  role: 'upstream-lead (seasonal)',
  reason:
    'Excluded by geography: the shipped /api/snotel endpoint is live but pins an 18-station western-US spread (CA/CO/ID/MT/NV/OR/UT/WA/WY) — Virginia has zero SNOTEL stations, so the leg carries no upstream-lead signal for the New River at Glen Lyn. Named, never stubbed, never borrowed from another basin.',
  evidence:
    'GET /api/snotel on 2026-11-15: count 18, states CA CO ID MT NV OR UT WA WY, VA stations: none.',
};

/**
 * Build the S6 verdict record from leg inputs. Pure and exported for
 * tests: inputs = {gauge, trendSeries, upstream, radar, alerts,
 * alertsFetchedAt} where each leg is its parsed shape or null (fetch
 * failed / no data). The verdict is a threshold function of the
 * anchor gauge alone; legs corroborate, contest, or degrade.
 */
export function buildFusionRecord(inputs, nowMs = Date.now()) {
  const gaugeLeg = buildGaugeLeg(inputs.gauge, nowMs);
  const upstreamLeg = buildUpstreamLeg(inputs.upstream, nowMs);
  const radarLeg = buildRadarLeg(inputs.radar, nowMs);
  const alertsLeg = buildAlertsLeg(
    inputs.alerts,
    inputs.alertsFetchedAt ?? null,
  );
  const legs = [gaugeLeg, upstreamLeg, radarLeg, alertsLeg];

  const trend = computeTrend(inputs.trendSeries);
  const stageFt = gaugeLeg.values?.gageHeightFt ?? null;
  const dischargeCfs = gaugeLeg.values?.dischargeCfs ?? null;

  let verdict = null;
  if (stageFt != null) {
    const condition =
      stageFt >= FLOOD_STAGE_FT
        ? 'FLOOD'
        : stageFt >= CAUTION_FT
          ? 'CAUTION'
          : 'NORMAL';
    verdict = {
      condition,
      stageFt,
      dischargeCfs,
      dataTime: gaugeLeg.dataTime,
      trend,
      thresholds: {
        cautionFt: CAUTION_FT,
        cautionSource:
          'LOCAL RULE (river_bot) — a bot-local caution band, not an official stage',
        floodStageFt: FLOOD_STAGE_FT,
        floodStageSource: 'NWS flood stage for gauge 03176500',
      },
      stale: gaugeLeg.stale === true,
    };
  }

  // ——— Corroboration & disagreement: drawn, never averaged away ———
  const corroborations = [];
  const disagreements = [];
  const alertFacts = alertsLeg.values;
  if (verdict && alertFacts) {
    if (alertFacts.gilesFloodAlertActive && verdict.condition === 'FLOOD') {
      corroborations.push({
        kind: 'ALERT_GAUGE_AGREEMENT',
        detail: `NWS carries an active flood alert for Giles County and the gauge is at/above flood stage (${stageFt} ft) — the two witnesses agree.`,
      });
    } else if (
      alertFacts.gilesFloodAlertActive &&
      verdict.condition === 'NORMAL'
    ) {
      disagreements.push({
        kind: 'ALERT_AHEAD_OF_GAUGE',
        detail: `NWS carries an active flood alert for Giles County while the gauge reads ${stageFt} ft — ${(FLOOD_STAGE_FT - stageFt).toFixed(2)} ft below flood stage. The alert is ahead of the water (upstream lead or a watch issued early); the disagreement is the headline, not a rounding problem.`,
      });
    } else if (
      !alertFacts.gilesFloodAlertActive &&
      verdict.condition !== 'NORMAL'
    ) {
      disagreements.push({
        kind: 'GAUGE_AHEAD_OF_ALERTS',
        detail: `The gauge reads ${stageFt} ft (${verdict.condition}) and NWS has no flood alert for Giles County — the local thresholds are speaking before the official product.`,
      });
    } else if (
      !alertFacts.gilesFloodAlertActive &&
      verdict.condition === 'NORMAL'
    ) {
      corroborations.push({
        kind: 'ALERT_GAUGE_AGREEMENT',
        detail: `NWS has no flood alert for Giles County and the gauge agrees — ${stageFt} ft is ${(FLOOD_STAGE_FT - stageFt).toFixed(2)} ft below flood stage.`,
      });
    }
  }
  if (verdict && upstreamLeg.values) {
    const radford = upstreamLeg.values.gages.find((g) => g.site === '03171000');
    if (
      radford &&
      radford.dischargeCfs != null &&
      radford.stale === false &&
      dischargeCfs != null &&
      dischargeCfs > 0
    ) {
      const ratio = radford.dischargeCfs / dischargeCfs;
      if (ratio >= LEAD_RATIO) {
        disagreements.push({
          kind: 'UPSTREAM_LEAD',
          detail: `Radford (mainstem upstream) is carrying ${radford.dischargeCfs} ft\u00B3/s vs Glen Lyn's ${dischargeCfs} ft\u00B3/s (${Math.round(ratio * 100)}%) — a rise is in transit downstream (P6 upstream lead; inference from two Measured anchors, not a forecast).`,
        });
      } else if (ratio <= RECEDE_RATIO && verdict.condition === 'NORMAL') {
        corroborations.push({
          kind: 'UPSTREAM_RECEDING',
          detail: `Radford is carrying ${radford.dischargeCfs} ft\u00B3/s vs Glen Lyn's ${dischargeCfs} ft\u00B3/s (${Math.round(ratio * 100)}%) — the reach is draining, not loading.`,
        });
      }
    }
  }
  const staleLoadBearing = legs.filter(
    (l) => l.loadBearing && l.status === 'stale',
  );
  if (gaugeLeg.status === 'ok' && staleLoadBearing.length) {
    for (const leg of staleLoadBearing) {
      disagreements.push({
        kind: 'FRESHNESS_DIVERGENCE',
        detail: `The ${leg.id} leg is STALE (age ${leg.ageSeconds} s vs max-age ${leg.maxAgeSeconds} s) while the gauge is fresh — the corroboration is older than the claim it would support.`,
      });
    }
  }

  // ——— Confidence: weakest load-bearing link, degraded by name ———
  const degradedBecause = [];
  for (const leg of legs) {
    if (leg.status === 'missing')
      degradedBecause.push(`${leg.id} leg missing (fetch failed or no data)`);
    else if (leg.status === 'stale')
      degradedBecause.push(
        `${leg.id} leg stale (age ${leg.ageSeconds} s > max-age ${leg.maxAgeSeconds} s)`,
      );
    else if (leg.status === 'degraded')
      degradedBecause.push(
        `${leg.id} leg degraded (a named gage is absent or stale)`,
      );
  }
  let confidence;
  if (!verdict) {
    confidence = {
      fused: null,
      atAnchor: null,
      weakestLink: 'gauge',
      degradedBecause: [
        'gauge leg missing — no verdict is issued without its anchor',
      ],
    };
  } else {
    const presentLoadBearing = legs.filter(
      (l) => l.loadBearing && l.status !== 'missing',
    );
    const baseOrder = Math.min(
      ...presentLoadBearing.map((l) => CLASS_ORDER[l.confidenceClass]),
    );
    const fusedOrder = Math.max(1, baseOrder - degradedBecause.length);
    const missingLoadBearing = legs.find(
      (l) => l.loadBearing && l.status === 'missing',
    );
    const staleLoadBearingLeg = legs.find(
      (l) => l.loadBearing && l.status === 'stale',
    );
    const weakestPresent = presentLoadBearing.reduce((a, b) =>
      CLASS_ORDER[a.confidenceClass] <= CLASS_ORDER[b.confidenceClass] ? a : b,
    );
    confidence = {
      fused: CLASS_BY_ORDER[fusedOrder],
      atAnchor: 'Measured',
      weakestLink: (missingLoadBearing ?? staleLoadBearingLeg ?? weakestPresent)
        .id,
      degradedBecause,
    };
  }

  return {
    id: 'fusion-river',
    stack: 'S6 RIVER',
    title: 'S6 RIVER — fused verdict: New River at Glen Lyn, VA (03176500)',
    source:
      'God\u2019s Eye S6 RIVER fusion (X-Ray Fusion v6, patterns P3/P6) over shipped GEV legs',
    attribution:
      'Data: U.S. Geological Survey, NWIS (public domain) · National Weather Service (public) · RainViewer (attribution; personal/educational use per its terms).',
    generatedAt: new Date(nowMs).toISOString(),
    station: {
      site: SITE,
      name: SITE_NAME,
      lat: inputs.gauge?.lat ?? 37.3728986,
      lon: inputs.gauge?.lon ?? -80.8606347,
    },
    verdict,
    legs,
    legsExcluded: [SNOTEL_EXCLUSION],
    corroborations,
    disagreements,
    confidence,
    weakestLink: confidence.weakestLink,
    degraded: !verdict || degradedBecause.length > 0,
    note: 'The first fused record in God\u2019s Eye (Delta Sweep II \u00A75 build #2). The verdict is a threshold function of the anchor gauge alone (NWS flood stage 15 ft; caution 13 ft is a labeled local rule); stage/discharge are the gauge endpoint\u2019s own values for dataTime, never smoothed. Fused confidence inherits the weakest load-bearing leg (radar, Modeled) and drops one class per stale/degraded/missing leg, each named in confidence.degradedBecause; the anchor fact keeps its Measured class on its own leg line (atlas S6 two-tone honesty). Disagreement between legs is drawn in disagreements[], never averaged away.',
  };
}

// ---------------------------------------------------------------------------
// Fetch round (parallel — allSettled, never sequential timeouts)
// ---------------------------------------------------------------------------

function trendUrl(nowMs) {
  const start = new Date(nowMs - 7 * 3600_000).toISOString();
  const end = new Date(nowMs + 3600_000).toISOString();
  return `${TREND_COLLECTION}&datetime=${encodeURIComponent(`${start}/${end}`)}`;
}

async function fetchLegs() {
  const nowMs = Date.now();
  const [gaugeR, trendR, upstreamR, alertsR, radarR] = await Promise.allSettled(
    [
      fetchTextCapped(
        GAUGE_URL,
        BODY_CAP_BYTES,
        'application/geo+json, application/json',
      ),
      fetchTextCapped(
        trendUrl(nowMs),
        BODY_CAP_BYTES,
        'application/geo+json, application/json',
      ),
      fetchTextCapped(
        UPSTREAM_URL,
        BODY_CAP_BYTES,
        'application/geo+json, application/json',
      ),
      fetchTextCapped(
        ALERTS_URL,
        ALERTS_CAP_BYTES,
        'application/geo+json, application/json',
      ),
      fetchTextCapped(RADAR_URL),
    ],
  );
  const settled = (r, parse) => {
    if (r.status !== 'fulfilled') return null;
    try {
      return parse(r.value);
    } catch {
      return null;
    }
  };
  return {
    gauge: settled(gaugeR, (t) => parseGlenLynPayload(t)),
    trendSeries: settled(trendR, (t) => parseTrendSeries(t)),
    upstream: settled(upstreamR, (t) => parseUpstreamPayload(t)),
    alerts: settled(alertsR, (t) =>
      classifyAlerts(parseNwsAlerts(JSON.parse(t))),
    ),
    alertsFetchedAt:
      alertsR.status === 'fulfilled' ? new Date().toISOString() : null,
    radar: settled(radarR, (t) => parseRadarIndex(t)),
  };
}

async function getInputs() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.inputs;
  if (!inflight) {
    inflight = fetchLegs()
      .then((inputs) => {
        // A round whose anchor failed never overwrites a good round:
        // the record rebuilds from the last good inputs and its ages —
        // computed at serve time — tell the truth about their staleness.
        if (inputs.gauge || !cache) cache = { at: Date.now(), inputs };
        return cache.inputs;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the S6 RIVER fused verdict record. */
export function fusionRiverProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const inputs = await getInputs();
      if (!inputs.gauge) {
        return sendJson(
          res,
          502,
          {
            error: 'fusion_river_unavailable',
            detail:
              'the anchor gauge leg (USGS WDFN latest-continuous for 03176500) could not be fetched and no cached round exists — a fused record without its anchor is not a record',
          },
          'no-store',
        );
      }
      sendJson(res, 200, buildFusionRecord(inputs, Date.now()));
    } catch (error) {
      sendJson(
        res,
        500,
        { error: 'fusion_river_failed', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }

  return {
    name: 'fusion-river',
    configureServer({ middlewares }) {
      middlewares.use('/api/fusion-river', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fusion-river', handler);
    },
  };
}

export const _fusionRiverInternals = {
  parseUpstreamPayload,
  parseTrendSeries,
  computeTrend,
  parseRadarIndex,
  classifyAlerts,
  buildFusionRecord,
  SNOTEL_EXCLUSION,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
