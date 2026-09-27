/**
 * Volcanic ash advisories (F9) — keyless VAAC feed, parsed from the source of record.
 *
 * VAAC PROBE OUTCOME (2026-09-26, OBSERVED):
 *   - NOAA SSD Washington VAAC (https://www.ssd.noaa.gov/VAAC/): UNREACHABLE
 *     from this runtime (curl http=000 / timeout). It remains the standard US
 *     source — wired as the documented upgrade path below.
 *   - Tokyo VAAC list (https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html):
 *     REACHABLE, keyless, current. Advisories live that day (probe saw live
 *     2026-09-26 advisories for SHEVELUCH/Russia, MAYON/Philippines,
 *     SAKURAJIMA/Japan — real eruptions, not fixtures).
 *   - Advisory bodies are ICAO-standard Volcanic Ash Advisory text
 *     (FVFE01-style), so this parser works for ANY VAAC's advisory text, not
 *     just Tokyo's.
 *
 * CORS reality: ds.data.jma.go.jp serves NO Access-Control-Allow-Origin, so a
 * browser client cannot fetch it directly. The layer's default fetch goes
 * through a same-origin proxy (wiring snippet in INTEGRATION.md: create
 * api/vaac.js). Without the proxy, the panel degrades honestly to the
 * "feed unavailable" state — never fake advisories.
 *
 * KEYED/FREE UPGRADE PATHS (documented, not implemented):
 *   - Add a second VAAC list (Washington via SSD when reachable; Darwin via
 *     bom.gov.au) and merge per-volcano.
 *   - Smithsonian GVP weekly reports need an API key — skip per NOTHING-paid rule.
 */
import * as Cesium from 'cesium';

export const TOKYO_VAAC_LIST_URL = 'https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html';
/** Same-origin proxy path this layer fetches; wire it per INTEGRATION.md. */
export const VAAC_PROXY_PATH = '/api/vaac';
const MAX_LIST_ROWS = 200;
const MAX_ADVISORY_FETCHES = 8;
const ADVISORY_BYTES_CAP = 64 * 1024;

/** Parse "N3136" / "E13039" / "S1185" / "W15642" / "N31165" (tenths) to decimal degrees. */
export function parseVaacCoordinate(token) {
  const m = /^([NSEW])(\d{4,7}(?:\.\d+)?)$/.exec(token?.trim() ?? '');
  if (!m) return null;
  const hemi = m[1];
  // Lat takes 2 degree digits, lon takes 3; split on that width first.
  const degDigits = hemi === 'N' || hemi === 'S' ? 2 : 3;
  const raw = m[2];
  if (raw.length < degDigits + 2) return null;
  const deg = Number(raw.slice(0, degDigits));
  const min = Number(raw.slice(degDigits));
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return null;
  const value = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -value : value;
}

const parseVaacPositionPair = (latToken, lonToken) => {
  const lat = parseVaacCoordinate(latToken);
  const lon = parseVaacCoordinate(lonToken);
  return lat === null || lon === null ? null : { lat, lon };
};

/** "20260802/1531Z" -> epoch ms (UTC). */
export function parseVaacDtg(dtg) {
  const m = /^(\d{4})(\d{2})(\d{2})\/(\d{2})(\d{2})Z$/.exec(dtg?.trim() ?? '');
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return Number.isFinite(ms) ? ms : null;
}

/** Day/time form inside advisories: "02/1510Z" needs the advisory's year/month context. */
function parseDayTimeDtg(token, contextMs) {
  const m = /^(\d{2})\/(\d{4})Z$/.exec(token?.trim() ?? '');
  if (!m || !Number.isFinite(contextMs)) return null;
  const ctx = new Date(contextMs);
  return Date.UTC(ctx.getUTCFullYear(), ctx.getUTCMonth(), +m[1], +m[2].slice(0, 2), +m[2].slice(2));
}

/** Parse one OBS/FCST VA CLD polygon tail: "N3135 E13043 - N3129 E13034 - ..." */
export function parseVaacCloudPolygon(text) {
  // Advisory polygons separate pairs with " - " (and sometimes run pairs
  // together with extra whitespace); strip separators before pairing.
  const tokens = String(text)
    .split(/\s+/)
    .filter((t) => t && t !== '-');
  const pts = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const p = parseVaacPositionPair(tokens[i], tokens[i + 1]);
    if (!p) return null;
    pts.push([p.lon, p.lat]);
  }
  if (pts.length < 3) return null;
  pts.push([...pts[0]]);
  return pts;
}

/**
 * Parse full ICAO volcanic-ash advisory text into a renderable record.
 * Returns null on unparseable input (caller degrades; never fabricates).
 */
export function parseVaacAdvisoryText(rawText) {
  if (typeof rawText !== 'string' || rawText.length < 100) return null;
  const text = rawText.replace(/\s+/g, ' ');
  // Targeted field regexes beat the generic "next KEY:" splitter: ICAO
  // advisories use compound field names (SUMMIT ELEV, ADVISORY NR, ...).
  const nextField =
    '(?=\\s+(?:SUMMIT ELEV|ADVISORY NR|INFO SOURCE|ERUPTION DETAILS|OBS VA DTG|FCST VA CLD|RMK|NXT ADVISORY):)';
  const volcanoMatch = /VOLCANO:\s*(.+?)\s+(\d{6})\b/.exec(text);
  const areaMatch = new RegExp(`AREA:\\s*(.+?)${nextField}`).exec(text);
  const eruptionMatch = new RegExp(
    `ERUPTION DETAILS:\\s*(.+?)${nextField}`,
  ).exec(text);
  const dtgMs = parseVaacDtg((/DTG:\s*(\d{8}\/\d{4}Z)/.exec(text) || [])[1]);
  if (!Number.isFinite(dtgMs)) return null;
  if (!volcanoMatch) return null;
  const summit = parseVaacPositionPair(
    (/PSN:\s*([NSEW]\d{4,6}(?:\.\d+)?)/.exec(text) || [])[1],
    (/PSN:\s*[NSEW]\d{4,6}(?:\.\d+)?\s+([NSEW]\d{5,7}(?:\.\d+)?)/.exec(text) || [])[1],
  );
  const advisoryNr = (/ADVISORY NR:\s*(\d{4}\/\d{1,4})/.exec(text) || [])[1] ?? null;

  const clouds = [];
  const obsDtg = parseDayTimeDtg((/OBS VA DTG:\s*(\d{2}\/\d{4}Z)/.exec(text) || [])[1], dtgMs);
  const obsCloud = (/OBS VA CLD:\s*(.+?)(?=\s(?:FCST|RMK|NXT)\b)/s.exec(text) || [])[1];
  if (obsCloud && !/NO VA (?:EXP|OBS)/.test(obsCloud)) {
    const levels = /^(SFC\/FL\d+|FL\d+\/\d+)\s+/.exec(obsCloud);
    const polyText = levels ? obsCloud.slice(levels[0].length) : obsCloud;
    const mov = /MOV\s+([NSEW]{1,3})\s+(\d+)KT/.exec(obsCloud);
    const polygon = /WI\s+\d+NM/.test(obsCloud)
      ? 'vicinity' // "WI 10NM OF SUMMIT": point vicinity, no polygon published
      : parseVaacCloudPolygon(polyText.split(/MOV\b/)[0]);
    clouds.push({
      kind: 'observed',
      tauHours: 0,
      dtgMs: obsDtg,
      levels: levels ? levels[1] : null,
      polygon,
      movement: mov ? { fromCompass: mov[1], speedKt: Number(mov[2]) } : null,
    });
  }
  for (const m of text.matchAll(/FCST VA CLD \+(\d+)\s*HR:\s*(.+?)(?=\sFCST VA CLD|\sRMK:|\sNXT ADVISORY:|$)/gs)) {
    const body = m[2].trim();
    if (/NO VA EXP/.test(body)) continue;
    const dtg = parseDayTimeDtg((/^(\d{2}\/\d{4}Z)/.exec(body) || [])[1], dtgMs);
    const levels = /^(SFC\/FL\d+|FL\d+\/\d+)\s+/.exec(body.replace(/^\d{2}\/\d{4}Z\s*/, ''));
    const polyText = body.replace(/^\d{2}\/\d{4}Z\s*/, '').replace(/^(SFC\/FL\d+|FL\d+\/\d+)\s+/, '');
    const polygon = parseVaacCloudPolygon(polyText);
    if (!polygon) continue;
    clouds.push({ kind: 'forecast', tauHours: Number(m[1]), dtgMs: dtg, levels: levels?.[1] ?? null, polygon });
  }
  const nextAdvisory = parseVaacDtg((/NXT ADVISORY:\s*(\d{8}\/\d{4}Z)=?/.exec(text) || [])[1]);
  return {
    volcano: volcanoMatch[1].trim(),
    volcanoId: volcanoMatch[2],
    dtgMs,
    advisoryNumber: advisoryNr,
    summit, // may be null when the advisory omits PSN
    area: areaMatch ? areaMatch[1].trim() : null,
    eruptionDetails: eruptionMatch ? eruptionMatch[1].trim() : null,
    clouds,
    nextAdvisoryMs: nextAdvisory,
    rawLength: rawText.length,
  };
}

/**
 * Parse the Tokyo VAAC advisory list page.
 * Row shape: `<tr ...> 2026/09/26 23:50:00 23:50 UTC, 26 Sep. 2026 SHEVELUCH RUSSIA 2026/343 <a href="TextData/...">`.
 * Returns latest-first rows, bounded.
 */
export function parseVaacAdvisoryList(html, baseUrl = TOKYO_VAAC_LIST_URL) {
  if (typeof html !== 'string') return [];
  const rows = [];
  const rowRe =
    /(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\s+[^<]*?([A-Z][A-Z ()'.-]{1,80}?)\s+([A-Z][A-Z ()'.-]{1,60}?)\s+(\d{4}\/\d{1,4})\s*<a[^>]*href="(TextData\/[^"]+)"[^>]*>/g;
  let m;
  while ((m = rowRe.exec(html)) && rows.length < MAX_LIST_ROWS) {
    const [ts, volcano, country, advisoryNumber, href] = [m[1], m[2], m[3], m[4], m[5]];
    const ms = Date.parse(ts.replace(/\//g, '-').replace(' ', 'T') + 'Z');
    if (!Number.isFinite(ms)) continue;
    let url = href;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }
    rows.push({
      id: `${volcano}::${advisoryNumber}`,
      issuedAtMs: ms,
      volcano: volcano.trim(),
      country: country.trim(),
      advisoryNumber,
      href: url,
    });
  }
  return rows;
}

/** Keep only the latest advisory per volcano. */
export function latestAdvisoryPerVolcano(rows) {
  const byVolcano = new Map();
  for (const row of rows) {
    const prev = byVolcano.get(row.volcano);
    if (!prev || row.issuedAtMs > prev.issuedAtMs) byVolcano.set(row.volcano, row);
  }
  return [...byVolcano.values()].sort((a, b) => b.issuedAtMs - a.issuedAtMs);
}

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

const cappedText = async (response, cap, signal) => {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    if (text.length > cap) throw new Error('VAAC response too large');
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > cap) {
      await reader.cancel();
      throw new Error('VAAC response too large');
    }
  }
  return text + decoder.decode();
};

/**
 * Fetch the list, keep the latest advisory per volcano (bounded), fetch and
 * parse each advisory body. Honest degraded result on any failure.
 */
export function createVaacSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  listUrl = VAAC_PROXY_PATH,
  listBaseUrl = TOKYO_VAAC_LIST_URL,
  maxAdvisories = MAX_ADVISORY_FETCHES,
  timeoutMs = 20_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('VAAC request timed out')),
        timeoutMs,
      );
      const get = async (url, cap) => {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
          headers: { Accept: 'text/html,application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`VAAC HTTP ${response.status}`);
        }
        return cappedText(response, cap, controller.signal);
      };
      try {
        signal?.throwIfAborted();
        const listHtml = await get(listUrl, 512 * 1024);
        const rows = latestAdvisoryPerVolcano(parseVaacAdvisoryList(listHtml, listBaseUrl));
        const advisories = [];
        for (const row of rows.slice(0, maxAdvisories)) {
          try {
            const bodyHtml = await get(row.href, ADVISORY_BYTES_CAP);
            const advisory = parseVaacAdvisoryText(stripTags(bodyHtml));
            if (advisory) advisories.push({ ...advisory, listHref: row.href, country: row.country });
          } catch {
            // One bad advisory never kills the batch (per-part degradation).
          }
        }
        return {
          advisories,
          fetchedAt: Date.now(),
          source: 'Tokyo VAAC (JMA)',
          coverage: 'Asia-Pacific volcanoes; other VAACs via the documented proxy additions.',
          unavailable: advisories.length === 0,
          reason: advisories.length === 0 ? 'No advisories parsed — feed may be down' : null,
        };
      } catch (e) {
        if (controller.signal.aborted) throw e;
        return {
          advisories: [],
          fetchedAt: Date.now(),
          source: 'Tokyo VAAC (JMA)',
          coverage: 'Asia-Pacific volcanoes.',
          unavailable: true,
          reason: e?.message || 'VAAC feed unavailable',
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

export const ASH_CLOUD_COLORS = Object.freeze({
  observed: '#ff8c42',
  forecast: '#ffb26b',
});

/**
 * Render the advisory list panel into a DOM container. Framework-free, so it
 * can mount in the app's existing panel tray. Degraded state is explicit:
 * volcanoes-layer context + "feed unavailable" + the upgrade path.
 */
export function renderAshPanel(container, snapshot, { onRefresh = null } = {}) {
  if (!container || typeof document === 'undefined') return;
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'vaac-ash-panel';
  const title = document.createElement('h3');
  title.textContent = '🌋 Volcanic Ash Advisories';
  root.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'vaac-ash-meta';
  const fetched = snapshot?.fetchedAt
    ? new Date(snapshot.fetchedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : 'never';
  meta.textContent = `Source: ${snapshot?.source ?? 'Tokyo VAAC (JMA)'} · fetched ${fetched}`;
  root.appendChild(meta);

  if (!snapshot || snapshot.unavailable) {
    const warn = document.createElement('div');
    warn.className = 'vaac-ash-unavailable';
    warn.textContent =
      `VAAC feed unavailable${snapshot?.reason ? `: ${snapshot.reason}` : ''}. ` +
      'Volcano summit locations remain available on the Volcanoes (US) layer; ' +
      'no ash-cloud geometry is rendered. Upgrade path: wire the same-origin ' +
      'proxy api/vaac.js per INTEGRATION.md (Tokyo VAAC sends no CORS headers, ' +
      'so browsers cannot fetch it directly).';
    root.appendChild(warn);
  } else if (!snapshot.advisories.length) {
    const empty = document.createElement('div');
    empty.className = 'vaac-ash-empty';
    empty.textContent =
      'No active ash advisories from Tokyo VAAC right now. ' +
      'Coverage is Asia-Pacific; other VAACs can be added via the proxy.';
    root.appendChild(empty);
  } else {
    const list = document.createElement('ul');
    list.className = 'vaac-ash-list';
    for (const a of snapshot.advisories) {
      const item = document.createElement('li');
      const head = document.createElement('strong');
      head.textContent = `${a.volcano}${a.country ? ` (${a.country})` : ''}`;
      item.appendChild(head);
      const detail = document.createElement('div');
      const dtg = new Date(a.dtgMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      detail.textContent =
        `Advisory ${a.advisoryNumber ?? '?'} · issued ${dtg} · ` +
        a.clouds.map((c) => cloudSummary(c)).join(', ') || 'no ash cloud polygons';
      item.appendChild(detail);
      if (a.eruptionDetails) {
        const erup = document.createElement('div');
        erup.className = 'vaac-ash-eruption';
        erup.textContent = a.eruptionDetails;
        item.appendChild(erup);
      }
      list.appendChild(item);
    }
    root.appendChild(list);
  }

  if (typeof onRefresh === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Refresh advisories';
    btn.addEventListener('click', onRefresh);
    root.appendChild(btn);
  }
  container.appendChild(root);
  return root;
}

/** One-line summary of a VAAC ash cloud for the advisory list. */
export function cloudSummary(cloud) {
  if (!cloud || typeof cloud !== 'object') return '';
  return cloud.kind === 'observed'
    ? `observed ${cloud.levels ?? ''}`.trim()
    : `+${cloud.tauHours}h forecast`;
}

/** Cesium entities for one advisory: observed + forecast cloud polygons, one label. */
export function ashAdvisoryEntities(advisory, { cesium = Cesium } = {}) {
  const entities = [];
  const anchor = advisory.summit ?? null;
  const anchorPos = anchor
    ? cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat)
    : null;
  const labelPos = anchorPos ?? cesium.Cartesian3.fromDegrees(0, 0);
  for (const [i, cloud] of advisory.clouds.entries()) {
    if (!Array.isArray(cloud.polygon)) continue; // 'vicinity' clouds: label only
    const positions = cesium.Cartesian3.fromDegreesArray(
      cloud.polygon.flatMap(([lon, lat]) => [lon, lat]),
    );
    const color = cesium.Color.fromCssColorString(
      cloud.kind === 'observed' ? ASH_CLOUD_COLORS.observed : ASH_CLOUD_COLORS.forecast,
    ).withAlpha(cloud.kind === 'observed' ? 0.4 : 0.25);
    entities.push(
      new cesium.Entity({
        id: `vaac-ash:${advisory.volcanoId}:${advisory.advisoryNumber}:${cloud.kind}:${cloud.tauHours}`,
        polygon: {
          hierarchy: new cesium.PolygonHierarchy(positions),
          material: new cesium.ColorMaterialProperty(color),
        },
        polyline: {
          positions,
          clampToGround: true,
          width: 1.5,
          material: new cesium.ColorMaterialProperty(color.withAlpha(0.9)),
        },
      }),
    );
    if (i === 0) entities[entities.length - 1].cloudCount = advisory.clouds.length;
  }
  entities.push(
    new cesium.Entity({
      id: `vaac-ash:${advisory.volcanoId}:label`,
      position: labelPos,
      point: {
        pixelSize: 9,
        color: new cesium.ConstantProperty(
          cesium.Color.fromCssColorString(ASH_CLOUD_COLORS.observed),
        ),
        outlineColor: cesium.Color.BLACK,
        outlineWidth: 1,
      },
      label: {
        text: `🌋 ${advisory.volcano} · VA ${advisory.advisoryNumber ?? ''}`,
        font: '13px sans-serif',
        fillColor: cesium.Color.WHITE,
        outlineColor: cesium.Color.BLACK,
        outlineWidth: 2,
        style: cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new cesium.Cartesian2(0, -20),
        showBackground: true,
        backgroundColor: cesium.Color.BLACK.withAlpha(0.45),
      },
      description:
        `Volcanic ash advisory ${advisory.advisoryNumber ?? ''} for ${advisory.volcano} ` +
        `(Tokyo VAAC). Observed + forecast ash cloud polygons from the official advisory text.`,
    }),
  );
  return entities;
}
