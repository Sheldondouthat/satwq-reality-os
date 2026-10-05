/**
 * Wave 9 — Morning briefing audio (GET /api/morning-briefing).
 *
 * Composes a TTS-clean spoken briefing script from five pinned keyless
 * public upstreams (SWPC planetary K-index, NWS active alerts, USGS all-day
 * quakes, NOAA GML Mauna Loa CO2, Frankfurter ECB FX) and exposes it as JSON
 * with per-section spoken lines, source links, and a mandatory honesty block.
 * The frontier 🔊 ticker plays the script through the browser's built-in
 * speech synthesis (keyless, $0, client-side) — this route returns TEXT only,
 * never audio bytes.
 *
 * TTS-CLEAN CONTRACT (podcast-skill rules, machine-checked in tests):
 *  - the final `script` contains NO digit characters anywhere; every number
 *    is spelled out in words ("six point two", "twenty twenty-six");
 *  - upstream free text (quake place names, alert event names) is passed
 *    through sanitizeDigits() so "5km E of Foo" can never leak digits;
 *  - complete sentences only; times verbalized ("nineteen forty-two U T C");
 *  - URLs live in `links[]`, never in the spoken script.
 *
 * SECTIONS (each 1 pinned upstream fetch, run in parallel via
 * Promise.allSettled — never sequential x 20s timeouts on a Worker):
 *   spacewx  SWPC 1-minute planetary K-index → current Kp + G-scale words
 *   nws      api.weather.gov active alerts → warning counts by event type
 *   quakes   USGS all-day feed → M>=4.5 count (24h) + largest quake
 *   co2      NOAA GML daily Mauna Loa CSV → latest ppm + year-ago delta
 *            (parseCo2Csv/pickLatestAndYearAgo REUSED from wave5/co2.js)
 *   fx       Frankfurter ECB daily reference → EUR/GBP/JPY per USD
 *
 * HONESTY: machine-composed narration, figures rounded to spoken precision,
 * per-section staleness labeled (ok:false/stale:true never hidden), not an
 * official alert product. Quiet sections say so explicitly ("no earthquakes
 * of magnitude four point five or greater") — never invented.
 */
import { parseCo2Csv, pickLatestAndYearAgo } from '../wave5/co2.js';
import { parseNwsAlerts } from '../wave6/alerts.js';

const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const CACHE_CONTROL = 'public, max-age=600';

// ---------------------------------------------------------------------------
// English number→words engine (pure, exported for tests).
// ---------------------------------------------------------------------------

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const ORDINALS = [
  '',
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'twenty-first',
  'twenty-second',
  'twenty-third',
  'twenty-fourth',
  'twenty-fifth',
  'twenty-sixth',
  'twenty-seventh',
  'twenty-eighth',
  'twenty-ninth',
  'thirtieth',
  'thirty-first',
];
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Integer → words. Non-finite → 'unknown' (never throws, never NaN). */
export function spellInt(v) {
  const n = numOrNull(v);
  if (n == null) return 'unknown';
  if (n < 0) return `minus ${spellInt(-n)}`;
  const i = Math.floor(n);
  if (i < 20) return ONES[i];
  if (i < 100) {
    const t = Math.floor(i / 10);
    const r = i % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}-${ONES[r]}`;
  }
  if (i < 1000) {
    const h = Math.floor(i / 100);
    const r = i % 100;
    return r === 0 ? `${ONES[h]} hundred` : `${ONES[h]} hundred ${spellInt(r)}`;
  }
  if (i < 1_000_000) {
    const th = Math.floor(i / 1000);
    const r = i % 1000;
    return r === 0
      ? `${spellInt(th)} thousand`
      : `${spellInt(th)} thousand ${spellInt(r)}`;
  }
  if (i < 1_000_000_000) {
    const m = Math.floor(i / 1_000_000);
    const r = i % 1_000_000;
    return r === 0
      ? `${spellInt(m)} million`
      : `${spellInt(m)} million ${spellInt(r)}`;
  }
  return 'a very large number';
}

/** Float → words, rounding to `decimals` places ("six point two"). */
export function spellFloat(v, decimals = 1) {
  const n = numOrNull(v);
  if (n == null) return 'unknown';
  if (!Number.isFinite(decimals) || decimals < 0) decimals = 1;
  decimals = Math.min(6, Math.floor(decimals));
  const rounded = Number(n.toFixed(decimals));
  const intPart = Math.trunc(rounded);
  if (decimals === 0) return spellInt(intPart);
  const fracStr = Math.abs(rounded - intPart)
    .toFixed(decimals)
    .slice(2)
    .replace(/0+$/, '');
  const sign = rounded < 0 && intPart === 0 ? 'minus ' : '';
  if (fracStr === '') return `${sign}${spellInt(Math.abs(intPart))}`;
  const digits = [...fracStr].map((d) => ONES[Number(d)]).join(' ');
  return `${sign}${spellInt(Math.abs(intPart))} point ${digits}`;
}

/** Year → words ("twenty twenty-six", "two thousand nine"). */
export function spellYear(v) {
  const n = numOrNull(v);
  if (n == null) return 'unknown';
  const y = Math.floor(Math.abs(n));
  if (y >= 2000 && y < 2010) {
    const r = y % 100;
    return r === 0 ? 'two thousand' : `two thousand ${spellInt(r)}`;
  }
  if (y >= 2010 && y < 2100) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    if (lo === 0) return `${spellInt(hi)} hundred`;
    // Year convention drops the hyphen: "twenty six", not "twenty-six".
    return `${spellInt(hi)} ${spellInt(lo).replace(/-/g, ' ')}`;
  }
  if (y >= 1100 && y < 2000) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;
    if (lo === 0) return `${spellInt(hi)} hundred`;
    if (lo < 10) return `${spellInt(hi)} oh ${ONES[lo]}`;
    return `${spellInt(hi)} ${spellInt(lo).replace(/-/g, ' ')}`;
  }
  return spellInt(y);
}

/** Day-of-month → ordinal words ("fourth", "twenty-first"). */
export function spellOrdinal(v) {
  const n = numOrNull(v);
  if (n == null) return 'unknown';
  const d = Math.floor(n);
  if (d >= 1 && d <= 31) return ORDINALS[d];
  return spellInt(d);
}

/** UTC date → "Sunday, October fourth, twenty twenty-six". */
export function spellDateUTC(ms) {
  const t = numOrNull(ms);
  if (t == null || !Number.isFinite(t)) return 'an unknown date';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return 'an unknown date';
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${spellOrdinal(d.getUTCDate())}, ${spellYear(d.getUTCFullYear())}`;
}

/** UTC clock time → "nineteen forty-two U T C" (minutes with oh-padding). */
export function spellTimeUTC(ms) {
  const t = numOrNull(ms);
  if (t == null || !Number.isFinite(t)) return 'an unknown time';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return 'an unknown time';
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const minWords = m < 10 ? `oh ${ONES[m]}` : spellInt(m);
  return `${spellInt(h)} ${minWords} U T C`;
}

/**
 * Replace every digit run in upstream free text with spelled words, so place
 * names like "5km E of Foo" or headlines with years can never leak digits
 * into the spoken script. A spelled number glued to a letter on either side
 * gets a separating space ("fivekm" → "five km", "M6.2" → "M six point two")
 * so TTS reads it as separate words. Non-string → ''.
 */
export function sanitizeDigits(text) {
  const s = String(text ?? '');
  return s.replace(/\d+(?:\.\d+)?/g, (run, offset, whole) => {
    const words = run.includes('.') ? spellFloat(run, 6) : spellInt(run);
    const prev = whole[offset - 1] ?? '';
    const next = whole[offset + run.length] ?? '';
    const glued = /[A-Za-z]/.test(prev) || /[A-Za-z]/.test(next);
    if (!glued) return words;
    const lead = /[A-Za-z]/.test(prev) ? ' ' : '';
    const trail = /[A-Za-z]/.test(next) ? ' ' : '';
    return `${lead}${words}${trail}`;
  });
}

/** Machine check for the TTS-clean contract: no digit chars in `script`. */
export function assertNoDigits(script) {
  if (typeof script !== 'string') throw new Error('briefing_script_not_string');
  if (/\d/.test(script)) {
    const m = script.match(/.{0,24}\d.{0,24}/);
    throw new Error(`briefing_digit_leak: …${m ? m[0] : '?'}…`);
  }
}

// ---------------------------------------------------------------------------
// Pure section speakers (exported for tests). Each takes parsed upstream
// data and returns { spoken } — a complete-sentence TTS-clean paragraph —
// or null when the payload is unparseable (section then goes ok:false).
// ---------------------------------------------------------------------------

export function speakSpacewx(kJson, nowMs = Date.now()) {
  const rows = Array.isArray(kJson) ? kJson : [];
  let latest = null;
  for (const r of rows) {
    const t = Date.parse(r?.time_tag ?? '');
    if (!Number.isFinite(t) || t > nowMs + 5 * 60 * 1000) continue;
    const kp = numOrNull(r?.kp_index);
    if (kp == null) continue;
    if (!latest || t > latest.t) latest = { t, kp };
  }
  if (!latest) return null;
  const kpWords = spellFloat(Math.round(latest.kp * 10) / 10, 1);
  const g = Math.floor(latest.kp);
  let storm;
  if (g >= 9) storm = 'a gee five class extreme geomagnetic storm';
  else if (g >= 8) storm = 'a gee four class severe geomagnetic storm';
  else if (g >= 7) storm = 'a gee three class strong geomagnetic storm';
  else if (g >= 6) storm = 'a gee two class moderate geomagnetic storm';
  else if (g >= 5) storm = 'a gee one class minor geomagnetic storm';
  else storm = null;
  const tail = storm
    ? ` That is ${storm}. Aurora may be visible unusually far from the poles, and sensitive systems like power grids and satellite navigation can feel effects at these levels.`
    : ' That is below geomagnetic storm thresholds.';
  return {
    spoken: `Space weather: the planetary K index is currently ${kpWords}.${tail}`,
  };
}

export function speakNws(alertsJson) {
  let parsed;
  try {
    parsed = parseNwsAlerts(alertsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const total = parsed.length;
  if (total === 0) {
    return { spoken: 'Weather: there are no active weather alerts right now.' };
  }
  const counts = new Map();
  for (const a of parsed) {
    const e = sanitizeDigits(String(a?.event ?? 'alert').trim() || 'alert');
    counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(
      ([event, n]) =>
        `${spellInt(n)} ${event.toLowerCase()}${n === 1 ? '' : 's'}`,
    );
  const list =
    top.length > 1
      ? `${top.slice(0, -1).join(', ')}, and ${top[top.length - 1]}`
      : top[0];
  return {
    spoken: `Weather: there ${total === 1 ? 'is one active weather alert' : `are ${spellInt(total)} active weather alerts`} across the United States, including ${list}.`,
  };
}

const QUAKE_MAG_MIN = 4.5;
const QUAKE_WINDOW_MS = 24 * 3600 * 1000;

export function speakQuakes(geojson, nowMs = Date.now()) {
  const features = Array.isArray(geojson?.features) ? geojson.features : null;
  if (!features) return null;
  const recent = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const mag = numOrNull(p.mag);
    const time = numOrNull(p.time);
    if (mag == null || time == null) continue;
    if (mag < QUAKE_MAG_MIN) continue;
    if (nowMs - time > QUAKE_WINDOW_MS || time > nowMs + 5 * 60 * 1000)
      continue;
    recent.push({
      mag,
      time,
      place: sanitizeDigits(String(p.place ?? 'an unknown location')),
    });
  }
  if (recent.length === 0) {
    return {
      spoken: `Earthquakes: no earthquakes of magnitude ${spellFloat(QUAKE_MAG_MIN, 1)} or greater in the last ${spellInt(24)} hours.`,
    };
  }
  recent.sort((a, b) => b.mag - a.mag);
  const top = recent[0];
  const countWords = spellInt(recent.length);
  const head =
    recent.length === 1
      ? `one earthquake of magnitude ${spellFloat(QUAKE_MAG_MIN, 1)} or greater`
      : `${countWords} earthquakes of magnitude ${spellFloat(QUAKE_MAG_MIN, 1)} or greater`;
  return {
    spoken: `Earthquakes: ${head} in the last ${spellInt(24)} hours. The largest was magnitude ${spellFloat(Math.round(top.mag * 10) / 10, 1)}, ${top.place}.`,
  };
}

export function speakCo2(csvText) {
  let rows;
  try {
    rows = parseCo2Csv(csvText);
  } catch {
    return null;
  }
  const { latest, yearAgo } = pickLatestAndYearAgo(rows);
  if (!latest) return null;
  const ppmWords = spellFloat(Math.round(latest.ppm * 100) / 100, 2);
  const dateWords =
    `${MONTHS[latest.month - 1] ?? ''} ${spellOrdinal(latest.day)}`.trim();
  let delta = '';
  if (yearAgo) {
    const d = latest.ppm - yearAgo.ppm;
    const dir = d >= 0 ? 'higher' : 'lower';
    delta = ` That is about ${spellFloat(Math.round(Math.abs(d) * 100) / 100, 2)} parts per million ${dir} than a year ago.`;
  }
  return {
    spoken: `Carbon dioxide: the Mauna Loa observatory measured ${ppmWords} parts per million on ${dateWords}.${delta}`,
  };
}

export function speakFx(fxJson) {
  const rates = fxJson?.rates;
  if (!rates || typeof rates !== 'object') return null;
  const eur = numOrNull(rates.EUR);
  const gbp = numOrNull(rates.GBP);
  const jpy = numOrNull(rates.JPY);
  if (eur == null || gbp == null || jpy == null) return null;
  return {
    spoken: `Markets: one United States dollar buys ${spellFloat(Math.round(eur * 100) / 100, 2)} euros, ${spellFloat(Math.round(gbp * 100) / 100, 2)} British pounds, and ${spellFloat(Math.round(jpy * 10) / 10, 1)} Japanese yen, by the European Central Bank daily reference.`,
  };
}

// ---------------------------------------------------------------------------
// Section table: pinned upstreams, TTLs, parse, speak.
// ---------------------------------------------------------------------------

const SECTIONS = [
  {
    id: 'spacewx',
    title: 'Space weather (SWPC planetary K)',
    upstream: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    ttlMs: 15 * 60 * 1000,
    capBytes: 2_000_000,
    accept: 'application/json',
    parse: (text) => JSON.parse(text),
    speak: speakSpacewx,
    sources: ['https://www.swpc.noaa.gov/products/planetary-k-index'],
  },
  {
    id: 'nws',
    title: 'US weather alerts (NWS)',
    upstream:
      'https://api.weather.gov/alerts/active?status=actual&message_type=alert',
    ttlMs: 10 * 60 * 1000,
    capBytes: 4_000_000,
    accept: 'application/geo+json, application/json',
    parse: (text) => JSON.parse(text),
    speak: speakNws,
    sources: ['https://api.weather.gov/alerts/active'],
  },
  {
    id: 'quakes',
    title: 'Earthquakes (USGS, 24h)',
    upstream:
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    ttlMs: 15 * 60 * 1000,
    capBytes: 4_000_000,
    accept: 'application/geo+json, application/json',
    parse: (text) => JSON.parse(text),
    speak: speakQuakes,
    sources: ['https://earthquake.usgs.gov/'],
  },
  {
    id: 'co2',
    title: 'CO2 (NOAA GML Mauna Loa)',
    upstream: 'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.csv',
    ttlMs: 6 * 3600 * 1000,
    capBytes: 2_000_000,
    accept: 'text/csv, text/plain, */*',
    parse: (text) => text,
    speak: speakCo2,
    sources: ['https://gml.noaa.gov/ccgg/trends/'],
  },
  {
    id: 'fx',
    title: 'Currency reference (ECB via Frankfurter)',
    upstream: 'https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY',
    ttlMs: 6 * 3600 * 1000,
    capBytes: 64 * 1024,
    accept: 'application/json',
    parse: (text) => JSON.parse(text),
    speak: speakFx,
    sources: [
      'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/',
    ],
  },
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

// ---------------------------------------------------------------------------
// Pure briefing composer (exported for tests).
// ---------------------------------------------------------------------------

export function composeBriefing(sectionResults, nowMs = Date.now()) {
  const live = sectionResults.filter((s) => s.ok && s.spoken);
  const dateLine = spellDateUTC(nowMs);
  const timeLine = spellTimeUTC(nowMs);
  const greeting = `Good morning. It is ${dateLine}. Here is your Earth and sky briefing, generated from live public data as of ${timeLine}.`;
  const body = live.map((s) => s.spoken).join(' ');
  const gaps = sectionResults.filter((s) => !s.ok);
  const gapLine = gaps.length
    ? ` ${gaps.length === live.length + gaps.length ? 'Every data source failed this run' : `The ${gaps.map((g) => g.title).join(', ')} ${gaps.length === 1 ? 'section is' : 'sections are'} unavailable right now`} — those parts are skipped, not guessed.`
    : '';
  const outro =
    ' That is the briefing. Sources and links travel with the text version. This narration was composed by machine from public data feeds, and is not an official alert product.';
  const script = `${greeting} ${body}${gapLine}${outro}`
    .replace(/\s+/g, ' ')
    .trim();
  assertNoDigits(script); // TTS-clean contract: throws on any digit leak
  const wordCount = script.split(' ').filter(Boolean).length;
  const minutes = Math.max(1, Math.round(wordCount / 130));
  const estMinutes = `about ${spellInt(minutes)} minute${minutes === 1 ? '' : 's'}`;
  return { dateLine, script, wordCount, estMinutes };
}

const BRIEFING_HONESTY = {
  machineComposed:
    'This briefing is machine-composed narration from live public data feeds — not a human newscast and not an official alert product from any agency.',
  roundedFigures:
    'Figures are rounded to spoken precision (one decimal for magnitudes and K-index, two for currency and CO2). Exact values live at the linked sources.',
  sectionLag:
    'Each section evaluates on its own TTL-cached upstream fetch (10 min to 6 h); the spoken numbers lag real time by up to the section TTL. generatedAt marks composition time.',
  gapsAreLabeled:
    'A section with ok:false is named in the spoken gap line and in sections[]. Nothing is synthesized to fill a gap.',
  attribution:
    'Data: NOAA SWPC, National Weather Service, USGS, NOAA Global Monitoring Laboratory, European Central Bank via Frankfurter. Audio playback uses the device speech synthesizer — no audio is generated or stored server-side.',
};

// ---------------------------------------------------------------------------
// Fetch machinery (wave9 conventions): per-section TTL + retry cooldown +
// inflight dedupe + key-scoped stale fallback. Sections run in parallel via
// Promise.allSettled — never sequential x 20s timeouts on a Worker.
// ---------------------------------------------------------------------------

async function fetchTextCapped(section) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(section.upstream, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: section.accept },
    });
    if (!response.ok) {
      throw Object.assign(
        new Error(`${section.id}_upstream_${response.status}`),
        { status: 502 },
      );
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > section.capBytes)
      throw Object.assign(new Error(`${section.id}_upstream_too_large`), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`${section.id}_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

const sectionCache = new Map(); // sectionId -> {at, payload}
const inflight = new Map();
const failedAt = new Map();

async function evaluateSection(section) {
  const nowMs = Date.now();
  const hit = sectionCache.get(section.id);
  if (hit && nowMs - hit.at < section.ttlMs)
    return { ...hit.payload, stale: false };
  let op = inflight.get(section.id);
  if (!op) {
    const lastFail = failedAt.get(section.id) ?? -Infinity;
    if (
      nowMs - lastFail < RETRY_COOLDOWN_MS &&
      hit &&
      nowMs - hit.at < STALE_MS
    ) {
      return { ...hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const text = await fetchTextCapped(section);
        const parsed = section.parse(text);
        const said = section.speak(parsed, Date.now());
        if (!said) throw new Error(`${section.id}_unparseable`);
        const payload = {
          id: section.id,
          title: section.title,
          ok: true,
          stale: false,
          evaluatedAt: new Date().toISOString(),
          spoken: said.spoken,
          sources: section.sources,
          error: null,
        };
        sectionCache.set(section.id, { at: Date.now(), payload });
        return payload;
      } catch (error) {
        failedAt.set(section.id, Date.now());
        if (hit && Date.now() - hit.at < STALE_MS)
          return { ...hit.payload, stale: true };
        return {
          id: section.id,
          title: section.title,
          ok: false,
          stale: false,
          evaluatedAt: null,
          spoken: null,
          sources: section.sources,
          error: error?.message ?? 'unknown',
        };
      }
    })().finally(() => inflight.delete(section.id));
    inflight.set(section.id, op);
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

function parseSectionQuery(url) {
  const q = String(url ?? '').split('?')[1] ?? '';
  const params = new URLSearchParams(q);
  return (params.get('section') ?? '').trim();
}

/** Mount the wave-9 morning-briefing composer. */
export function morningBriefingProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const onlySection = parseSectionQuery(req.url);
    if (onlySection && !SECTION_IDS.includes(onlySection)) {
      return sendJson(
        res,
        400,
        { error: 'briefing_bad_section', valid: SECTION_IDS },
        'no-store',
      );
    }
    const selected = onlySection
      ? SECTIONS.filter((s) => s.id === onlySection)
      : SECTIONS;
    try {
      const settled = await Promise.allSettled(
        selected.map((s) => evaluateSection(s)),
      );
      const sections = settled.map((st, i) =>
        st.status === 'fulfilled'
          ? st.value
          : {
              id: selected[i].id,
              title: selected[i].title,
              ok: false,
              stale: false,
              evaluatedAt: null,
              spoken: null,
              sources: selected[i].sources,
              error: st.reason?.message ?? 'unknown',
            },
      );
      const composed = composeBriefing(sections);
      const links = [...new Set(sections.flatMap((s) => s.sources ?? []))];
      const payload = {
        generatedAt: new Date().toISOString(),
        dateLine: composed.dateLine,
        script: composed.script,
        wordCount: composed.wordCount,
        estMinutes: composed.estMinutes,
        sections: sections.map((s) => ({
          id: s.id,
          title: s.title,
          ok: s.ok,
          stale: !!s.stale,
          evaluatedAt: s.evaluatedAt,
          spoken: s.spoken,
          error: s.error,
          sources: s.sources,
        })),
        links,
        stale: sections.some((s) => s.stale),
        honesty: BRIEFING_HONESTY,
      };
      // All sections failed with no stale fallback: honest 502 (d99a470 precedent).
      if (sections.every((s) => !s.ok)) {
        return sendJson(
          res,
          502,
          { ...payload, error: 'briefing_all_upstream_failed' },
          'no-store',
        );
      }
      sendJson(res, 200, payload);
    } catch (error) {
      sendJson(
        res,
        502,
        {
          error: 'briefing_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: { attribution: BRIEFING_HONESTY.attribution },
        },
        'no-store',
      );
    }
  }

  return {
    name: 'morning-briefing',
    configureServer({ middlewares }) {
      middlewares.use('/api/morning-briefing', handler);
    },
  };
}

export const _morningBriefingInternals = {
  SECTIONS,
  SECTION_IDS,
  BRIEFING_HONESTY,
  spellInt,
  spellFloat,
  spellYear,
  spellOrdinal,
  spellDateUTC,
  spellTimeUTC,
  sanitizeDigits,
  assertNoDigits,
  speakSpacewx,
  speakNws,
  speakQuakes,
  speakCo2,
  speakFx,
  composeBriefing,
};
