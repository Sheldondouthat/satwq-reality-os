/**
 * Water twin (Wave 3, Track 1c, item 1.10).
 *
 * Reservoirs + rivers + rain state: live CDEC reservoir storage (keyless CSV,
 * verified 2026-09-27) crossed with live USGS river values (00060 discharge,
 * 00065 gage height) and curated NWS flood-stage references.
 *
 * WDFN MIGRATION (2026-11-15, spec: sky-map-quest/registry/
 * WDFN-MIGRATION-2026-11-15.md): the river leg now reads the WDFN API V1
 * `latest-continuous` collection (keyless, verified live 2026-11-15)
 * instead of WaterServices NWIS IV, which USGS decommissions in early
 * 2027. Observation times are now the WDFN UTC ISO timestamps (the same
 * instants the WaterML local-offset strings named). No-data is an
 * absent feature or a value:null feature — a site with no current
 * value is 'unavailable', never synthesized. The sourceErrors key stays `nwis`: it names the
 * NWIS data lineage this leg serves, and the envelope shape is frozen.
 *
 * Route: GET /api/water-twin
 *
 * NOTE on the NWIS collision with worker W4 (item 2.1 gauge layer): this
 * provider owns the RESERVOIR/flood-state coupling only. It never exposes
 * raw gauge layers; it exposes per-site flood-state BANDS and reservoir
 * storage. Registry lives at src/frontier/wave3/waterTwin/registry.js.
 *
 * Plain fetch + CSV/JSON parsing only — no WASM, no node:fs. Safe for the
 * Pages Functions registry path.
 */
import {
  RESERVOIRS,
  RIVERS,
  CDEC_STATION_IDS,
  NWIS_SITE_IDS,
} from '../../../shared/waterTwinRegistry.js';

const CDEC_URL = (stations) =>
  `https://cdec.water.ca.gov/dynamicapp/req/CSVDataServlet?Stations=${stations}&SensorNums=15&dur_code=D&Start=__START__&End=__END__`;
const WDFN_LATEST_URL = (sites) =>
  `https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?monitoring_location_number=${sites}&parameter_code=00060,00065&limit=1000`;

const CACHE_TTL_MS = 30 * 60_000; // reservoir storage is daily; rivers refresh faster client-side
const STALE_MS = 6 * 60 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TEXT_CAP = 2 * 1024 * 1024;
const USER_AGENT =
  'SATWQ-RealityOS-WaterTwin/1.0 (public water data coupling; contact via repo)';

function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Parse the CDEC daily CSV: STATION_ID,...,DATE TIME,OBS DATE,VALUE,DATA_FLAG,UNITS */
export function parseCdecCsv(text) {
  const byStation = {};
  const lines = String(text).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 9) continue;
    const [station, , sensor, type, dateTime, , value] = parts;
    if (sensor !== '15' || type !== 'STORAGE') continue;
    if (value === '---' || value === '') continue;
    const v = Number(value);
    if (!Number.isFinite(v)) continue;
    const prev = byStation[station];
    if (!prev || dateTime > prev.dateTime)
      byStation[station] = { dateTime, storageAf: v };
  }
  return byStation;
}

/**
 * Collapse a WDFN latest-continuous GeoJSON payload to
 * {site: {flowCfs, gageFt, time}} keyed by the BARE site number (the
 * envelope's registry sites are bare; WDFN ids are agency-prefixed,
 * "USGS-07010000"). One feature per time series: when a site carries
 * duplicate series for a parameter, the instantaneous statistic
 * (00011, migration spec §3.2) wins. `time` is the feature's UTC ISO
 * timestamp. Absence of a feature is the no-data signal.
 */
export function parseWdfnLatest(payload) {
  const out = {};
  const features = payload?.features;
  if (!Array.isArray(features)) return out;
  for (const feature of features) {
    const p = feature?.properties;
    if (!p) continue;
    const code = p.parameter_code;
    if (code !== '00060' && code !== '00065') continue;
    const site = String(p.monitoring_location_id ?? '').replace(
      /^[A-Za-z][A-Za-z0-9]*-/,
      '',
    );
    if (!site) continue;
    // WDFN spells no-data as value:null — Number(null)===0 would
    // fabricate a 0 reading; filter before converting (see nwisGauges).
    const v =
      p.value == null || (typeof p.value === 'string' && p.value.trim() === '')
        ? NaN
        : Number(p.value);
    if (!Number.isFinite(v)) continue;
    const prev = out[site] ?? {};
    const field = code === '00060' ? 'flowCfs' : 'gageFt';
    const prevStat = prev[`${field}Stat`];
    if (
      prev[field] != null &&
      prevStat === '00011' &&
      p.statistic_id !== '00011'
    )
      continue; // keep the instantaneous-statistic series already recorded
    prev[field] = v;
    prev[`${field}Stat`] = p.statistic_id ?? null;
    prev.time = p.time;
    out[site] = prev;
  }
  for (const site of Object.values(out)) {
    delete site.flowCfsStat;
    delete site.gageFtStat;
  }
  return out;
}

/**
 * Flood-state band from gage height vs curated reference stages.
 * These are height BANDS, not official NWS flood categories — the UI must
 * say so. Unknown when no gage reading exists.
 */
export function classifyFloodBand(gageFt, floodStageFt, actionStageFt) {
  if (!Number.isFinite(gageFt) || !Number.isFinite(floodStageFt))
    return 'unknown';
  if (gageFt >= floodStageFt + 6) return 'major-flood';
  if (gageFt >= floodStageFt + 3) return 'moderate-flood';
  if (gageFt >= floodStageFt) return 'minor-flood';
  if (Number.isFinite(actionStageFt) && gageFt >= actionStageFt)
    return 'action';
  return 'normal';
}

export function reservoirState(storageAf, capacityAf) {
  if (
    !Number.isFinite(storageAf) ||
    !Number.isFinite(capacityAf) ||
    capacityAf <= 0
  )
    return null;
  return Math.round((storageAf / capacityAf) * 1000) / 10;
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

export function waterTwinProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let cache = null;
  let operation = null;
  let attemptedAt = -Infinity;

  async function upstreamText(url, signal) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`upstream_http_${response.status}`);
    }
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length > TEXT_CAP) throw new Error('upstream_too_large');
    return text;
  }

  async function refresh(signal) {
    const end = new Date(now());
    const start = new Date(now() - 7 * 24 * 3600_000);
    const cdecUrl = CDEC_URL(CDEC_STATION_IDS)
      .replace('__START__', ymd(start))
      .replace('__END__', ymd(end));
    const [cdecText, wdfnText] = await Promise.all([
      upstreamText(cdecUrl, signal).catch((e) => ({ error: e?.message })),
      upstreamText(WDFN_LATEST_URL(NWIS_SITE_IDS), signal).catch((e) => ({
        error: e?.message,
      })),
    ]);
    signal.throwIfAborted();

    const storageByStation =
      typeof cdecText === 'string' ? parseCdecCsv(cdecText) : {};
    let nwis = {};
    if (typeof wdfnText === 'string') {
      try {
        nwis = parseWdfnLatest(JSON.parse(wdfnText));
      } catch {
        nwis = {};
      }
    }

    const reservoirs = RESERVOIRS.map((r) => {
      const reading = storageByStation[r.id];
      const pct = reading
        ? reservoirState(reading.storageAf, r.capacityAf)
        : null;
      return {
        id: r.id,
        name: r.name,
        storageAf: reading?.storageAf ?? null,
        capacityAf: r.capacityAf,
        pctFull: pct,
        obsDate: reading?.dateTime ?? null,
        status: reading ? 'live' : 'unavailable',
        capacityNote:
          'curated approximate capacity — reference denominator, not a measurement',
      };
    });

    const rivers = RIVERS.map((r) => {
      const reading = nwis[r.site];
      const band = classifyFloodBand(
        reading?.gageFt,
        r.floodStageFt,
        r.actionStageFt,
      );
      return {
        site: r.site,
        name: r.name,
        flowCfs: reading?.flowCfs ?? null,
        gageFt: reading?.gageFt ?? null,
        floodStageFt: r.floodStageFt,
        actionStageFt: r.actionStageFt,
        band,
        bandNote:
          'height band vs curated reference stage — not an official NWS category',
        obsTime: reading?.time ?? null,
        status: reading ? 'live' : 'unavailable',
      };
    });

    const reservoirFailures = reservoirs.filter(
      (r) => r.status !== 'live',
    ).length;
    const riverFailures = rivers.filter((r) => r.status !== 'live').length;
    cache = {
      reservoirs,
      rivers,
      fetchedAt: now(),
      sourceErrors: {
        cdec: typeof cdecText === 'string' ? null : cdecText.error,
        // Key stays `nwis` (envelope shape is frozen); the leg it names
        // is now served by the WDFN API — see the header migration note.
        nwis: typeof wdfnText === 'string' ? null : wdfnText.error,
      },
      allUnavailable:
        reservoirFailures === reservoirs.length &&
        riverFailures === rivers.length,
    };
    return cache;
  }

  async function acquire(signal) {
    signal.throwIfAborted();
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
    if (operation?.controller.signal.aborted) operation = null;
    if (!operation) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS)
        throw new Error('watertwin_retry_later');
      attemptedAt = now();
      const controller = new AbortController();
      const owned = { controller, waiters: 0 };
      const timer = setTimeout(() => controller.abort(), timeoutMs * 2 + 5000);
      owned.promise = refresh(controller.signal).finally(() => {
        clearTimeout(timer);
        if (operation === owned) operation = null;
      });
      operation = owned;
    }
    const owned = operation;
    owned.waiters++;
    try {
      return await owned.promise;
    } finally {
      if (--owned.waiters === 0 && operation === owned)
        owned.controller.abort();
    }
  }

  function describe(value, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source:
        'CDEC daily reservoir storage + USGS WDFN latest-continuous river values (NWIS), via local proxy',
      attribution:
        'Reservoir storage: California Data Exchange Center (CDEC), public. ' +
        'River flow/gage height: USGS NWIS via the WDFN API. Flood-stage references: curated ' +
        'approximate NWS-published values.',
      fetchedAt: value?.fetchedAt ?? null,
      stale,
      unavailable: !value || value.allUnavailable,
      reason,
      reservoirs: value?.reservoirs ?? [],
      rivers: value?.rivers ?? [],
      sourceErrors: value?.sourceErrors ?? null,
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      sendJson(res, value, status);
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      try {
        json(200, describe(await acquire(controller.signal)));
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache, {
                stale: true,
                reason: 'Upstream unreachable; showing last good sweep.',
              })
            : describe(null, {
                reason: 'CDEC/USGS unreachable and no cached sweep exists.',
              }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'water-twin',
    configureServer({ middlewares }) {
      middlewares.use('/api/water-twin', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/water-twin', handler);
    },
  };
}
