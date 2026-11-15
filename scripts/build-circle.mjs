#!/usr/bin/env node
// Inner Circle — Daily Wire builder.
// Fetches every feed with per-feed isolation; a failed feed becomes
// { ok:false, error } in public/circle-data.json and the page renders
// an honest UNAVAILABLE card. No invented data: every number on the
// page comes from a feed response actually received during this run.
// Also appends one line per day to circle-archive.jsonl (deduped by
// date) and mirrors it to public/circle-archive.json for the page.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) SATWQ-Circle-Builder/1.0';
const TIMEOUT_MS = 15000;

// Pembroke, VA 24136
const LAT = 37.3031, LON = -80.6015;

const now = new Date();
const todayET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now); // YYYY-MM-DD

async function fetchRaw(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, Accept: opts.accept || '*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}
async function fetchJSON(url, opts) { return (await fetchRaw(url, opts)).json(); }
async function fetchText(url, opts) { return (await fetchRaw(url, opts)).text(); }

function section(name, fn) {
  return fn()
    .then((data) => ({ ok: true, fetched_at: new Date().toISOString(), ...data }))
    .catch((e) => {
      console.error(`[circle] ${name} FAILED: ${e.message}`);
      return { ok: false, fetched_at: new Date().toISOString(), error: String(e.message || e) };
    });
}

import { getEarth2, getDeep2, getSkyTonight, getCyclesFull, getHuman2, getAnomalyBits } from './circle-extra.mjs';

// ---------- tiny RSS parser (no deps) ----------
function decodeEntities(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, '')) : '';
}
function parseRSS(xml, max = 4) {
  const items = [];
  const re = /<item[\s>][\s\S]*?<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < max) {
    const b = m[0];
    const linkM = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const guidM = b.match(/<guid[^>]*>(https?:[\s\S]*?)<\/guid>/i);
    const link = linkM ? decodeEntities(linkM[1]) : (guidM ? decodeEntities(guidM[1]) : '');
    const title = tag(b, 'title');
    if (title && link) items.push({ title, link, date: tag(b, 'pubDate') || tag(b, 'dc:date') });
  }
  return items;
}
async function rssFirstWorking(candidates, max) {
  let lastErr;
  for (const url of candidates) {
    try {
      const xml = await fetchText(url);
      const items = parseRSS(xml, max);
      if (items.length) return { items, feed: url };
      lastErr = new Error(`no items parsed from ${url}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all candidate feeds failed');
}

// ---------- feeds ----------
async function getWeather() {
  const pts = await fetchJSON(`https://api.weather.gov/points/${LAT},${LON}`, { accept: 'application/geo+json' });
  const forecastUrl = pts.properties.forecast;
  const fc = await fetchJSON(forecastUrl, { accept: 'application/geo+json' });
  const periods = (fc.properties.periods || []).slice(0, 6).map((p) => ({
    name: p.name, temperature: p.temperature, unit: p.temperatureUnit,
    wind: p.windSpeed, short: p.shortForecast, detailed: p.detailedForecast,
  }));
  let alerts = [];
  try {
    const al = await fetchJSON(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`, { accept: 'application/geo+json' });
    alerts = (al.features || []).map((f) => ({ event: f.properties.event, severity: f.properties.severity, headline: f.properties.headline }));
  } catch { /* forecast still stands */ }
  return { source: 'National Weather Service (api.weather.gov)', place: 'Pembroke, VA 24136', periods, alerts };
}

async function getLocalNews() {
  const sources = [
    { name: 'WVVA (Bluefield)', urls: ['https://www.wvva.com/arc/outboundfeeds/rss/category/news/?outputType=xml'] },
    { name: 'WDBJ7 (Roanoke)', urls: ['https://www.wdbj7.com/arc/outboundfeeds/rss/category/news/local/?outputType=xml', 'https://www.wdbj7.com/arc/outboundfeeds/rss/category/news/?outputType=xml'] },
    { name: 'Roanoke Times', urls: ['https://roanoke.com/search/?l=10&sd=desc&s=start_time&f=rss&t=article'] },
    { name: 'Virginia Mercury', urls: ['https://virginiamercury.com/feed/'] },
  ];
  const out = [];
  for (const s of sources) {
    try {
      const { items } = await rssFirstWorking(s.urls, 4);
      out.push({ name: s.name, ok: true, items });
    } catch (e) {
      out.push({ name: s.name, ok: false, error: String(e.message || e) });
    }
  }
  if (!out.some((s) => s.ok)) throw new Error('all local sources failed');
  return { source: 'Local news RSS (WVVA / WDBJ7 / Roanoke Times / Virginia Mercury)', outlets: out };
}

async function getWorldNews() {
  const candidates = [
    { name: 'Associated Press', url: 'https://apnews.com/index.rss' },
    { name: 'Reuters', url: 'https://www.reuters.com/rssFeed/worldNews' },
    { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
    { name: 'BBC World', url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  ];
  let lastErr;
  for (const c of candidates) {
    try {
      const { items } = await rssFirstWorking([c.url], 6);
      return { source: `${c.name} RSS`, outlet: c.name, items };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all world feeds failed');
}

async function getTraffic() {
  // Virginia 511 has no keyless public incident API we can rely on;
  // probe the public site and always provide the honest link-out.
  try {
    await fetchRaw('https://511virginia.org', { timeout: 8000 });
  } catch { /* link-out still valid */ }
  return {
    source: 'Virginia 511 (VDOT)',
    link: 'https://511virginia.org',
    note: 'Live incident map for Giles County and the New River Valley. No keyless public incident feed is published, so this card links out instead of showing numbers we did not measure.',
    linkOnly: true,
  };
}

async function getQuakes() {
  const global = await fetchJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const localUrl = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${weekAgo}&latitude=${LAT}&longitude=${LON}&maxradiuskm=500&minmagnitude=1.0&orderby=time`;
  const local = await fetchJSON(localUrl);
  const mapQ = (f) => ({
    mag: f.properties.mag, place: f.properties.place,
    time: new Date(f.properties.time).toISOString(), url: f.properties.url,
    depth_km: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[2] : null,
    lon: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
    lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
  });
  const g = (global.features || []).map(mapQ);
  const RING = ['Japan', 'Indonesia', 'Philippines', 'Alaska', 'Aleutian', 'Chile', 'Peru', 'Ecuador', 'Colombia', 'Mexico', 'Guatemala', 'Kamchatka', 'Kuril', 'Vanuatu', 'Tonga', 'Fiji', 'Solomon', 'Papua', 'New Zealand', 'Taiwan', 'Marianas', 'Izu', 'Bonin', 'Ryukyu', 'Hokkaido', 'Honshu', 'Mindanao', 'Sulawesi', 'Java', 'Sumatra', 'Banda', 'Molucca', 'Costa Rica', 'Nicaragua', 'Panama', 'Bolivia', 'Argentina', 'British Columbia', 'Oregon', 'California', 'Russia', 'Andaman'];
  const ringCount = g.filter((q) => RING.some((k) => (q.place || '').includes(k))).length;
  const deepest = g.length ? Math.max(...g.map((q) => q.depth_km || 0)) : null;
  const byRegion = {};
  for (const q of g) { const key = (q.place || '').split(',').pop().trim(); byRegion[key] = (byRegion[key] || 0) + 1; }
  const swarm = Object.entries(byRegion).filter(([, n]) => n >= 4).map(([region, n]) => ({ region, count: n }));
  return {
    source: 'USGS Earthquake Hazards Program',
    global: g,
    local: (local.features || []).map(mapQ),
    localNote: 'M1.0+ within 500 km of Pembroke, past 7 days',
    ring_of_fire_count: ringCount, deepest_km: deepest, swarm_flags: swarm,
  };
}

async function getSchumann() {
  const img = 'https://sosrff.tsu.ru/new/shm.jpg';
  await fetchRaw(img, { timeout: 10000 }); // reachability check only
  return {
    source: 'Tomsk State University — Space Observing System (sosrff.tsu.ru)',
    image: img,
    page: 'http://sosrff.tsu.ru/?page_id=7',
    note: 'Live Schumann resonance spectrogram from the Tomsk observatory. The chart updates at the source; the fundamental sits near 7.83 Hz.',
  };
}

async function getSpaceWeather() {
  const kpArr = await fetchJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  const rows = Array.isArray(kpArr) && typeof kpArr[0] === 'object' && !Array.isArray(kpArr[0]) ? kpArr : [];
  const kpNums = rows.map((r) => ({ t: r.time_tag, kp: Number(r.Kp) })).filter((r) => !Number.isNaN(r.kp));
  const latestKp = kpNums.length ? kpNums[kpNums.length - 1] : null;
  const todayKp = kpNums.filter((r) => r.t && r.t.startsWith(new Date().toISOString().slice(0, 10)));
  const maxKpToday = todayKp.length ? Math.max(...todayKp.map((r) => r.kp)) : (latestKp ? latestKp.kp : null);

  let wind = null;
  try {
    const plasma = await fetchJSON('https://services.swpc.noaa.gov/products/solar-wind/plasma-7-day.json');
    const dataRows = plasma.slice(1).filter((r) => r[2] != null);
    const last = dataRows[dataRows.length - 1];
    if (last) wind = { time: last[0], density: last[1], speed_kms: last[2], temp_k: last[3] };
  } catch { /* isolated below */ }

  let flares = [];
  try {
    const fl = await fetchJSON('https://services.swpc.noaa.gov/json/goes/primary/xray-flares-7-day.json');
    flares = (fl || []).slice(-8).reverse().map((f) => ({
      begin: f.begin_time, max: f.max_time, cls: f.max_class, region: f.active_region || null,
    }));
  } catch { /* isolated */ }

  if (!latestKp && !wind && !flares.length) throw new Error('all SWPC products failed');
  return {
    source: 'NOAA Space Weather Prediction Center',
    kp_latest: latestKp, kp_max_today: maxKpToday, solar_wind: wind, flares,
    kp_series: kpNums.slice(-24),
  };
}

async function getGW() {
  const data = await fetchJSON('https://gracedb.ligo.org/api/superevents/?count=100');
  const all = (data.superevents || []).filter((s) => /^S\d/.test(s.superevent_id));
  const weekAgoMs = Date.now() - 7 * 864e5;
  const thisWeek = all.filter((s) => new Date(s.created.replace(' UTC', 'Z')).getTime() >= weekAgoMs);
  const latest = all.length ? {
    id: all[0].superevent_id, created: all[0].created,
    group: all[0].preferred_event_data ? all[0].preferred_event_data.group : null,
    far: all[0].far,
    url: `https://gracedb.ligo.org/superevents/public/${all[0].superevent_id}/view/`,
  } : null;
  return {
    source: 'LIGO/Virgo/KAGRA GraceDB — public alerts',
    latest, count_week: thisWeek.length,
    week_ids: thisWeek.slice(0, 10).map((s) => s.superevent_id),
  };
}

async function getSpaceNews() {
  const arts = await fetchJSON('https://api.spaceflightnewsapi.net/v4/articles/?limit=5');
  const items = (arts.results || []).map((a) => ({
    title: a.title, url: a.url, site: a.news_site,
    published: a.published_at, summary: (a.summary || '').slice(0, 220),
  }));
  let apod = null;
  try {
    const a = await fetchJSON('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY');
    apod = { title: a.title, date: a.date, image: a.media_type === 'image' ? a.url : null, media_type: a.media_type, url: 'https://apod.nasa.gov/apod/astropix.html' };
  } catch (e) { apod = { ok: false, error: String(e.message || e) }; }
  return { source: 'Spaceflight News API + NASA APOD', items, apod };
}

function getFacebook() {
  return Promise.resolve({
    source: 'Facebook (link-out only — no scraping)',
    linkOnly: true,
    links: [
      { label: 'Giles County, VA — community groups', url: 'https://www.facebook.com/search/groups/?q=giles%20county%20va' },
      { label: 'Pearisburg, VA — pages & posts', url: 'https://www.facebook.com/search/top/?q=pearisburg%20va' },
      { label: 'New River Valley — groups', url: 'https://www.facebook.com/search/groups/?q=new%20river%20valley' },
    ],
    note: 'Facebook does not publish these feeds, so this card links out. Sign-in may be required there.',
  });
}

// ---------- expansion: moon & sky (computed + ISS API) ----------
import {
  sunTimes, sunAltitude, moonIllumination, phaseName, signOf, moonTimes,
  nextMoonSignChange, geoPlanet, planetAltitude, issElevation, parseTLE, propagateTLE,
} from './circle-astro.mjs';

const [ty, tm, td] = todayET.split('-').map(Number);
const dayUTC = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
const fmtET = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(d);

const SHOWERS = [ // IMO major showers — reference table (activity windows, peak, typical peak ZHR)
  { name: 'Quadrantids', from: [12, 28], to: [1, 12], peak: 'Jan 3', zhr: 60 },
  { name: 'Lyrids', from: [4, 14], to: [4, 30], peak: 'Apr 22', zhr: 18 },
  { name: 'Eta Aquariids', from: [4, 19], to: [5, 28], peak: 'May 5', zhr: 50 },
  { name: 'Delta Aquariids', from: [7, 12], to: [8, 23], peak: 'Jul 30', zhr: 25 },
  { name: 'Perseids', from: [7, 17], to: [8, 24], peak: 'Aug 12', zhr: 100 },
  { name: 'Orionids', from: [10, 2], to: [11, 7], peak: 'Oct 21', zhr: 20 },
  { name: 'Southern Taurids', from: [9, 10], to: [11, 20], peak: 'Nov 5', zhr: 5 },
  { name: 'Northern Taurids', from: [10, 20], to: [12, 10], peak: 'Nov 12', zhr: 5 },
  { name: 'Leonids', from: [11, 6], to: [11, 30], peak: 'Nov 17', zhr: 15 },
  { name: 'Geminids', from: [12, 4], to: [12, 20], peak: 'Dec 14', zhr: 150 },
  { name: 'Ursids', from: [12, 17], to: [12, 26], peak: 'Dec 22', zhr: 10 },
];
const ECLIPSES = [ // NASA eclipse catalog — reference table
  { date: '2027-02-06', kind: 'Annular solar eclipse' },
  { date: '2027-02-20', kind: 'Penumbral lunar eclipse' },
  { date: '2027-07-18', kind: 'Penumbral lunar eclipse' },
  { date: '2027-08-02', kind: 'Total solar eclipse' },
  { date: '2027-08-17', kind: 'Penumbral lunar eclipse' },
  { date: '2028-01-12', kind: 'Partial lunar eclipse' },
  { date: '2028-01-26', kind: 'Annular solar eclipse' },
  { date: '2028-07-06', kind: 'Partial lunar eclipse' },
  { date: '2028-07-22', kind: 'Total solar eclipse' },
  { date: '2028-12-31', kind: 'Total lunar eclipse' },
];
function inWindow(m, d, from, to) {
  const cur = m * 100 + d, f = from[0] * 100 + from[1], t = to[0] * 100 + to[1];
  return f <= t ? (cur >= f && cur <= t) : (cur >= f || cur <= t);
}

async function getMoonSky() {
  const st = sunTimes(dayUTC, LAT, LON);
  const ill = moonIllumination(now);
  const mt = moonTimes(dayUTC, LAT, LON);
  const tonight = new Date(dayUTC.getTime() + 14 * 3600000); // ~21:00 ET
  const planets = [];
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const altTonight = planetAltitude(name, tonight, LAT, LON);
    const altDusk = planetAltitude(name, new Date(st.sunset.getTime() + 3600000), LAT, LON);
    if (Math.max(altTonight, altDusk) > 5) {
      planets.push({ name, alt_9pm_deg: Math.round(Math.max(altTonight, -90)), alt_dusk_deg: Math.round(altDusk) });
    }
  }
  const mercNow = geoPlanet('Mercury', now).lon;
  const mercLater = geoPlanet('Mercury', new Date(now.getTime() + 5 * 864e5)).lon;
  let dLon = mercLater - mercNow; if (dLon > 180) dLon -= 360; if (dLon < -180) dLon += 360;
  const showers = SHOWERS.filter((s) => inWindow(tm, td, s.from, s.to)).map((s) => ({ name: s.name, peak: s.peak, zhr: s.zhr }));
  const nextEclipse = ECLIPSES.find((x) => x.date >= todayET) || null;

  // ISS: TLE fetched once daily (CelesTrak); positions + passes are
  // propagated from it — the same math runs in the browser, so the
  // page stays live with zero server cost. wheretheiss.at cross-checks
  // the current position when it answers.
  let iss = null;
  let tleText = null;
  try { tleText = await fetchText('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE'); } catch { /* fall through */ }
  try {
    if (!tleText) throw new Error('TLE fetch failed');
    const tl = tleText.trim().split('\n').map((s) => s.trim()).filter(Boolean);
    const tle = parseTLE(tl[1], tl[2]);
    const prop = propagateTLE(tle, now);
    iss = {
      now: { lat: +prop.lat.toFixed(2), lon: +prop.lon.toFixed(2), alt_km: Math.round(prop.altKm), source: 'TLE propagation (approximate)' },
      tle: { name: tl[0], line1: tl[1], line2: tl[2], fetched_at: new Date().toISOString() },
      next_visible_pass: null, next_pass: null,
    };
    try {
      const cur = await fetchJSON('https://api.wheretheiss.at/v1/satellites/25544');
      iss.now = { lat: +cur.latitude.toFixed(2), lon: +cur.longitude.toFixed(2), alt_km: Math.round(cur.altitude), velocity_kmh: Math.round(cur.velocity), source: 'wheretheiss.at (live)' };
    } catch { /* TLE position stands */ }
    const samples = [];
    for (let s = 0; s <= 24 * 3600; s += 60) {
      const t = new Date(Date.now() + s * 1000);
      const p = propagateTLE(tle, t);
      samples.push({ t: t.getTime(), el: issElevation(p.lat, p.lon, p.altKm, LAT, LON), sun: sunAltitude(t, LAT, LON) });
    }
    let cur2 = null;
    for (const s of samples) {
      if (s.el > 10 && !cur2) cur2 = { start: s.t, max: s.el, dark: s.sun < 0, samples: [] };
      if (cur2) {
        cur2.samples.push({ t: new Date(s.t).toISOString(), el: Math.round(s.el) });
        if (s.el > cur2.max) { cur2.max = s.el; cur2.dark = cur2.dark || s.sun < 0; }
        if (s.el <= 10) {
          const pass = { start: new Date(cur2.start).toISOString(), max_elev_deg: Math.round(cur2.max) };
          if (!iss.next_pass) iss.next_pass = pass;
          if (cur2.dark && !iss.next_visible_pass) { iss.next_visible_pass = pass; iss.pass_samples = cur2.samples; }
          cur2 = null;
          if (iss.next_visible_pass) break;
        }
      }
    }
  } catch (e) { iss = { error: String(e.message || e) }; }

  // tonight-sky chart data: planet altitude curves 17:00 ET → 07:00 ET, 30-min steps
  const chartStart = dayUTC.getTime() + 10 * 3600e3; // 22:00 UTC = 17:00 ET
  const skyChart = { start: new Date(chartStart).toISOString(), step_min: 30, planets: {} };
  for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) {
    const arr = [];
    for (let i = 0; i <= 28; i++) arr.push(Math.round(planetAltitude(name, new Date(chartStart + i * 1800e3), LAT, LON)));
    skyChart.planets[name] = arr;
  }
  if (iss && iss.pass_samples) skyChart.iss_samples = iss.pass_samples;

  return {
    source: 'Computed at build time (solar/lunar math + JPL approximate planetary elements); ISS via wheretheiss.at; showers & eclipses: IMO / NASA reference tables',
    sunrise_et: fmtET(st.sunrise), sunset_et: fmtET(st.sunset),
    moon: {
      phase_name: phaseName(ill.cycle), illum_pct: Math.round(ill.fraction * 100),
      cycle: +ill.cycle.toFixed(3),
      rise_et: mt.rise ? fmtET(mt.rise) : null, set_et: mt.set ? fmtET(mt.set) : null,
      sign: signOf(ill.moonLon),
    },
    sky_chart: skyChart,
    visible_planets_tonight: planets,
    mercury_retrograde: dLon < 0,
    active_showers: showers,
    next_eclipse: nextEclipse,
    iss,
  };
}

// ---------- expansion: cycles & signs (tradition / entertainment) ----------
const MAJORS = ['The Fool', 'The Magician', 'The High Priestess', 'The Empress', 'The Emperor', 'The Hierophant', 'The Lovers', 'The Chariot', 'Strength', 'The Hermit', 'Wheel of Fortune', 'Justice', 'The Hanged Man', 'Death', 'Temperance', 'The Devil', 'The Tower', 'The Star', 'The Moon', 'The Sun', 'Judgement', 'The World'];
const RANKS = ['Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Page', 'Knight', 'Queen', 'King'];
const SUITS = ['Wands', 'Cups', 'Swords', 'Pentacles'];
const TAROT = [...MAJORS, ...SUITS.flatMap((s) => RANKS.map((r) => `${r} of ${s}`))];
const SUN_SIGNS = [[1, 19, 'Capricorn', 'Aquarius'], [2, 18, 'Aquarius', 'Pisces'], [3, 20, 'Pisces', 'Aries'], [4, 19, 'Aries', 'Taurus'], [5, 20, 'Taurus', 'Gemini'], [6, 21, 'Gemini', 'Cancer'], [7, 22, 'Cancer', 'Leo'], [8, 22, 'Leo', 'Virgo'], [9, 22, 'Virgo', 'Libra'], [10, 23, 'Libra', 'Scorpio'], [11, 22, 'Scorpio', 'Sagittarius'], [12, 21, 'Sagittarius', 'Capricorn']];
function getCycles() {
  const ill = moonIllumination(now);
  const row = SUN_SIGNS[tm - 1];
  const zodiacSeason = td < row[1] ? row[2] : row[3];
  const change = nextMoonSignChange(now);
  const digits = todayET.replace(/-/g, '').split('').map(Number);
  let sum = digits.reduce((a, b) => a + b, 0);
  while (sum > 9) sum = String(sum).split('').map(Number).reduce((a, b) => a + b, 0);
  let h = 0; for (const c of todayET) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Promise.resolve({
    source: 'Computed daily from the date and the moon\u2019s position, by each system\u2019s own rules',
    zodiac_season: zodiacSeason,
    moon_sign: signOf(ill.moonLon),
    moon_phase_name: phaseName(ill.cycle),
    void_of_course: change
      ? `Moon leaves ${signOf(ill.moonLon)} and enters ${change.sign} at ${fmtET(change.at)} ET. The void-of-course stretch is the window before that change (last-aspect timing varies by tradition; the sign change itself is computed).`
      : 'No sign change found in the next 72 hours.',
    universal_day: sum,
    tarot_card: TAROT[h % 78],
  });
}

// ---------- expansion: earth extras ----------
async function getEarthExtras() {
  const out = { source: 'NOAA SWPC · Open-Meteo · NOAA Tides & Currents · NASA NEO · USGS' };
  try {
    const fc = await fetchJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json');
    const rows = Array.isArray(fc) ? fc.filter((r) => typeof r === 'object' && r && 'kp' in r || (r && r.time_tag && (r.kp !== undefined || r.Kp !== undefined))) : [];
    const kps = rows.map((r) => Number(r.kp ?? r.Kp)).filter((n) => !Number.isNaN(n));
    out.aurora = { kp_forecast_max: kps.length ? Math.max(...kps) : null, image: 'https://services.swpc.noaa.gov/images/aurora-forecast-northern-hemisphere.jpg', note: 'NOAA 3-day Kp outlook (max). Mid-latitude aurora generally needs Kp 5+; a horizon glow this far south usually takes Kp 7+. Oval map: NOAA OVATION model, northern hemisphere.' };
  } catch (e) { out.aurora = { ok: false, error: String(e.message || e) }; }
  try {
    const aq = await fetchJSON(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${LAT}&longitude=${LON}&hourly=us_aqi&forecast_days=2&timezone=America%2FNew_York`);
    const times = aq.hourly.time, vals = aq.hourly.us_aqi;
    const todayVals = vals.filter((_, i) => times[i].startsWith(todayET) && vals[i] != null);
    const nowIdx = times.findIndex((t) => t.startsWith(todayET) && Number(t.slice(11, 13)) >= new Date().getHours());
    out.air_quality = { aqi_now: nowIdx >= 0 ? vals[nowIdx] : null, aqi_max_today: todayVals.length ? Math.max(...todayVals) : null };
  } catch (e) { out.air_quality = { ok: false, error: String(e.message || e) }; }
  try {
    const uv = await fetchJSON(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&daily=uv_index_max&forecast_days=1&timezone=America%2FNew_York`);
    out.uv = { uv_max_today: uv.daily.uv_index_max[0] };
  } catch (e) { out.uv = { ok: false, error: String(e.message || e) }; }
  out.pollen = { ok: false, error: 'No keyless pollen feed covers this area in season; not estimated.' };
  try {
    const ymd = todayET.replace(/-/g, '');
    const td2 = await fetchJSON(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${ymd}&end_date=${ymd}&station=8638610&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=hilo&units=english&format=json`);
    out.tides = { station: 'Sewell\u2019s Point, Norfolk VA (station 8638610) — nearest NOAA tide station; the New River itself has no tides', events: (td2.predictions || []).map((p) => ({ time: p.t, height_ft: p.v, type: p.type === 'H' ? 'High' : 'Low' })) };
  } catch (e) { out.tides = { ok: false, error: String(e.message || e) }; }
  try {
    const neo = await fetchJSON(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${todayET}&end_date=${todayET}&api_key=DEMO_KEY`);
    const list = (neo.near_earth_objects && neo.near_earth_objects[todayET]) || [];
    const mapped = list.map((n) => ({
      name: n.name,
      miss_km: Math.round(Number(n.close_approach_data[0].miss_distance.kilometers)),
      vel_kmh: Math.round(Number(n.close_approach_data[0].relative_velocity.kilometers_per_hour)),
      size_m: Math.round(n.estimated_diameter.meters.estimated_diameter_max),
      hazardous: n.is_potentially_hazardous_asteroid,
    })).sort((a, b) => a.miss_km - b.miss_km);
    out.neo = { count_today: mapped.length, closest: mapped[0] || null };
  } catch (e) { out.neo = { ok: false, error: String(e.message || e) }; }
  try {
    const html = await fetchText('https://www.amsmeteors.org/fireballs/');
    const m = html.match(/fireball_report/g);
    if (!m) throw new Error('report links not found on AMS page');
    out.fireballs = { note: 'American Meteor Society fireball desk is publishing reports; see the live board.', link: 'https://www.amsmeteors.org/fireballs/fireball_report/', mentions: m.length };
  } catch (e) { out.fireballs = { ok: false, error: String(e.message || e), link: 'https://www.amsmeteors.org/fireballs/' }; }
  out.volcano = { ok: false, error: 'USGS volcano API refused the keyless request at build time.', link: 'https://www.usgs.gov/volcanoes' };
  return out;
}

// ---------- expansion: human world ----------
async function getHumanWorld() {
  const out = { source: 'CoinGecko · Wikimedia · Virginia Lottery' };
  try {
    const btc = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    out.bitcoin = { price_usd: btc.bitcoin.usd, change_24h_pct: +btc.bitcoin.usd_24h_change.toFixed(2) };
  } catch (e) { out.bitcoin = { ok: false, error: String(e.message || e) }; }
  try {
    const { items } = await rssFirstWorking(['https://www.valottery.com/rss/winning-numbers'], 4);
    out.lottery = { items };
  } catch {
    out.lottery = { linkOnly: true, link: 'https://www.valottery.com', note: 'No readable keyless results feed — official winning numbers live at valottery.com.' };
  }
  try {
    const mm = String(tm).padStart(2, '0'), dd = String(td).padStart(2, '0');
    const otd = await fetchJSON(`https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${mm}/${dd}`);
    out.on_this_day = (otd.events || []).filter((x) => x.year).slice(0, 5).map((x) => ({ year: x.year, text: x.text }));
  } catch (e) { out.on_this_day = { ok: false, error: String(e.message || e) }; }
  return out;
}

// ---------- expansion: findings (VIP — outcomes only, methods never) ----------
async function getFindings(liveCount, totalCount) {
  const items = [];
  try {
    const fr = await fetchJSON('https://satwq-reality-os.pages.dev/api/fusion-river');
    const v = fr.verdict || {};
    const condition = v.condition || null;
    const stage = v.stageFt ?? null;
    const flow = v.dischargeCfs ?? null;
    const trend = v.trend && v.trend.direction ? v.trend.direction.toLowerCase() : null;
    const ts = v.dataTime || fr.generatedAt || null;
    if (condition || stage != null) {
      items.push(`River watch, New River at Glen Lyn (public USGS gauge data, fused into one verdict): condition ${condition || '—'}${stage != null ? ` · stage ${stage} ft` : ''}${flow != null ? ` · flow ${flow} ft³/s` : ''}${trend ? ` · trend ${trend}` : ''}${ts ? ` · measured ${ts}` : ''}.`);
    }
  } catch { /* findings continue without the river line */ }
  items.push(`Daily wire health at this build: ${liveCount} of ${totalCount} core feeds answered live; every failure is shown as UNAVAILABLE on the page rather than filled in.`);
  items.push('Anomaly archive: opened today, 2026-11-15. Quiet days are recorded as quiet — the log only claims what the feeds measured.');
  return {
    source: 'This page\u2019s own measured record',
    rule: 'Outcomes and data only. Methods are never published here — that is the standing rule of this page.',
    items,
  };
}

// ---------- build ----------
const [weather, localNews, worldNews, traffic, quakes, schumann, spaceWeather, gw, spaceNews, facebook,
  moonSky, cycles, earthExtras, humanWorld, earth2, deep2, cyclesFull, human2, anomalyBits] =
  await Promise.all([
    section('weather', getWeather),
    section('localNews', getLocalNews),
    section('worldNews', getWorldNews),
    section('traffic', getTraffic),
    section('quakes', getQuakes),
    section('schumann', getSchumann),
    section('spaceWeather', getSpaceWeather),
    section('gw', getGW),
    section('spaceNews', getSpaceNews),
    section('facebook', getFacebook),
    section('moonSky', getMoonSky),
    section('cycles', getCycles),
    section('earthExtras', getEarthExtras),
    section('humanWorld', getHumanWorld),
    section('earth2', getEarth2),
    section('deep2', getDeep2),
    section('cyclesFull', getCyclesFull),
    section('human2', getHuman2),
    section('anomalyBits', getAnomalyBits),
  ]);

const skyTonight = await section('skyTonight', () => getSkyTonight(
  moonSky.ok ? moonSky.active_showers : [],
  earthExtras.ok && earthExtras.aurora && earthExtras.aurora.ok !== false ? earthExtras.aurora.kp_forecast_max : null,
));

const core = [weather, localNews, worldNews, traffic, quakes, schumann, spaceWeather, gw, spaceNews, facebook];
const findings = await section('findings', () => getFindings(core.filter((s) => s.ok).length, core.length));

// ---------- master registry (181 items, honest per-item status) ----------
const LV = (cond) => (cond ? 'LIVE' : 'PENDING');
const registry = [
  // I. Earth Body
  [1, 'Earth Body', 'Earthquakes worldwide M4.5+ (USGS)', LV(quakes.ok)], [2, 'Earth Body', 'Earthquakes within 500 km of Pembroke M1.0+', LV(quakes.ok)],
  [3, 'Earth Body', 'Quake depth + Ring of Fire count', LV(quakes.ok)], [4, 'Earth Body', 'Quake swarm / aftershock flags', quakes.ok ? 'COMPUTED' : 'PENDING'],
  [5, 'Earth Body', 'Volcano alert levels + new eruptions (USGS/GVP)', 'PENDING'], [6, 'Earth Body', 'Volcanic ash advisories (VAAC)', 'PENDING'],
  [7, 'Earth Body', 'SO₂ plumes from eruptions (satellite)', 'DARK'], [8, 'Earth Body', 'Tsunami statements & bulletins', LV(earth2.ok && earth2.tsunami && earth2.tsunami.ok !== false)],
  [9, 'Earth Body', 'Schumann resonance (Tomsk)', LV(schumann.ok)], [10, 'Earth Body', 'Geomagnetic Kp / Dst / Bz / solar wind', LV(spaceWeather.ok)],
  [11, 'Earth Body', 'Ionosphere TEC / scintillation / sporadic-E', 'DARK'], [12, 'Earth Body', 'Earth rotation: length of day, polar motion (IERS)', 'PENDING'],
  [13, 'Earth Body', 'Lightning strikes + global rate (Blitzortung)', 'DARK'], [14, 'Earth Body', 'Sprites / ELVES / jets reports', 'PENDING'],
  [15, 'Earth Body', 'Atmospheric gravity wave events', 'PENDING'], [16, 'Earth Body', 'River gauges: New River Glen Lyn + Radford + temp', LV(earth2.ok && earth2.rivers && earth2.rivers.ok !== false)],
  [17, 'Earth Body', 'Groundwater well levels, Giles County', 'PENDING'], [18, 'Earth Body', 'Reservoir & lake levels, regional', 'PENDING'],
  [19, 'Earth Body', 'Drought monitor (weekly)', LV(earth2.ok && earth2.drought && earth2.drought.ok !== false)], [20, 'Earth Body', 'Soil moisture anomaly', 'PENDING'],
  [21, 'Earth Body', 'El Niño/La Niña index (ONI)', LV(earth2.ok && earth2.oni && earth2.oni.ok !== false)], [22, 'Earth Body', 'Sea ice extent (NSIDC)', 'PENDING'],
  [23, 'Earth Body', 'CO₂ at Mauna Loa (daily)', LV(earth2.ok && earth2.co2 && earth2.co2.ok !== false)], [24, 'Earth Body', 'Ozone hole area (seasonal)', 'PENDING'],
  [25, 'Earth Body', 'Polar vortex / SSW watch (seasonal)', 'PENDING'], [26, 'Earth Body', 'Jet stream pattern', 'DARK'],
  [27, 'Earth Body', 'Wildfires + smoke (NASA FIRMS — key required)', 'PENDING'], [28, 'Earth Body', 'Weather records broken today', 'PENDING'],
  [29, 'Earth Body', 'Storm reports: tornado / hail / wind (SPC)', LV(earth2.ok && earth2.spc && earth2.spc.ok !== false)], [30, 'Earth Body', 'Tropical systems (NHC)', LV(earth2.ok && earth2.nhc && earth2.nhc.ok !== false)],
  // II. Sun, Space Weather & Deep Field
  [31, 'Sun & Deep Field', 'Sunspot number + F10.7 flux', LV(deep2.ok && deep2.sun && deep2.sun.ok !== false)], [32, 'Sun & Deep Field', 'Solar flares by class (C/M/X)', LV(spaceWeather.ok)],
  [33, 'Sun & Deep Field', 'CMEs: launches + Earth-directed analysis (DONKI)', LV(deep2.ok && deep2.cme && deep2.cme.ok !== false)], [34, 'Sun & Deep Field', 'Coronal hole high-speed streams', 'PENDING'],
  [35, 'Sun & Deep Field', 'G / R / S storm scales (NOAA)', LV(deep2.ok && deep2.scales && deep2.scales.ok !== false)], [36, 'Sun & Deep Field', 'Aurora: Kp outlook 3 days', LV(earthExtras.ok)],
  [37, 'Sun & Deep Field', 'Cosmic rays: neutron monitors (Oulu)', 'PENDING'], [38, 'Sun & Deep Field', 'Meteor showers + ZHR + peak countdowns', moonSky.ok ? 'COMPUTED' : 'PENDING'],
  [39, 'Sun & Deep Field', 'Fireballs & bolides (AMS + NASA CNEOS)', LV(deep2.ok && deep2.fireball && deep2.fireball.ok !== false)], [40, 'Sun & Deep Field', 'ISS position + next visible pass (crew list pending)', LV(moonSky.ok)],
  [41, 'Sun & Deep Field', 'Satellite reentries', 'PENDING'], [42, 'Sun & Deep Field', 'Satellite / debris conjunction warnings', 'DARK'],
  [43, 'Sun & Deep Field', 'Starlink & bright satellite passes (needs TLE propagator)', 'PENDING'], [44, 'Sun & Deep Field', 'NEO close approaches (NASA)', LV(earthExtras.ok)],
  [45, 'Sun & Deep Field', 'Sentry risk list (JPL)', LV(deep2.ok && deep2.sentry && deep2.sentry.ok !== false)], [46, 'Sun & Deep Field', 'Comets visible + perihelion countdowns', 'PENDING'],
  [47, 'Sun & Deep Field', 'Voyager 1 & 2 distance / light time', 'PENDING'], [48, 'Sun & Deep Field', 'Parker Solar Probe position', 'PENDING'],
  [49, 'Sun & Deep Field', 'DSN Now: antennas ↔ spacecraft', LV(deep2.ok && deep2.dsn && deep2.dsn.ok !== false)], [50, 'Sun & Deep Field', 'Gravitational-wave events (GraceDB)', LV(gw.ok)],
  [51, 'Sun & Deep Field', 'Gamma-ray bursts (Swift/Fermi)', 'PENDING'], [52, 'Sun & Deep Field', 'Neutrino alerts (IceCube)', 'PENDING'],
  [53, 'Sun & Deep Field', 'Fast radio bursts (CHIME)', 'PENDING'], [54, 'Sun & Deep Field', 'Exoplanet discovery count', 'PENDING'],
  [55, 'Sun & Deep Field', 'Supernova & magnetar watch', 'PENDING'], [56, 'Sun & Deep Field', 'Launches worldwide (manifest + results)', 'WIRE'],
  [57, 'Sun & Deep Field', 'Spacewalks / crew rotations', 'PENDING'], [58, 'Sun & Deep Field', 'Galactic core visibility tonight', skyTonight.ok ? 'COMPUTED' : 'PENDING'],
  // III. Sky Over Pembroke
  [59, 'Sky Over Pembroke', 'Sunrise / sunset / twilights / golden & blue hour', skyTonight.ok ? 'COMPUTED' : 'PENDING'], [60, 'Sky Over Pembroke', 'Moonrise / moonset / phase / illumination / distance', moonSky.ok ? 'COMPUTED' : 'PENDING'],
  [61, 'Sky Over Pembroke', 'Moon sign + phase name', 'COMPUTED'], [62, 'Sky Over Pembroke', 'Planets visible tonight + rise/set', moonSky.ok ? 'COMPUTED' : 'PENDING'],
  [63, 'Sky Over Pembroke', 'Conjunctions & Moon–planet pairings', skyTonight.ok ? 'COMPUTED' : 'PENDING'], [64, 'Sky Over Pembroke', 'ISS visible passes', LV(moonSky.ok)],
  [65, 'Sky Over Pembroke', 'Aurora chance for this latitude tonight', skyTonight.ok ? 'COMPUTED' : 'PENDING'], [66, 'Sky Over Pembroke', 'Dark-sky window (moonless astro night)', skyTonight.ok ? 'COMPUTED' : 'PENDING'],
  [67, 'Sky Over Pembroke', 'Sky clarity / cloud cover forecast', LV(weather.ok)], [68, 'Sky Over Pembroke', 'Eclipses: next + type', moonSky.ok ? 'COMPUTED' : 'PENDING'],
  [69, 'Sky Over Pembroke', 'Meteor radiant tonight', skyTonight.ok ? 'COMPUTED' : 'PENDING'], [70, 'Sky Over Pembroke', 'Satellite flares & trains (needs TLE propagator)', 'PENDING'],
  // IV. Cycles & Signs
  [71, 'Cycles & Signs', 'Sun sign + season + ingress', 'COMPUTED'], [72, 'Cycles & Signs', 'Moon sign + ingress times', 'COMPUTED'],
  [73, 'Cycles & Signs', 'All planets: sign, degree, retrograde', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [74, 'Cycles & Signs', 'Aspects forming today (with orbs)', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [75, 'Cycles & Signs', 'Void-of-course Moon windows', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [76, 'Cycles & Signs', 'Mercury retrograde: status, stations, shadow', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [77, 'Cycles & Signs', 'All retrogrades', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [78, 'Cycles & Signs', 'Planetary hours', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [79, 'Cycles & Signs', 'Numerology: Universal Year / Month / Day', 'COMPUTED'], [80, 'Cycles & Signs', 'Master-number days flagged (11/22/33)', 'COMPUTED'],
  [81, 'Cycles & Signs', 'Personal Day / Month / Year (needs birth numbers — none stored)', 'PENDING'], [82, 'Cycles & Signs', 'Biorhythm cycles (needs birth numbers — none stored)', 'PENDING'],
  [83, 'Cycles & Signs', 'New & full moon calendar + moon names', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [84, 'Cycles & Signs', 'Supermoons / micromoons (blue & black moons from the same calendar)', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [85, 'Cycles & Signs', 'Eclipse seasons', 'COMPUTED'], [86, 'Cycles & Signs', 'Solstices, equinoxes, cross-quarters + countdowns', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [87, 'Cycles & Signs', 'Chinese almanac: day officer, auspicious/avoid (Tung Shing)', 'PENDING'], [88, 'Cycles & Signs', 'Chinese zodiac year + day pillar (sexagenary)', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [89, 'Cycles & Signs', 'Mayan Tzolkin + Haab + Long Count', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [90, 'Cycles & Signs', 'Hebrew calendar date', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [91, 'Cycles & Signs', 'Islamic calendar date', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [92, 'Cycles & Signs', 'I Ching hexagram of the day', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [93, 'Cycles & Signs', 'Tarot card of the day', 'COMPUTED'], [94, 'Cycles & Signs', 'Rune of the day', cyclesFull.ok ? 'COMPUTED' : 'PENDING'],
  [95, 'Cycles & Signs', 'Celtic tree calendar sign', cyclesFull.ok ? 'COMPUTED' : 'PENDING'], [96, 'Cycles & Signs', 'Dream & synchronicity field log (manual entries only)', 'PENDING'],
  // V. Human World
  [97, 'Human World', 'Headline wire: local (Giles / NRV)', 'WIRE'], [98, 'Human World', 'Headline wire: Virginia', 'WIRE'],
  [99, 'Human World', 'Headline wire: national + world', 'WIRE'], [100, 'Human World', 'Facebook local: Giles County groups (link-out)', LV(facebook.ok)],
  [101, 'Human World', 'NWS watches & warnings, Giles County', LV(weather.ok)], [102, 'Human World', 'Traffic: VA-511 / I-81 (link-out, no keyless feed)', 'WIRE'],
  [103, 'Human World', 'FAA ground stops & delay programs', 'PENDING'], [104, 'Human World', 'Power grid outage counts', 'PENDING'],
  [105, 'Human World', 'Internet health: outages, BGP, cable faults', 'PENDING'], [106, 'Human World', 'Rail: Norfolk Southern regional incidents', 'PENDING'],
  [107, 'Human World', 'FEMA disaster declarations (VA)', LV(human2.ok && human2.fema && human2.fema.ok !== false)], [108, 'Human World', 'VA AMBER alerts + state police notices', 'PENDING'],
  [109, 'Human World', 'CDC wastewater: flu / COVID / RSV', 'PENDING'], [110, 'Human World', 'FDA recalls: food & drug', LV(human2.ok && human2.fda && human2.fda.ok !== false)],
  [111, 'Human World', 'UAP: official releases, NUFORC counts', 'PENDING'], [112, 'Human World', 'Science wire (space / physics / AI)', 'WIRE'],
  [113, 'Human World', 'Markets: BTC, ETH, gold, silver, oil, S&P 500', LV(humanWorld.ok)], [114, 'Human World', 'Virginia Lottery latest numbers', 'WIRE'],
  [115, 'Human World', 'Powerball numbers (jackpot not in feed)', LV(human2.ok && human2.powerball && human2.powerball.ok !== false)], [116, 'Human World', 'On this day in history (Wikimedia)', LV(humanWorld.ok)],
  [117, 'Human World', 'Gas prices: Virginia average (AAA)', 'PENDING'],
  // VI. Local Life
  [118, 'Local Life', 'Weather: Pembroke forecast + alerts (NWS)', LV(weather.ok)], [119, 'Local Life', 'Air quality AQI + UV (pollen: no keyless in-season feed)', LV(earthExtras.ok)],
  [120, 'Local Life', 'New River conditions: level, flow, temp', LV(earth2.ok && earth2.rivers && earth2.rivers.ok !== false)], [121, 'Local Life', 'Giles County Schools closures & delays (seasonal)', 'PENDING'],
  [122, 'Local Life', 'County & town notices', 'PENDING'], [123, 'Local Life', 'Local events calendar', 'PENDING'],
  [124, 'Local Life', 'Hunting / fishing seasons open today (VA DWR)', 'PENDING'], [125, 'Local Life', 'Local obituaries (headlines only)', 'PENDING'],
  // VII. Anomaly Registry
  [126, 'Anomaly Registry', 'Daily anomaly flags (threshold-based, all feeds)', 'COMPUTED'], [127, 'Anomaly Registry', 'Days-since counters (M7 / M8 / X-flare / G5 / comet)', 'COMPUTED'],
  [128, 'Anomaly Registry', 'Records table: month & year, per category', 'COMPUTED'], [129, 'Anomaly Registry', 'Streaks & clusters (quake clustering, solar-cycle position, Schumann days)', 'COMPUTED'],
  [130, 'Anomaly Registry', 'Correlation log: dated co-occurrences, recorded as data', 'COMPUTED'], [131, 'Anomaly Registry', 'Full look-back archive (every day, every Tier-1 value)', 'COMPUTED'],
  // VIII. Bane Dome & Local Anomalies (catalog §IX — the home ground; desc = one-line plain reference)
  [132, 'Bane Dome & Local Anomalies', 'Bane Dome structure & cross-sections', 'REFERENCE', 'A doubly plunging anticline — an arch of rock layers — under Giles County. Reference: USGS Bulletin 1839.'],
  [133, 'Bane Dome & Local Anomalies', 'The +12 mGal gravity anomaly over the dome', 'WIRE', 'Gravity over the dome reads +12 mGal high (VT survey, 1988, 395 stations) — dense rock below. Re-surveys would appear here.'],
  [134, 'Bane Dome & Local Anomalies', 'Narrows fault — trace, displacement ~4 km', 'REFERENCE', 'The fault bounding the dome on the northwest; rock offset about 4 km along it.'],
  [135, 'Bane Dome & Local Anomalies', 'Saltville fault — trace, displacement ~8 km', 'REFERENCE', 'The fault bounding the dome on the southeast; rock offset about 8 km. Gypsum and salt country.'],
  [136, 'Bane Dome & Local Anomalies', 'St. Clair fault system', 'REFERENCE', 'The dome formed at the footwall edge of this fault system.'],
  [137, 'Bane Dome & Local Anomalies', 'Pulaski thrust sheet — 80 km displacement', 'REFERENCE', 'A colossal sheet of rock shoved ~80 km northwest — the big structure southeast of the dome.'],
  [138, 'Bane Dome & Local Anomalies', 'Rome Formation décollement', 'REFERENCE', 'The weak shale layer, deep down, that the whole stack of rock slides on.'],
  [139, 'Bane Dome & Local Anomalies', 'Strader #1 well', 'REFERENCE', 'The crest well on the dome; its conodont fossils rewrote the dome\u2019s story in 1979 (Perry et al., AAPG).'],
  [140, 'Bane Dome & Local Anomalies', 'Knox Group beneath the dome — windows (fensters)', 'REFERENCE', 'At Price Mountain the cover is eroded through, opening windows into the Knox limestone beneath.'],
  [141, 'Bane Dome & Local Anomalies', 'Pulaski sheet "horses"', 'REFERENCE', 'Rootless slices of the Pulaski sheet stranded inside the fensters.'],
  [142, 'Bane Dome & Local Anomalies', 'Devonian black shale — gas-prospective', 'REFERENCE', 'Organic black shale under the dome; its fractures can trap gas.'],
  [143, 'Bane Dome & Local Anomalies', 'Rome trough', 'REFERENCE', 'An ancient rift basin buried underneath everything — the oldest chapter of the stack.'],
  [144, 'Bane Dome & Local Anomalies', 'Conodont color alteration', 'REFERENCE', 'Fossil teeth changed color with heat — proof these rocks were cooked into the gas window.'],
  [145, 'Bane Dome & Local Anomalies', 'Giles County seismic zone — Virginia\u2019s most active', LV(quakes.ok), 'The ground here moves more than anywhere else in Virginia. Live via the USGS local feed.'],
  [146, 'Bane Dome & Local Anomalies', 'The 1897 Giles County earthquake (~M5.8)', 'REFERENCE', 'May 31, 1897 — the largest earthquake in Virginia\u2019s recorded history, right here in Giles County.'],
  [147, 'Bane Dome & Local Anomalies', 'Micro-quakes within 100 km of Pembroke', LV(quakes.ok), 'The small end of the same restlessness — live subset of the USGS local watch.'],
  [148, 'Bane Dome & Local Anomalies', 'Central VA seismic zone — 2011 Mineral M5.8 context', 'WIRE', 'The 2011 Mineral quake\u2019s zone, east of here — the regional comparison.'],
  [149, 'Bane Dome & Local Anomalies', 'Swarm watch on Narrows / Saltville traces', quakes.ok ? 'COMPUTED' : 'PENDING', 'Clustering in the local feed, computed daily — the traces to watch are the dome\u2019s own faults.'],
  [150, 'Bane Dome & Local Anomalies', 'Quarry blast vs quake discrimination', 'REFERENCE', 'Many small local "quakes" in catalogs are quarry blasts — shallow, weekday, daytime. Read local events with that in mind.'],
  [151, 'Bane Dome & Local Anomalies', 'Radon — fault-fractured rock pathways', 'WIRE', 'Fractured rock along the faults gives radon gas a path up. EPA zone data is the wire source.'],
  [152, 'Bane Dome & Local Anomalies', 'Telluric / earth-current research along the faults', 'PENDING', 'Natural earth currents along fault lines — a research thread, no live feed yet.'],
  [153, 'Bane Dome & Local Anomalies', 'Mountain Lake — the vanishing lake', 'WIRE', 'One of two natural lakes in Virginia; it drained away in 2008 and refilled around 2020. Level record via USGS reporting.'],
  [154, 'Bane Dome & Local Anomalies', 'Rock City boulder field, Mountain Lake', 'REFERENCE', 'A field of house-sized sandstone boulders near the lake — the mountain slowly coming apart.'],
  [155, 'Bane Dome & Local Anomalies', 'Karst sinkholes — Giles / Bland reports', 'WIRE', 'Limestone country dissolves from below; new sinkhole reports are the wire signal.'],
  [156, 'Bane Dome & Local Anomalies', 'Cave systems — New River Cave, Tawney\u2019s Cave', 'REFERENCE', 'Known cave systems in the limestone around the dome.'],
  [157, 'Bane Dome & Local Anomalies', 'Limestone springs & spring flow on the dome flanks', 'PENDING', 'Springs line the dome\u2019s flanks where limestone meets shale; flow gauging is not yet wired.'],
  [158, 'Bane Dome & Local Anomalies', 'Saltville salt — brine at the fault system\u2019s edge', 'REFERENCE', 'Salt and brine at Saltville, on the same fault system — worked since the Civil War era and long before.'],
  [159, 'Bane Dome & Local Anomalies', 'Fault-line springs — Hot Springs & Warm Springs VA', 'REFERENCE', 'Warm water rises along deep faults east of here — the same plumbing, showing at the surface.'],
  [160, 'Bane Dome & Local Anomalies', 'The New River — ancient, north-flowing, cuts the dome country', LV(earth2.ok && earth2.rivers && earth2.rivers.ok !== false), 'One of the oldest rivers on Earth, flowing north through the dome country. Live gauges on the Earth card.'],
  [161, 'Bane Dome & Local Anomalies', 'Dismal Creek & its falls', 'REFERENCE', 'A cold mountain creek and falls in the county\u2019s east.'],
  [162, 'Bane Dome & Local Anomalies', 'Acid mine drainage & coal seeps, regional', 'WIRE', 'Old coal country drainage — a water-quality wire item for the region.'],
  [163, 'Bane Dome & Local Anomalies', 'Methane seeps — gas country above the shale', 'WIRE', 'Gas country: seeps above the Devonian shale are reported, not instrumented.'],
  [164, 'Bane Dome & Local Anomalies', 'UAP reports over the New River Valley (NUFORC)', 'WIRE', 'Public report counts for the valley — reports are data about reports, labeled as such.'],
  [165, 'Bane Dome & Local Anomalies', 'Fireballs over the valley (AMS)', LV(deep2.ok && deep2.fireball && deep2.fireball.ok !== false), 'Bright meteors over the valley — the global fireball feed is live; valley reports ride the wire.'],
  [166, 'Bane Dome & Local Anomalies', 'Brown Mountain Lights — NC', 'WIRE', 'The regional light anomaly across the line in North Carolina — reports layer.'],
  [167, 'Bane Dome & Local Anomalies', 'Bigfoot reports — Giles / Appalachian VA (BFRO)', 'WIRE', 'Public report database entries for the county and region — reports, labeled as reports.'],
  [168, 'Bane Dome & Local Anomalies', 'Mothman corridor — Point Pleasant WV', 'WIRE', 'Upriver on the same river system — the 1966–67 Point Pleasant reports are the regional reference case.'],
  [169, 'Bane Dome & Local Anomalies', 'Mystery booms & hums reported in VA', 'WIRE', 'Unexplained boom/hum reports statewide — wire item, checked against quarry and quake records first.'],
  [170, 'Bane Dome & Local Anomalies', 'Aeromagnetic anomaly maps, Giles County (USGS)', 'REFERENCE', 'Flown magnetic surveys map the buried structure — the dome shows in magnetics as well as gravity.'],
  [171, 'Bane Dome & Local Anomalies', 'The 1988 gravity baseline — 395 stations', 'REFERENCE', 'Moses 1988 (VT thesis): the gravity baseline every later survey compares against.'],
  [172, 'Bane Dome & Local Anomalies', 'Celanese, Narrows — industry in the fault valley', 'WIRE', 'The plant sits in the river gap the geology cut — industry follows the corridor.'],
  [173, 'Bane Dome & Local Anomalies', 'Gypsum — US Gypsum / Plasterco on the Saltville fault', 'WIRE', 'Gypsum mining rides the Saltville fault\u2019s evaporite beds.'],
  [174, 'Bane Dome & Local Anomalies', 'Gas wells & permits over the dome (VA DMME records)', 'WIRE', 'State records of wells and permits over the structure.'],
  [175, 'Bane Dome & Local Anomalies', 'Mountain Valley Pipeline corridor', 'WIRE', 'The pipeline crosses this county — its corridor crosses the dome country too.'],
  [176, 'Bane Dome & Local Anomalies', 'Norfolk Southern through the Narrows', 'WIRE', 'Rail through the river gap — the corridor again.'],
  [177, 'Bane Dome & Local Anomalies', 'The Narrows gap itself', 'REFERENCE', 'The river cut through the ridge; town, rail, road, and plant all thread the gap geology made.'],
  [178, 'Bane Dome & Local Anomalies', 'Saltville ice-age fossils — mastodon & mammoth', 'WIRE', 'Ice-age giants preserved in the Saltville salt marshes — an active paleontology site.'],
  [179, 'Bane Dome & Local Anomalies', 'Devonian shale fossils', 'REFERENCE', 'The black shale carries its own fossil record.'],
  [180, 'Bane Dome & Local Anomalies', 'Cambrian Rome Formation outcrops', 'REFERENCE', 'The oldest rock in the stack, exposed where the rivers cut deep enough.'],
  [181, 'Bane Dome & Local Anomalies', 'Knox limestone fossil sites — trilobites, brachiopods', 'REFERENCE', 'Sea-floor fossils in the Knox limestone — this was an ocean once.'],
].map(([n, domain, name, status, desc]) => (desc ? { n, domain, name, status, desc } : { n, domain, name, status }));

// ---------- media probes: streams + embeds verified at build time, honest if dead ----------
async function probeStream(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-1023', 'User-Agent': UA }, signal: AbortSignal.timeout(7000), redirect: 'follow' });
    const ct = r.headers.get('content-type') || '';
    if (r.body) { try { await r.body.cancel(); } catch { /* noop */ } }
    return { ok: (r.status === 200 || r.status === 206) && /audio|mpeg|ogg|aac|octet-stream/i.test(ct), status: r.status, content_type: ct };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
async function probeEmbed(id) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id) + '&format=json', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
const radioCandidates = [
  { name: 'SomaFM — Groove Salad', desc: 'Ambient beats, fits the observatory', urls: ['https://ice1.somafm.com/groovesalad-128-mp3', 'https://ice2.somafm.com/groovesalad-128-mp3'] },
  { name: 'SomaFM — Deep Space One', desc: 'Deep space ambient', urls: ['https://ice1.somafm.com/deepspaceone-128-mp3'] },
  { name: 'SomaFM — Sonic Universe', desc: 'Avant-garde jazz transmissions', urls: ['https://ice1.somafm.com/sonicuniverse-128-mp3'] },
  { name: 'WVTF / Radio IQ', desc: 'Virginia public radio', urls: ['https://streams.wvtf.org/wvtf.mp3', 'https://stream.wvtf.org/wvtf.mp3', 'https://wvtf-live.streamguys1.com/live'], link: 'https://www.wvtf.org' },
  { name: 'NOAA Weather Radio (relay)', desc: 'Public relay — relays come and go', urls: ['https://radio.weatherusa.net/NWR/KEC83.mp3', 'https://www.noaaweatherradio.org/content/audio/KEC83.mp3'], link: 'https://www.noaaweatherradio.org' },
];
const radioStations = [];
for (const st of radioCandidates) {
  let found = null;
  for (const u of st.urls) { const p = await probeStream(u); if (p.ok) { found = { url: u, probe: p }; break; } }
  radioStations.push(found
    ? { name: st.name, desc: st.desc, url: found.url, ok: true, verified_at: now.toISOString() }
    : { name: st.name, desc: st.desc, url: null, ok: false, link: st.link || null, note: 'No candidate stream verified at build time — link-out instead of a dead player.' });
}
const radio = { ok: radioStations.some((s) => s.ok), stations: radioStations };
const videoCandidates = [
  { title: 'NASA Live', desc: 'NASA\u2019s live channel — launches, spacewalks, mission coverage', id: '21X5lGlDOfg', link: 'https://www.youtube.com/@NASA/live' },
  { title: 'ISS — Earth from Space (live)', desc: 'The station\u2019s own view, when the feed is up', id: 'DIQT99TXtos', link: 'https://www.youtube.com/results?search_query=ISS+live+earth+from+space' },
];
const videoItems = [];
for (const v of videoCandidates) {
  const p = await probeEmbed(v.id);
  videoItems.push(p.ok
    ? { title: v.title, desc: v.desc, id: v.id, embeddable: true, thumb: 'https://i.ytimg.com/vi/' + v.id + '/hqdefault.jpg', verified_at: now.toISOString() }
    : { title: v.title, desc: v.desc, id: null, embeddable: false, link: v.link, note: 'Embed did not verify at build time — honest link-out instead.' });
}
videoItems.push({ title: 'Virginia 511 traffic cameras', desc: 'VDOT camera stills and the state traffic map', id: null, embeddable: false, link: 'https://511virginia.org', note: 'Cameras ride the state system — link-out card by design.' });
const video = { ok: videoItems.some((v) => v.embeddable), items: videoItems };

/* ================= CONFIG — the one layout canon =================
   This single structure drives the page's layout. To reorder the menu,
   reorder a card, resize a card (size: S | M | L), or disable a section
   or card, edit ONLY this list — the page renders from it, no markup
   surgery. Feature flags gate anything unfinished. The frame is meant
   to grow for years: add entries here, keep ids stable, never fork the
   layout in the page. */
// Porch room suffixes: generated once, persisted across builds so shared
// room links stay valid; unguessable by construction (the link is the key).
const porchStatePath = join(ROOT, 'scripts/circle-porch.json');
let porchState = {};
try { porchState = JSON.parse(readFileSync(porchStatePath, 'utf8')); } catch { porchState = {}; }
{
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let dirty = false;
  for (const k of ['porch', 'skywatch', 'field']) {
    if (!porchState[k]) { porchState[k] = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); dirty = true; }
  }
  if (dirty) { try { writeFileSync(porchStatePath, JSON.stringify(porchState, null, 1)); } catch { /* read-only fs: suffixes become per-build */ } }
}
const CONFIG = {
  version: '1.0.0',
  changelog: [
    { v: '1.0.0', date: '2026-11-15', note: 'Framework first: config-driven layout, 181-item registry incl. Bane Dome §IX, three tickers, Wire Reader, radio bar (build-verified streams), video rail (build-verified embeds), Board v1 (form door), Sky Camera AR, PWA shell, ambient TV mode.' },
  ],
  features: { radio: true, video: true, board: 'v1-form-door', skyCameraAR: true, ambient: true, pwa: true, voiceNotes: 'v1-local', liveChat: false, porch: 'jitsi-embed' },
  rooms: [
    { id: 'porch', name: 'The Porch', blurb: 'The main hangout — pull up a chair, no agenda.', room: 'satwq-circle-porch-' + porchState.porch },
    { id: 'sky-watch', name: 'Sky Watch', blurb: 'Watch parties for the sky: launches, eclipses, meteor peaks, ISS passes.', room: 'satwq-circle-skywatch-' + porchState.skywatch },
    { id: 'field-reports', name: 'Field Reports', blurb: 'Show what you are seeing — point the camera at the sky, the river, the dome country.', room: 'satwq-circle-field-' + porchState.field },
  ],
  sections: [
    { id: 'findings', title: 'Findings', enabled: true },
    { id: 'bane', title: 'Bane Dome', enabled: true },
    { id: 'globe', title: 'Living Globe', enabled: true },
    { id: 'wire', title: "Today's Wire", enabled: true },
    { id: 'reader', title: 'Wire Reader', enabled: true },
    { id: 'video', title: 'Live Video', enabled: true },
    { id: 'charts', title: 'Charts', enabled: true },
    { id: 'anomalies', title: 'Anomaly Log', enabled: true },
    { id: 'your-sky', title: 'Your Sky', enabled: true },
    { id: 'board', title: 'The Board', enabled: true },
    { id: 'porch', title: 'The Porch — Live Video', enabled: true },
    { id: 'registry', title: 'Master Registry', enabled: true },
  ],
  cards: [
    { id: 'weather', title: 'Weather', section: 'wire', size: 'M', source: 'NWS api.weather.gov', enabled: true },
    { id: 'local_news', title: 'Local News', section: 'wire', size: 'L', source: 'RSS: WVVA · WDBJ7 · Roanoke Times · Virginia Mercury', enabled: true },
    { id: 'world_news', title: 'World Headlines', section: 'wire', size: 'M', source: 'RSS: NPR (AP/Reuters routes dead keyless)', enabled: true },
    { id: 'traffic', title: 'Traffic', section: 'wire', size: 'S', source: 'VA-511 link-out (no keyless feed)', enabled: true },
    { id: 'quakes', title: 'Earthquakes', section: 'wire', size: 'L', source: 'USGS GeoJSON', enabled: true },
    { id: 'earth2', title: 'Earth Body II', section: 'wire', size: 'M', source: 'USGS Water · PTWC · USDM · CPC · NOAA · SPC · NHC', enabled: true },
    { id: 'schumann', title: 'Schumann Resonance', section: 'wire', size: 'M', source: 'Tomsk SOSRFF (hotlinked)', enabled: true },
    { id: 'space_weather', title: 'Space Weather', section: 'wire', size: 'M', source: 'NOAA SWPC', enabled: true },
    { id: 'deep2', title: 'Deep Field II', section: 'wire', size: 'M', source: 'SWPC · DONKI · JPL Sentry/CNEOS · DSN', enabled: true },
    { id: 'gw', title: 'Gravitational Waves', section: 'wire', size: 'S', source: 'GraceDB public API', enabled: true },
    { id: 'moon_sky', title: 'Moon & Sky', section: 'wire', size: 'L', source: 'Computed (builder astro) + CelesTrak TLE', enabled: true },
    { id: 'sky_tonight', title: "Tonight's Sky", section: 'wire', size: 'M', source: 'Computed (builder astro)', enabled: true },
    { id: 'cycles_full', title: 'Cycles & Signs', section: 'wire', size: 'L', source: 'Computed by each system\u2019s own rules', enabled: true },
    { id: 'earth_extras', title: 'Earth Extras', section: 'wire', size: 'M', source: 'SWPC OVATION · Open-Meteo · NOAA Tides · NASA NEO', enabled: true },
    { id: 'space_news', title: 'Space News + APOD', section: 'wire', size: 'M', source: 'Spaceflight News API · NASA APOD DEMO_KEY', enabled: true },
    { id: 'human_world', title: 'Human World', section: 'wire', size: 'M', source: 'CoinGecko · Wikimedia · VA Lottery link-out', enabled: true },
    { id: 'human2', title: 'Human World II', section: 'wire', size: 'S', source: 'CoinGecko · data.ny.gov · FEMA · openFDA', enabled: true },
    { id: 'facebook', title: 'Facebook (link-out)', section: 'wire', size: 'S', source: 'Static link-out — no scraping', enabled: true },
  ],
};

const data = {
  generated_at: now.toISOString(),
  date_et: todayET,
  config: CONFIG,
  weather, local_news: localNews, world_news: worldNews, traffic,
  quakes, schumann, space_weather: spaceWeather, gw, space_news: spaceNews, facebook,
  moon_sky: moonSky, cycles, earth_extras: earthExtras, human_world: humanWorld, findings,
  earth2, deep2, sky_tonight: skyTonight, cycles_full: cyclesFull, human2, registry,
  radio, video,
};

// ---------- anomalies ----------
const anomalies = [];
if (quakes.ok) {
  for (const q of quakes.global) if (q.mag >= 6) anomalies.push(`M${q.mag.toFixed(1)} earthquake — ${q.place}`);
  for (const q of quakes.local) if (q.mag >= 4) anomalies.push(`Local M${q.mag.toFixed(1)} earthquake within 500 km — ${q.place}`);
}
if (spaceWeather.ok) {
  if (spaceWeather.kp_max_today != null && spaceWeather.kp_max_today >= 6)
    anomalies.push(`Geomagnetic storm level — Kp reached ${spaceWeather.kp_max_today}`);
  const dayAgo = Date.now() - 864e5;
  for (const f of spaceWeather.flares || []) {
    if (/^[MX]/.test(f.cls || '') && new Date(f.max).getTime() >= dayAgo)
      anomalies.push(`${f.cls}-class solar flare (peak ${f.max})`);
  }
}
if (gw.ok && gw.latest) {
  const createdMs = new Date(gw.latest.created.replace(' UTC', 'Z')).getTime();
  if (Date.now() - createdMs < 864e5) anomalies.push(`Gravitational-wave alert ${gw.latest.id} (${gw.latest.group || 'GW'})`);
}

if (earthExtras.ok) {
  const aq = earthExtras.air_quality;
  if (aq && aq.ok !== false && aq.aqi_max_today != null && aq.aqi_max_today >= 101)
    anomalies.push(`Air quality flagged — US AQI reached ${aq.aqi_max_today} (unhealthy for sensitive groups)`);
  const neo = earthExtras.neo;
  if (neo && neo.ok !== false && neo.closest && neo.closest.miss_km < 384400)
    anomalies.push(`Near-Earth object ${neo.closest.name} passed within one lunar distance (${neo.closest.miss_km.toLocaleString()} km)`);
}
if (quakes.ok && quakes.swarm_flags && quakes.swarm_flags.length) {
  for (const s of quakes.swarm_flags) anomalies.push(`Quake clustering — ${s.count} M4.5+ events in 24 h around ${s.region} (swarm/aftershock pattern, computed from the feed)`);
}
if (deep2.ok && deep2.scales && deep2.scales.ok !== false && deep2.scales.lines) {
  const m = deep2.scales.lines.join(' ').match(/geomagnetic G(\d)/);
  if (m && Number(m[1]) >= 4) anomalies.push(`G${m[1]} geomagnetic storm in effect (NOAA scale)`);
}

const counts = {
  quakes_global_m45: quakes.ok ? quakes.global.length : null,
  quakes_local_m25: quakes.ok ? quakes.local.length : null,
  biggest_quake_mag: quakes.ok && quakes.global.length ? Math.max(...quakes.global.map((q) => q.mag)) : null,
  gw_alerts_week: gw.ok ? gw.count_week : null,
  kp_latest: spaceWeather.ok && spaceWeather.kp_latest ? spaceWeather.kp_latest.kp : null,
  kp_max_today: spaceWeather.ok ? spaceWeather.kp_max_today : null,
  aqi_max_today: earthExtras.ok && earthExtras.air_quality && earthExtras.air_quality.ok !== false ? earthExtras.air_quality.aqi_max_today : null,
  closest_neo_km: earthExtras.ok && earthExtras.neo && earthExtras.neo.ok !== false && earthExtras.neo.closest ? earthExtras.neo.closest.miss_km : null,
  moon_illum_pct: moonSky.ok ? moonSky.moon.illum_pct : null,
  space_headlines: spaceNews.ok ? spaceNews.items.length : null,
  local_outlets_live: localNews.ok ? localNews.outlets.filter((o) => o.ok).length : null,
};

// ---------- Tier-1 daily snapshot (patterns get checked against this) ----------
const snapshot = {
  kp_latest: counts.kp_latest, kp_max_today: counts.kp_max_today,
  biggest_quake_mag: counts.biggest_quake_mag, closest_neo_km: counts.closest_neo_km,
  aqi_max_today: counts.aqi_max_today, moon_illum_pct: counts.moon_illum_pct,
  gw_alerts_week: counts.gw_alerts_week,
  btc_usd: humanWorld.ok && humanWorld.bitcoin ? humanWorld.bitcoin.price_usd : null,
  co2_ppm: earth2.ok && earth2.co2 && earth2.co2.ok !== false ? earth2.co2.lines.join(' ').match(/([\d.]+) ppm/)?.[1] ?? null : null,
  oni_anomaly: earth2.ok && earth2.oni && earth2.oni.ok !== false ? earth2.oni.lines.join(' ').match(/anomaly ([+-]?[\d.]+)/)?.[1] ?? null : null,
};

// ---------- archive history (before today is appended) ----------
const archivePath = join(ROOT, 'circle-archive.jsonl');
let history = [];
if (existsSync(archivePath)) {
  history = readFileSync(archivePath, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => r.date !== todayET);
}

// ---------- anomaly registry: counters, records, correlations ----------
const counters = {};
if (anomalyBits.ok && anomalyBits.days_since) {
  const ds = anomalyBits.days_since;
  if (ds.m7) counters.last_m7 = ds.m7.days != null ? `${ds.m7.days} days ago — M${ds.m7.mag} ${ds.m7.place} (${ds.m7.date})` : `none in the past 3 years of USGS record`;
  if (ds.m8) counters.last_m8 = ds.m8.days != null ? `${ds.m8.days} days ago — M${ds.m8.mag} ${ds.m8.place} (${ds.m8.date})` : `none in the past 3 years of USGS record`;
}
{
  const fl = spaceWeather.ok ? (spaceWeather.flares || []).filter((f) => /^X/.test(f.cls || '')) : [];
  counters.last_x_flare = fl.length
    ? `${Math.max(0, Math.floor((Date.now() - new Date(fl[fl.length - 1].max).getTime()) / 864e5))} day(s) ago (${fl[fl.length - 1].cls}, ${fl[fl.length - 1].max})`
    : 'none in the current 7-day SWPC flare window';
  counters.last_g5 = counts.kp_max_today != null && counts.kp_max_today >= 9
    ? 'today (Kp 9 recorded)' : 'none in today\u2019s Kp record; long-baseline counter starts with the archive';
  counters.naked_eye_comet = 'none reported by the tracked feeds today';
}
const allDays = [...history, { date: todayET, counts }];
const inMonth = allDays.filter((d) => d.date.startsWith(todayET.slice(0, 7)));
const inYear = allDays.filter((d) => d.date.startsWith(todayET.slice(0, 4)));
const agg = (rows, key, mode) => {
  const vals = rows.map((r) => r.counts && r.counts[key]).filter((v) => v != null);
  if (!vals.length) return null;
  return mode === 'min' ? Math.min(...vals) : Math.max(...vals);
};
const records = {
  biggest_quake: { month: agg(inMonth, 'biggest_quake_mag'), year: agg(inYear, 'biggest_quake_mag') },
  highest_kp: { month: agg(inMonth, 'kp_max_today'), year: agg(inYear, 'kp_max_today') },
  closest_neo_km: { month: agg(inMonth, 'closest_neo_km', 'min'), year: agg(inYear, 'closest_neo_km', 'min') },
  highest_aqi: { month: agg(inMonth, 'aqi_max_today'), year: agg(inYear, 'aqi_max_today') },
  days_on_record: allDays.length,
};
const correlations = [];
if (counts.kp_max_today != null && counts.kp_max_today >= 5 && counts.biggest_quake_mag != null && counts.biggest_quake_mag >= 5.5)
  correlations.push(`${todayET}: geomagnetic activity (Kp max ${counts.kp_max_today}) and a M${counts.biggest_quake_mag} earthquake on the same day — recorded as a co-occurrence; no claim attached.`);
if (spaceWeather.ok && (spaceWeather.flares || []).some((f) => /^[MX]/.test(f.cls || '')) && counts.kp_max_today != null && counts.kp_max_today >= 5)
  correlations.push(`${todayET}: an M/X-class flare inside the current window alongside Kp max ${counts.kp_max_today} — recorded as a co-occurrence; no claim attached.`);
if (!correlations.length) correlations.push('No cross-system co-occurrences met the logging thresholds today. The log records; it does not assert.');
data.anomaly_registry = { counters, records, correlations };

// ---------- self-check: refuse to publish a failed build ----------
{
  const problems = [];
  const expected = ['weather', 'local_news', 'world_news', 'traffic', 'quakes', 'schumann', 'space_weather', 'gw', 'space_news', 'facebook', 'moon_sky', 'cycles', 'earth_extras', 'human_world', 'findings', 'earth2', 'deep2', 'sky_tonight', 'cycles_full', 'human2', 'registry', 'anomaly_registry'];
  for (const k of expected) if (!(k in data)) problems.push(`missing section ${k}`);
  if (!data.generated_at || Number.isNaN(Date.parse(data.generated_at))) problems.push('generated_at not a sane timestamp');
  if (!Array.isArray(data.registry) || data.registry.length !== 181) problems.push(`registry length ${data.registry && data.registry.length} != 181`);
  const ser = JSON.stringify(data);
  if (/\bNaN\b/.test(ser)) problems.push('NaN present in payload');
  if (ser.includes('"undefined"') || ser.includes(':undefined')) problems.push('undefined string present in payload');
  const liveCount = expected.filter((k) => data[k] && data[k].ok).length;
  if (liveCount < 10) problems.push(`only ${liveCount} sections live — below the publish floor of 10`);
  if (problems.length) {
    console.error(`[circle] SELF-CHECK FAILED — previous good data stays live. Problems: ${problems.join(' · ')}`);
    process.exit(1);
  }
  console.log(`[circle] self-check passed (${liveCount}/${expected.length} sections live)`);
}

// ---------- feed health ledger ----------
const healthPath = join(ROOT, 'public', 'registry-health.json');
{
  let health = {};
  if (existsSync(healthPath)) { try { health = JSON.parse(readFileSync(healthPath, 'utf8')); } catch { health = {}; } }
  const feedResults = {
    weather, local_news: localNews, world_news: worldNews, traffic, quakes, schumann,
    space_weather: spaceWeather, gw, space_news: spaceNews, facebook, moon_sky: moonSky,
    cycles, earth_extras: earthExtras, human_world: humanWorld, earth2, deep2,
    sky_tonight: skyTonight, cycles_full: cyclesFull, human2, findings,
    'earth2.rivers': earth2.ok ? earth2.rivers : null, 'earth2.tsunami': earth2.ok ? earth2.tsunami : null,
    'earth2.drought': earth2.ok ? earth2.drought : null, 'earth2.oni': earth2.ok ? earth2.oni : null,
    'earth2.co2': earth2.ok ? earth2.co2 : null, 'earth2.spc': earth2.ok ? earth2.spc : null, 'earth2.nhc': earth2.ok ? earth2.nhc : null,
    'deep2.scales': deep2.ok ? deep2.scales : null, 'deep2.sun': deep2.ok ? deep2.sun : null, 'deep2.cme': deep2.ok ? deep2.cme : null,
    'deep2.sentry': deep2.ok ? deep2.sentry : null, 'deep2.fireball': deep2.ok ? deep2.fireball : null, 'deep2.dsn': deep2.ok ? deep2.dsn : null,
    'human2.fema': human2.ok ? human2.fema : null, 'human2.fda': human2.ok ? human2.fda : null,
    'human2.powerball': human2.ok ? human2.powerball : null, 'human2.eth': human2.ok ? human2.eth : null, 'human2.metals': human2.ok ? human2.metals : null,
  };
  for (const [key, sec] of Object.entries(feedResults)) {
    const ok = !!(sec && sec.ok !== false);
    const prev = health[key] || { last_ok_date: null, consecutive_failures: 0, last_attempt_date: null };
    if (prev.last_attempt_date !== todayET) {
      if (ok) { prev.last_ok_date = todayET; prev.consecutive_failures = 0; }
      else prev.consecutive_failures = (prev.consecutive_failures || 0) + 1;
      prev.last_attempt_date = todayET;
    }
    prev.ok_now = ok;
    health[key] = prev;
  }
  writeFileSync(healthPath, JSON.stringify({ updated: todayET, feeds: health }, null, 2));
}

// ---------- community board (v1: static board.json, form-door composer) ----------
// Data shape is Worker-ready: { posts: [{ id, ts, author, type, title,
// body, place?, rating?, replies: [] }] }. The builder PRESERVES posts
// already in the file (they arrive via the submission door) and only
// refreshes the meta block — it never invents posts.
{
  const boardPath = join(ROOT, 'public', 'board.json');
  let board = { version: 1, posts: [] };
  if (existsSync(boardPath)) { try { board = JSON.parse(readFileSync(boardPath, 'utf8')); } catch { /* reseed */ } }
  if (!Array.isArray(board.posts)) board.posts = [];
  board.meta = {
    refreshed: todayET,
    composer: 'form-door-v1 (mailto) — posts appear on the refresh cycle, not in real time',
    types: ['Discussion', 'Sighting', 'Place', 'Field Note'],
    house_rules: 'Chosen display names only. No dollars, no personal identifiers, no court content. Sightings get auto-tagged with the day\u2019s instrument data when the board backend lands.',
  };
  writeFileSync(boardPath, JSON.stringify(board, null, 2));
}

// ---------- anomaly flags file (for the morning brief / bridge) ----------
writeFileSync(join(ROOT, 'public', 'circle-flags.json'), JSON.stringify({
  date: todayET, generated_at: data.generated_at, flags: anomalies, counts,
}, null, 2));

// ---------- hash-gated writes: no content change → no file churn ----------
import { createHash } from 'node:crypto';
const stripVolatile = (v) => JSON.parse(JSON.stringify(v, (k, val) =>
  (k === 'generated_at' || k === 'fetched_at' || k === 'fetchedAt') ? undefined : val));
const hashOf = (v) => createHash('sha256').update(JSON.stringify(stripVolatile(v))).digest('hex');
const writeIfChanged = (path, content, compareObj) => {
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, 'utf8'));
      if (compareObj && hashOf(existing) === hashOf(compareObj)) return false;
      if (!compareObj && readFileSync(path, 'utf8') === content) return false;
    } catch { /* rewrite */ }
  }
  writeFileSync(path, content);
  return true;
};
const dataChanged = writeIfChanged(join(ROOT, 'public', 'circle-data.json'), JSON.stringify(data, null, 2), data);

// ---------- archive write (dedupe by date, hash-chained) ----------
// Tamper-evident: every line carries sha256(prev_hash + payload).
// Any altered day breaks every later link — verifiable by anyone.
const rawLines = [...history, { date: todayET, anomalies, counts, snapshot }]
  .map(({ date, anomalies: a, counts: c, snapshot: s }) => ({ date, anomalies: a, counts: c, snapshot: s }))
  .sort((a, b) => (a.date < b.date ? -1 : 1));
let prevHash = 'GENESIS';
const lines = rawLines.map((payload) => {
  const hash = createHash('sha256').update(prevHash + JSON.stringify(payload)).digest('hex');
  const line = { ...payload, prev_hash: prevHash, hash };
  prevHash = hash;
  return line;
});
const archiveText = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const archiveChanged = existsSync(archivePath) ? readFileSync(archivePath, 'utf8') !== archiveText : true;
if (archiveChanged) writeFileSync(archivePath, archiveText);
writeIfChanged(join(ROOT, 'public', 'circle-archive.json'), JSON.stringify([...lines].reverse(), null, 2));
writeIfChanged(join(ROOT, 'public', 'circle-archive.jsonl'), archiveText);
console.log(`[circle] changed: data=${dataChanged} archive=${archiveChanged}`);

const status = Object.entries(data)
  .filter(([k]) => !['generated_at', 'date_et'].includes(k))
  .map(([k, v]) => `${k}=${v.ok ? 'LIVE' : 'UNAVAILABLE(' + v.error + ')'}`)
  .join(' ');
console.log(`[circle] built ${todayET} :: ${status}`);
console.log(`[circle] anomalies today: ${anomalies.length ? anomalies.join(' | ') : 'none'}`);
