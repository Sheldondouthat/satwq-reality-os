/**
 * Washington VAAC volcanic-ash advisory polygon proxy (keyless).
 *
 * The repo already proxies Tokyo VAAC as text (/api/vaac); this provider
 * adds the machine-readable ICAO IWXXM 3.0 advisory polygons from the
 * NOAA OSPO Washington VAAC archive, keyless:
 *
 *   GET https://www.ospo.noaa.gov/products/atmosphere/vaac/messages.html
 *     → index listing xml_files/FVXX21_20260927_0454.xml links
 *   GET https://www.ospo.noaa.gov/products/atmosphere/vaac/volcanoes/xml_files/<file>
 *     → IWXXM 3.0 VolcanicAshAdvisory (verified live 2026-09-27)
 *
 * Structure (fixed enough for regex extraction, verified against a live
 * SANGAY advisory):
 *   - <gml:posList> pairs are "Lat Long" (axisLabels="Lat Long")
 *   - ash volumes in <ashCloudExtent> blocks: upperLimit uom="FL", lowerLimit GND|FL
 *   - observation: <VolcanicAshObservedOrEstimatedConditions status>
 *     ("IDENTIFIABLE" | "NOT_IDENTIFIABLE"); forecasts: <forecast><VolcanicAshForecastConditions>
 *
 * Routes:
 *   GET /api/vaac-polygons → {generatedAt, count, advisories:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — no node: imports, no WASM).
 */

const MESSAGES_URL = 'https://www.ospo.noaa.gov/products/atmosphere/vaac/messages.html';
const XML_BASE = 'https://www.ospo.noaa.gov/products/atmosphere/vaac/volcanoes/xml_files/';
const MAX_ADVISORIES = 8;
const FETCH_TIMEOUT_MS = 20_000;
const MESSAGES_CAP_BYTES = 1 * 1024 * 1024;
const XML_CAP_BYTES = 256 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const USER_AGENT = 'Gods Eye View (public VAAC ash-polygon context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`vaacpoly_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('vaacpoly_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/** Latest-first, deduplicated advisory XML file names from the index page. */
export function extractAdvisoryFiles(messagesHtml, limit = MAX_ADVISORIES) {
  const files = [];
  const seen = new Set();
  const re = /xml_files\/([A-Z0-9_]+\.xml)/g;
  let m;
  while ((m = re.exec(messagesHtml)) && files.length < limit) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      files.push(m[1]);
    }
  }
  return files;
}

/** "−1.917 −79.117 ..." (Lat Long) → [[lon,lat],...] ring. */
export function parsePosList(raw) {
  const nums = String(raw).trim().split(/\s+/).map(Number);
  const ring = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const lat = nums[i];
    const lon = nums[i + 1];
    if (Number.isFinite(lat) && Number.isFinite(lon)) ring.push([lon, lat]);
  }
  return ring;
}

function firstGroup(re, text) {
  return re.exec(text)?.[1]?.trim() ?? null;
}

/** Volumes inside one <ashCloudExtent>…</ashCloudExtent> span. */
export function extractVolumes(spanXml) {
  const volumes = [];
  const re = /<ashCloudExtent>([\s\S]*?)<\/ashCloudExtent>/g;
  let m;
  while ((m = re.exec(spanXml))) {
    const block = m[1];
    const upperRaw = /<aixm:upperLimit[^>]*>([^<]*)</.exec(block)?.[1]?.trim() ?? null;
    const upperUom = /<aixm:upperLimit[^>]*uom="([^"]*)"/.exec(block)?.[1] ?? null;
    const lowerRaw = /<aixm:lowerLimit[^>]*>([^<]*)</.exec(block)?.[1]?.trim() ?? null;
    const lowerUom = /<aixm:lowerLimit[^>]*uom="([^"]*)"/.exec(block)?.[1] ?? null;
    const rings = [];
    const plRe = /<gml:posList[^>]*>([^<]+)<\/gml:posList>/g;
    let pl;
    while ((pl = plRe.exec(block))) {
      const ring = parsePosList(pl[1]);
      if (ring.length >= 3) rings.push(ring);
    }
    if (rings.length > 0) {
      volumes.push({
        upperFl: upperUom === 'FL' && Number.isFinite(Number(upperRaw)) ? Number(upperRaw) : null,
        lowerFl: lowerUom === 'FL' && Number.isFinite(Number(lowerRaw)) ? Number(lowerRaw) : null,
        lowerGround: lowerRaw === 'GND',
        rings,
      });
    }
  }
  return volumes;
}

/** Parse one IWXXM advisory XML into the globe-ready record. */
export function parseVaacAdvisory(xml, fileName = null) {
  const volcano = firstGroup(/<EruptingVolcano[\s\S]*?<name>([^<]+)<\/name>/, xml);
  const volcanoPos = /<EruptingVolcano[\s\S]*?<gml:pos>([^<]+)<\/gml:pos>/.exec(xml)?.[1];
  const latLon = (volcanoPos ?? '').trim().split(/\s+/).map(Number);
  const advisoryNumber = firstGroup(/<advisoryNumber>([^<]+)<\/advisoryNumber>/, xml);
  const issueTime = firstGroup(
    /<VolcanicAshAdvisory[\s\S]*?<issueTime>[\s\S]*?<gml:timePosition>([^<]+)<\/gml:timePosition>/,
    xml,
  );
  const stateOrRegion = firstGroup(/<stateOrRegion>([^<]+)<\/stateOrRegion>/, xml);
  const eruptionDetails = firstGroup(/<eruptionDetails>([^<]+)<\/eruptionDetails>/, xml);

  const obsMatch = /<observation>([\s\S]*?)<\/observation>/.exec(xml);
  const obsStatus = obsMatch
    ? /<VolcanicAshObservedOrEstimatedConditions[^>]*status="([^"]*)"/.exec(obsMatch[1])?.[1] ?? null
    : null;
  const obsTime = obsMatch ? firstGroup(/<gml:timePosition>([^<]+)<\/gml:timePosition>/, obsMatch[1]) : null;
  const observation = obsMatch
    ? { time: obsTime, status: obsStatus, volumes: extractVolumes(obsMatch[1]) }
    : null;

  const forecasts = [];
  const fcRe = /<forecast>([\s\S]*?)<\/forecast>/g;
  let fc;
  while ((fc = fcRe.exec(xml))) {
    const time = firstGroup(/<gml:timePosition>([^<]+)<\/gml:timePosition>/, fc[1]);
    const volumes = extractVolumes(fc[1]);
    if (volumes.length > 0) forecasts.push({ time, volumes });
  }

  return {
    file: fileName,
    volcano: volcano ?? 'UNKNOWN',
    volcanoLat: Number.isFinite(latLon[0]) ? latLon[0] : null,
    volcanoLon: Number.isFinite(latLon[1]) ? latLon[1] : null,
    advisoryNumber,
    issueTime,
    stateOrRegion,
    eruptionDetails,
    observation,
    forecasts,
  };
}

async function fetchAdvisory(file) {
  try {
    const xml = await fetchTextCapped(XML_BASE + file, XML_CAP_BYTES);
    if (!/<VolcanicAshAdvisory[\s>]/.test(xml)) return null;
    return parseVaacAdvisory(xml, file);
  } catch {
    return null;
  }
}

async function loadSnapshot() {
  const indexHtml = await fetchTextCapped(MESSAGES_URL, MESSAGES_CAP_BYTES);
  const files = extractAdvisoryFiles(indexHtml);
  const advisories = [];
  // Sequential-ish fan-out with a small concurrency cap; one dead file is skipped.
  let cursor = 0;
  const workers = new Array(Math.min(4, files.length)).fill(0).map(async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const advisory = await fetchAdvisory(file);
      if (advisory) advisories.push(advisory);
    }
  });
  await Promise.all(workers);
  // Preserve index order (latest first).
  advisories.sort(
    (a, b) => files.indexOf(a.file) - files.indexOf(b.file),
  );
  return {
    generatedAt: new Date().toISOString(),
    count: advisories.length,
    advisories,
  };
}

async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = loadSnapshot().then(
      (payload) => {
        cache = { at: Date.now(), payload };
        inflight = null;
        return payload;
      },
      (error) => {
        inflight = null;
        if (cache) return cache.payload;
        throw error;
      },
    );
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the VAAC polygon proxy. Mirrors the nws-alerts provider shape. */
export function vaacPolyProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot(), `public, max-age=${Math.floor(CACHE_TTL_MS / 2000)}`);
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'vaac_polygons_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'vaac-polygons',
    configureServer({ middlewares }) {
      middlewares.use('/api/vaac-polygons', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/vaac-polygons', handler);
    },
  };
}

export const _vaacPolyInternals = {
  loadSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
