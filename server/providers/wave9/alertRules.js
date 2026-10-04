/**
 * Wave 9 — Alert rules engine + ntfy publish wiring (GET /api/alert-rules).
 *
 * Evaluates a small pinned set of alert rules against keyless public
 * upstreams and exposes the currently-firing set as JSON. A companion
 * script (scripts/alerts-publish.mjs, run by .github/workflows/alerts-publish.yml
 * every 15 min) diffs this route's `firings` against its seen-state and POSTs
 * new firings to an ntfy.sh topic. The route itself is GET-only and never
 * publishes anything.
 *
 * RULES (all keyless, all verified live from the build VM 2026-10-04):
 *   quake-m6     USGS all-day feed, M>=6.0 in the last 24h
 *   nws-severe   api.weather.gov active alerts: Tornado/Tsunami/Extreme-Wind
 *                warnings, or Flash Flood Warning at Severe/Extreme severity
 *   faa-ground   nasstatus.faa.gov: Ground Delay Programs, Ground Stops,
 *                Airport Closures (the low-signal per-flight delay list is
 *                deliberately excluded)
 *   mirova-thermal MIROVA NRT: level very-high/extreme (MIROVA's own levels,
 *                carried verbatim — never recomputed)
 *   swpc-g4      SWPC planetary K-index: Kp>=8 in the last 3h (G4+ storm)
 *
 * Parsers are reused from the sibling providers (parseMirova, parseNasStatus,
 * parseNwsAlerts) — never reimplemented here.
 *
 * HONESTY: rule thresholds are OURS (heuristic tripwires), not the agencies'
 * official alert products — except MIROVA levels, which are MIROVA's own.
 * Each rule evaluates on its own TTL-cached upstream fetch, so firings lag
 * real time by up to the rule TTL. A firing means "the tripwire condition was
 * true at evaluation time", not "an official emergency was declared".
 * ntfy delivery is best-effort; this route is the source of truth.
 */
import { parseMirova } from './mirova.js';
import { parseNasStatus } from './faaDelays.js';
import { parseNwsAlerts } from '../wave6/alerts.js';

const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const CACHE_CONTROL = 'public, max-age=300';

export const DEFAULT_NTFY_TOPIC = 'satwq-alerts';
export const NTFY_SERVER = 'https://ntfy.sh';

function ntfyTopic() {
  const t = String(process.env.NTFY_TOPIC ?? '').trim();
  return t || DEFAULT_NTFY_TOPIC;
}

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Pure rule checks (exported for tests). Each returns an array of firings:
// { ruleId, severity, title, detail, link, dedupeKey, observedAt }.
// ---------------------------------------------------------------------------

const QUAKE_WINDOW_MS = 24 * 3600 * 1000;

export function checkQuakes(geojson, nowMs = Date.now()) {
  const firings = [];
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const mag = numOrNull(p.mag);
    const time = numOrNull(p.time);
    if (mag == null || mag < 6.0 || time == null) continue;
    if (nowMs - time > QUAKE_WINDOW_MS || time > nowMs + 5 * 60 * 1000)
      continue;
    const id = String(f.id ?? p.code ?? p.url ?? time);
    firings.push({
      ruleId: 'quake-m6',
      severity: mag >= 7.0 ? 'critical' : 'high',
      title: `M${mag.toFixed(1)} earthquake — ${p.place ?? 'unknown location'}`,
      detail: `Magnitude ${mag.toFixed(1)} at ${new Date(time).toISOString()}. Source: USGS.`,
      link:
        typeof p.url === 'string' && p.url
          ? p.url
          : 'https://earthquake.usgs.gov/',
      dedupeKey: `quake:${id}`,
      observedAt: new Date(time).toISOString(),
    });
  }
  return firings.sort((a, b) =>
    b.observedAt > a.observedAt ? 1 : b.observedAt < a.observedAt ? -1 : 0,
  );
}

const NWS_HIGH_SIGNAL = new Set([
  'Tornado Warning',
  'Tsunami Warning',
  'Extreme Wind Warning',
]);
const NWS_FFW_SEVERE = new Set(['Severe', 'Extreme']);

export function checkNwsAlerts(alertsJson, nowMs = Date.now()) {
  void nowMs;
  const firings = [];
  for (const a of parseNwsAlerts(alertsJson)) {
    const event = a.event ?? '';
    const isHighSignal = NWS_HIGH_SIGNAL.has(event);
    const isSevereFfw =
      event === 'Flash Flood Warning' && NWS_FFW_SEVERE.has(a.severity ?? '');
    if (!isHighSignal && !isSevereFfw) continue;
    const area =
      String(a.area ?? '')
        .split(';')[0]
        .trim()
        .slice(0, 120) || 'unspecified area';
    // trimNwsAlert prefixes the upstream id with 'nws:'; when the upstream id
    // is already a full https URL (the live NWS shape), strip the prefix back
    // off for a real deep link — never fabricate one from a URN.
    const rawId = String(a.id ?? '');
    const deepLink = rawId.startsWith('nws:https://') ? rawId.slice(4) : null;
    firings.push({
      ruleId: 'nws-severe',
      severity:
        event === 'Tornado Warning' || event === 'Tsunami Warning'
          ? 'critical'
          : 'high',
      title: `${event} — ${area}`,
      detail: a.headline ?? `${event} in effect. Source: NWS.`,
      link: deepLink ?? 'https://alerts.weather.gov',
      dedupeKey: rawId || `${event}:${area}`,
      observedAt: a.sent ?? a.effective ?? new Date().toISOString(),
    });
  }
  return firings;
}

const FAA_ALERT_SECTIONS = [
  { match: /ground delay programs/i, slug: 'gdp' },
  { match: /ground stops?/i, slug: 'ground-stop' },
  { match: /airport closures?/i, slug: 'closure' },
];

export function checkFaa(xml) {
  const firings = [];
  const parsed = parseNasStatus(xml);
  for (const section of parsed.sections ?? []) {
    const rule = FAA_ALERT_SECTIONS.find((r) =>
      r.match.test(section.name ?? ''),
    );
    if (!rule) continue; // low-signal delay lists deliberately excluded
    for (const item of section.items ?? []) {
      const f = item.fields ?? {};
      const what =
        f.Reason || f.Avg || f.Max
          ? [
              f.Reason,
              f.Avg ? `avg ${f.Avg}` : null,
              f.Max ? `max ${f.Max}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
          : section.name;
      firings.push({
        ruleId: 'faa-ground',
        severity: 'medium',
        title: `${section.name} — ${item.airport}`,
        detail: `${what}. Source: FAA NAS Status.`,
        link: 'https://nasstatus.faa.gov/api/airport-status-information',
        dedupeKey: `faa:${rule.slug}:${item.airport}`,
        observedAt: new Date().toISOString(),
      });
    }
  }
  return firings;
}

const MIROVA_ALERT_LEVELS = new Set(['very-high', 'extreme']);

export function checkMirova(html) {
  const firings = [];
  for (const row of parseMirova(html).rows) {
    if (!MIROVA_ALERT_LEVELS.has(String(row.level ?? '').toLowerCase()))
      continue;
    const vrp = row.vrpMw != null ? `${row.vrpMw} MW` : 'VRP n/a';
    firings.push({
      ruleId: 'mirova-thermal',
      severity: 'medium',
      title: `MIROVA ${row.level} thermal anomaly — ${row.name}`,
      detail: `Volcanic Radiative Power ${vrp} (heat-flux proxy, not lava volume). MIROVA's own alert level, carried verbatim.`,
      link: 'https://www.mirovaweb.it/NRT/',
      dedupeKey: `mirova:${row.volcanoId}:${row.time ?? 'notime'}`,
      observedAt: new Date().toISOString(),
    });
  }
  return firings;
}

const SWPC_WINDOW_MS = 3 * 3600 * 1000;

export function checkSwpc(kJson, nowMs = Date.now()) {
  const rows = Array.isArray(kJson) ? kJson : [];
  let maxKp = null;
  let maxRow = null;
  for (const r of rows) {
    const t = Date.parse(r?.time_tag ?? '');
    if (!Number.isFinite(t)) continue;
    if (t < nowMs - SWPC_WINDOW_MS || t > nowMs + 5 * 60 * 1000) continue;
    const kp = numOrNull(r?.kp_index);
    if (kp == null) continue;
    if (maxKp == null || kp > maxKp) {
      maxKp = kp;
      maxRow = r;
    }
  }
  if (maxKp == null || maxKp < 8) return [];
  const g = Math.min(5, Math.max(1, maxKp - 4)); // Kp5->G1 … Kp9->G5
  const bucket =
    String(maxRow.time_tag ?? '')
      .slice(0, 13)
      .replace(/[^0-9]/g, '') || 'unknown';
  return [
    {
      ruleId: 'swpc-g4',
      severity: 'high',
      title: `G${g}-class geomagnetic storm (Kp ${maxKp})`,
      detail: `Planetary K-index reached ${maxKp} within the last 3h (G-scale G${g}). Model/observation blend from SWPC; expect aurora at unusually low latitudes and possible GPS/power-grid effects at G4+.`,
      link: 'https://www.swpc.noaa.gov/products/planetary-k-index',
      dedupeKey: `swpc:kp8:${bucket}`,
      observedAt: maxRow.time_tag ?? new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Rule table: pinned upstreams, TTLs, fetch+parse, check.
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: 'quake-m6',
    title: 'M6+ earthquakes (24h, USGS)',
    severity: 'high',
    upstream:
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    ttlMs: 15 * 60 * 1000,
    capBytes: 4_000_000,
    accept: 'application/geo+json, application/json',
    parse: (text) => JSON.parse(text),
    check: checkQuakes,
  },
  {
    id: 'nws-severe',
    title:
      'Severe NWS weather alerts (tornado/tsunami/extreme-wind, severe flash-flood)',
    severity: 'high',
    upstream:
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert',
    ttlMs: 10 * 60 * 1000,
    capBytes: 4_000_000,
    accept: 'application/geo+json, application/json',
    parse: (text) => JSON.parse(text),
    check: checkNwsAlerts,
  },
  {
    id: 'faa-ground',
    title: 'FAA ground delays / ground stops / closures',
    severity: 'medium',
    upstream: 'https://nasstatus.faa.gov/api/airport-status-information',
    ttlMs: 10 * 60 * 1000,
    capBytes: 2_000_000,
    accept: 'application/xml, text/xml, */*',
    parse: (text) => text,
    check: checkFaa,
  },
  {
    id: 'mirova-thermal',
    title: 'MIROVA very-high/extreme volcanic thermal anomalies',
    severity: 'medium',
    upstream: 'https://www.mirovaweb.it/NRT/',
    ttlMs: 30 * 60 * 1000,
    capBytes: 2_000_000,
    accept: 'text/html, */*',
    parse: (text) => text,
    check: checkMirova,
  },
  {
    id: 'swpc-g4',
    title: 'G4+ geomagnetic storm (SWPC planetary K)',
    severity: 'high',
    upstream: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    ttlMs: 15 * 60 * 1000,
    capBytes: 2_000_000,
    accept: 'application/json',
    parse: (text) => JSON.parse(text),
    check: checkSwpc,
  },
];

export const RULE_IDS = RULES.map((r) => r.id);

// ---------------------------------------------------------------------------
// Fetch machinery (wave9 conventions): per-rule TTL + retry cooldown +
// inflight dedupe + key-scoped stale fallback. Rules run in parallel via
// Promise.allSettled — never sequential x 20s timeouts on a Worker.
// ---------------------------------------------------------------------------

async function fetchTextCapped(rule) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(rule.upstream, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: rule.accept },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`${rule.id}_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > rule.capBytes)
      throw Object.assign(new Error(`${rule.id}_upstream_too_large`), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`${rule.id}_fetch_failed: ${error?.message ?? 'unknown'}`),
      {
        status: 502,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

const payloadCache = new Map(); // ruleId -> {at, payload}
const inflight = new Map();
const failedAt = new Map();

async function evaluateRule(rule, nowMs) {
  const hit = payloadCache.get(rule.id);
  if (hit && nowMs - hit.at < rule.ttlMs)
    return { ...hit.payload, stale: false };
  let op = inflight.get(rule.id);
  if (!op) {
    const lastFail = failedAt.get(rule.id) ?? -Infinity;
    if (
      nowMs - lastFail < RETRY_COOLDOWN_MS &&
      hit &&
      nowMs - hit.at < STALE_MS
    ) {
      return { ...hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const text = await fetchTextCapped(rule);
        const parsed = rule.parse(text);
        const firings = rule.check(parsed, Date.now());
        const payload = {
          id: rule.id,
          title: rule.title,
          severity: rule.severity,
          ok: true,
          stale: false,
          evaluatedAt: new Date().toISOString(),
          firing: firings,
        };
        payloadCache.set(rule.id, { at: Date.now(), payload });
        return payload;
      } catch (error) {
        failedAt.set(rule.id, Date.now());
        if (hit && Date.now() - hit.at < STALE_MS)
          return { ...hit.payload, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(rule.id));
    inflight.set(rule.id, op);
  }
  return op;
}

const ALERT_RULES_HONESTY = {
  thresholdsAreOurs:
    "Rule tripwires (M>=6, Kp>=8, alert-type lists) are ours — heuristic thresholds, not the agencies' official alert products. MIROVA levels are the exception: they are MIROVA's own alert levels, carried verbatim.",
  evaluationLag:
    'Each rule evaluates on its own TTL-cached upstream fetch (10–30 min); firings lag real time by up to the rule TTL. A firing means the tripwire condition was true at evaluation time.',
  firingSemantics:
    'A firing is "condition observed", not "emergency declared". Corroborate with the linked official source before acting.',
  quietIsReal:
    'Zero firings with all rules ok:true means no tripwire fired — not missing data. A rule with ok:false is reported, never silently dropped.',
  ntfy: 'ntfy.sh delivery is best-effort pub/sub. This route is the source of truth; the companion scripts/alerts-publish.mjs diffs firings and publishes only NEW dedupeKeys.',
  attribution:
    'Data: USGS, NWS, FAA, MIROVA (INGV), NOAA SWPC. Push channel: ntfy.sh (free, keyless public topics).',
};

function buildPayload(results, staleFlags) {
  const rules = results.map((r) => ({
    id: r.id,
    title: r.title,
    severity: r.severity,
    ok: r.ok,
    stale: !!staleFlags[r.id],
    evaluatedAt: r.evaluatedAt ?? null,
    firing: r.firing ?? [],
    error: r.error ?? null,
  }));
  const firings = rules.flatMap((r) => r.firing);
  const topic = ntfyTopic();
  return {
    generatedAt: new Date().toISOString(),
    rules,
    firingCount: firings.length,
    firings,
    honesty: ALERT_RULES_HONESTY,
    notify: {
      channel: 'ntfy.sh',
      topic,
      publishUrl: `${NTFY_SERVER}/${topic}`,
      subscribeUrl: `${NTFY_SERVER}/${topic}`,
      app: 'Install ntfy (Android / iOS / F-Droid) and subscribe to the topic to get push alerts.',
      note: 'Default topic is PUBLIC: anyone with the name can read it. Set NTFY_TOPIC to a hard-to-guess name for private alerts.',
    },
  };
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function parseRuleQuery(url) {
  const q = String(url ?? '').split('?')[1] ?? '';
  const params = new URLSearchParams(q);
  return (params.get('rule') ?? '').trim();
}

/** Mount the wave-9 alert-rules engine. */
export function alertRulesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const onlyRule = parseRuleQuery(req.url);
    if (onlyRule && !RULE_IDS.includes(onlyRule)) {
      return sendJson(
        res,
        400,
        { error: 'alertrules_bad_rule', valid: RULE_IDS },
        'no-store',
      );
    }
    const selected = onlyRule ? RULES.filter((r) => r.id === onlyRule) : RULES;
    const nowMs = Date.now();
    try {
      const settled = await Promise.allSettled(
        selected.map((r) => evaluateRule(r, nowMs)),
      );
      const results = [];
      const staleFlags = {};
      let anyFailed = false;
      settled.forEach((s, i) => {
        const rule = selected[i];
        if (s.status === 'fulfilled') {
          results.push(s.value);
          staleFlags[rule.id] = !!s.value.stale;
        } else {
          anyFailed = true;
          results.push({
            id: rule.id,
            title: rule.title,
            severity: rule.severity,
            ok: false,
            evaluatedAt: null,
            firing: [],
            error: s.reason?.message ?? 'unknown',
          });
          staleFlags[rule.id] = false;
        }
      });
      const payload = buildPayload(results, staleFlags);
      // All rules failed with no stale fallback: honest 502 (d99a470 precedent).
      if (anyFailed && results.every((r) => !r.ok)) {
        return sendJson(
          res,
          502,
          { ...payload, error: 'alertrules_all_upstream_failed' },
          'no-store',
        );
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(
        res,
        502,
        {
          error: 'alertrules_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: { attribution: ALERT_RULES_HONESTY.attribution },
        },
        'no-store',
      );
    }
  }

  return {
    name: 'alert-rules',
    configureServer({ middlewares }) {
      middlewares.use('/api/alert-rules', handler);
    },
  };
}

export const _alertRulesInternals = {
  RULES,
  ALERT_RULES_HONESTY,
  checkQuakes,
  checkNwsAlerts,
  checkFaa,
  checkMirova,
  checkSwpc,
};
