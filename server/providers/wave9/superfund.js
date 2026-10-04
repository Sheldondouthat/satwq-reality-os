/**
 * Wave 9 — EPA Superfund NPL sites (SEMS via the Envirofacts DMAP REST API).
 *
 * Upstream: https://data.epa.gov/dmapservice/sems.envirofacts_site/npl_status_code/equals/{F|P}/1:100000/JSON
 * (keyless; documented at https://www.epa.gov/enviro/envirofacts-data-service-api-v1 —
 * table name must be [program].[table], filters are [column]/[operator]/[value]).
 * Verified live 2026-10-02: 1,337 final-NPL sites nationally, all with EPA
 * primary lat/lon; proposed set small. Each refresh costs 1 subrequest per
 * status code queried (default: final + proposed = 2).
 *
 * HONESTY: the NPL (National Priorities List) is EPA's list of the country's
 * most serious uncontrolled hazardous-waste sites. "Final" = formally listed;
 * "proposed" = proposed for listing. Listing is not a cleanup-status readout
 * and this payload carries no listing dates (upstream exposes none on this
 * table). primary_latitude/longitude_decimal_val is EPA's facility centroid —
 * not a site boundary. SEMS non-NPL, archived, and deleted sites are NOT
 * included. Nulls are never zero-filled (numOrNull guards Number('')===0).
 */
const DMAP_BASE = 'https://data.epa.gov/dmapservice';
const TABLE = 'sems.envirofacts_site';
const USER_AGENT = 'satyq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const BODY_CAP_BYTES = 8_000_000;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const STALE_MS = 30 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=3600';
const MAX_ROWS = 100000;

const NPL_STATUS = { F: 'final', P: 'proposed' };

export function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty cell = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function latOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= -90 && n <= 90 ? n : null;
}

export function lonOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= -180 && n <= 180 ? n : null;
}

/** Build the DMAP URL for one NPL status code, optionally state-scoped. */
export function buildDmapUrl(statusCode, stateAbbr) {
  const filters = [`npl_status_code/equals/${statusCode}`];
  if (stateAbbr) filters.push(`fk_ref_state_code/equals/${stateAbbr}`);
  return `${DMAP_BASE}/${TABLE}/${filters.join('/')}/1:${MAX_ROWS}/JSON`;
}

/**
 * Parse the DMAP JSON array into { rows } where each row is
 * { epaId, name, city, county, state, lat, lon, street, zip, status,
 *   statusName, federalFacility }.
 * Rows with no name are skipped, never guessed. Upstream error envelopes
 * ({error: ...}) and non-arrays throw a 502-class error.
 */
export function parseNplSites(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('superfund_bad_json'), { status: 502 });
  }
  if (!Array.isArray(data)) {
    throw Object.assign(new Error('superfund_bad_shape'), { status: 502 });
  }
  const rows = [];
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    const name = (r.name ?? '').trim();
    if (!name) continue; // never emit a nameless site
    const code = String(r.npl_status_code ?? '').toUpperCase();
    rows.push({
      epaId: (r.epa_id ?? '').trim() || null,
      name,
      city: (r.city_name ?? '').trim() || null,
      county: (r.county_name ?? '').trim() || null,
      state: (r.fk_ref_state_code ?? '').trim() || null,
      lat: latOrNull(r.primary_latitude_decimal_val),
      lon: lonOrNull(r.primary_longitude_decimal_val),
      street: (r.street_addr_txt ?? '').trim() || null,
      zip: (r.zip_code ?? '').trim() || null,
      status: NPL_STATUS[code] ?? null,
      statusName: (r.npl_status_name ?? '').trim() || null,
      federalFacility:
        String(r.federal_facility_ind ?? '').toUpperCase() === 'Y',
    });
  }
  return { rows };
}

export function buildPayload(sites, stale, scope) {
  const byStatus = { final: 0, proposed: 0 };
  const byState = {};
  for (const s of sites) {
    if (s.status && byStatus[s.status] != null) byStatus[s.status] += 1;
    if (s.state) byState[s.state] = (byState[s.state] || 0) + 1;
  }
  const topStates = Object.entries(byState)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([state, count]) => ({ state, count }));
  return {
    generatedAt: new Date().toISOString(),
    upstream: `${DMAP_BASE}/${TABLE}`,
    stale: !!stale,
    scope,
    summary: {
      total: sites.length,
      byStatus,
      topStates,
    },
    sites,
    honesty: {
      npl: "EPA's National Priorities List: the country's most serious uncontrolled hazardous-waste sites.",
      status:
        '"final" = formally listed on the NPL; "proposed" = proposed for listing. Listing is not a cleanup-status readout.',
      coords:
        "primary_latitude/longitude_decimal_val is EPA's facility centroid — not a site boundary.",
      noDates: 'This table exposes no listing dates; none are carried here.',
      exclusions: 'SEMS non-NPL, archived, and deleted sites are not included.',
      nulls: 'Missing coordinates are null, never zero-filled.',
      attribution: 'Data: U.S. EPA Envirofacts (SEMS) via the DMAP REST API.',
    },
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`superfund_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('superfund_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`superfund_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;

/**
 * Query parsing: ?status=F|P|A (default A = both), ?state=<2-letter> (default national).
 * Returns { status, state, badParam } — badParam set when a param is malformed.
 */
export function parseQuery(searchParams) {
  const rawStatus = (searchParams.get('status') ?? 'A').toUpperCase();
  if (!['F', 'P', 'A'].includes(rawStatus))
    return { badParam: 'superfund_bad_status' };
  const rawState = searchParams.get('state');
  let state = null;
  if (rawState != null && rawState !== '') {
    state = rawState.toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return { badParam: 'superfund_bad_state' };
  }
  return { status: rawStatus, state };
}

async function getPayload(statusCode, state) {
  const key = `${statusCode}|${state ?? 'US'}`;
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS)
    return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (
      now - docFailedAt < RETRY_COOLDOWN_MS &&
      hit &&
      now - hit.at < STALE_MS
    ) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const codes = statusCode === 'A' ? ['F', 'P'] : [statusCode];
        const sites = [];
        for (const code of codes) {
          const text = await fetchTextCapped(
            buildDmapUrl(code, state),
            BODY_CAP_BYTES,
          );
          const { rows } = parseNplSites(text);
          sites.push(...rows);
        }
        const scope = { status: statusCode, state: state ?? 'national' };
        const payload = buildPayload(sites, false, scope);
        if (sites.length === 0 && state == null) {
          // National NPL should never be empty — treat as upstream degradation.
          throw Object.assign(new Error('superfund_empty_national'), {
            status: 502,
          });
        }
        payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        docFailedAt = Date.now();
        if (hit && Date.now() - hit.at < STALE_MS)
          return { payload: hit.payload, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 Superfund NPL proxy. */
export function superfundProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const q = parseQuery(url.searchParams);
      if (q.badParam)
        return sendJson(res, 400, { error: q.badParam }, 'no-store');
      const { payload, stale } = await getPayload(q.status, q.state);
      const body = stale ? { ...payload, stale: true } : payload;
      if (q.state != null && body.summary.total === 0) {
        // Well-formed state with no NPL sites: honest 200, not a 404.
        return sendJson(res, 200, { ...body, requestedNotFound: true });
      }
      sendJson(res, 200, body);
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'superfund_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: {
            attribution:
              'Data: U.S. EPA Envirofacts (SEMS) via the DMAP REST API.',
          },
        },
        'no-store',
      );
    }
  }

  return {
    name: 'superfund',
    configureServer({ middlewares }) {
      middlewares.use('/api/superfund', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/superfund', handler);
    },
  };
}

export const _superfundInternals = {
  DMAP_BASE,
  TABLE,
  CACHE_TTL_MS,
  buildDmapUrl,
  parseNplSites,
  buildPayload,
  parseQuery,
  numOrNull,
  latOrNull,
  lonOrNull,
  resetCache: () => {
    payloadCache.clear();
    inflight.clear();
    docFailedAt = -Infinity;
  },
};
