// Inner Circle — expansion sections (Master Registry Tier-1 coverage).
// Same rules as the core builder: per-feed isolation, real data or an
// honest failure, source labels on everything.
import {
  sunEvents, sunAltitude, moonAltitude, moonIllumination, phaseName, signOf,
  geoPlanet, planetAltitude, altitudeForRaDec, moonDistanceKm, nextMoonSignChange,
} from './circle-astro.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) SATWQ-Circle-Builder/1.0';
const LAT = 37.3031, LON = -80.6015;
const now = new Date();
const todayET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const [ty, tm, td] = todayET.split('-').map(Number);
const dayUTC = new Date(Date.UTC(ty, tm - 1, td, 12, 0, 0));
const fmtET = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
}).format(d);
const fmtDayET = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
}).format(d);

async function fetchRaw(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}
const fetchJSON = async (u, t) => (await fetchRaw(u, t)).json();
const fetchText = async (u, t) => (await fetchRaw(u, t)).text();
async function sub(fn) { try { return await fn(); } catch (e) { return { ok: false, error: String(e.message || e) }; } }

// ---------------- EARTH BODY II ----------------
export async function getEarth2() {
  const out = { source: 'USGS Water Services · NOAA Tsunami Program · US Drought Monitor · NOAA CPC · NOAA GML · NWS Storm Prediction Center · National Hurricane Center' };

  out.rivers = await sub(async () => {
    const j = await fetchJSON('https://waterservices.usgs.gov/nwis/iv/?format=json&sites=03176500,03170000&parameterCd=00060,00065,00010');
    const lines = [];
    for (const ts of j.value.timeSeries) {
      const site = ts.sourceInfo.siteName.titleCase || ts.sourceInfo.siteName;
      const varName = ts.variable.variableName;
      const val = ts.values[0].value[0];
      if (val) lines.push(`${site} — ${varName}: ${val.value} ${ts.variable.unit.unitCode} (${val.dateTime})`);
    }
    if (!lines.length) throw new Error('no gauge values returned');
    return { lines, note: 'Giles County\u2019s own New River gauge is Glen Lyn (03176500); Radford (03170000) is the next gauge downriver. No separate Pearisburg gauge exists in the USGS network.' };
  });

  out.tsunami = await sub(async () => {
    let xml = null, used = null;
    for (const u of ['https://www.tsunami.gov/events/xml/PTWCAtom.xml', 'https://www.tsunami.gov/events/xml/PAAQAtom.xml']) {
      try { xml = await fetchText(u); used = u; break; } catch { /* next */ }
    }
    if (!xml) throw new Error('tsunami feeds unreachable');
    const titles = [...xml.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter((t) => t && !/tsunami/i.test(t) || /statement|warning|watch|advisory/i.test(t));
    const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/gi)].length;
    return { entries, latest_titles: titles.slice(0, 3), feed: used, note: entries === 0 ? 'No active tsunami statements in the feed right now.' : `${entries} statement(s) in the current feed.` };
  });

  out.drought = await sub(async () => {
    const j = await fetchJSON('https://droughtmonitor.unl.edu/data/json/usdm_current.json');
    // Point-in-polygon over the official USDM map polygons: what drought
    // level, if any, covers Pembroke right now? (Weekly map, DM 0–4.)
    const inRing = (ring, x, y) => {
      let inside = false;
      for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
        const xi = ring[i][0], yi = ring[i][1], xk = ring[k][0], yk = ring[k][1];
        if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const inPoly = (poly) => inRing(poly[0], LON, LAT) && !poly.slice(1).some((hole) => inRing(hole, LON, LAT));
    let dm = null;
    for (const f of j.features || []) {
      const g = f.geometry; if (!g) continue;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      if (polys.some(inPoly)) { const v = Number(f.properties.DM); if (dm === null || v > dm) dm = v; }
    }
    const labels = ['D0 — abnormally dry', 'D1 — moderate drought', 'D2 — severe drought', 'D3 — extreme drought', 'D4 — exceptional drought'];
    return { lines: [dm === null
      ? 'Drought monitor (USDM weekly map): Pembroke / Giles County currently carries no drought designation.'
      : `Drought monitor (USDM weekly map): Pembroke / Giles County is under ${labels[dm]}.`] };
  });

  out.oni = await sub(async () => {
    const txt = await fetchText('https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt');
    const rows = txt.trim().split('\n').map((l) => l.trim().split(/\s+/)).filter((r) => r.length >= 4 && /^\d{4}$/.test(r[1]));
    const last = rows[rows.length - 1];
    const anom = Number(last[3]);
    const phase = anom >= 0.5 ? 'El Niño' : anom <= -0.5 ? 'La Niña' : 'Neutral';
    return { lines: [`Oceanic Niño Index (${last[0]} ${last[1]}): anomaly ${anom > 0 ? '+' : ''}${anom} °C — ${phase} conditions by NOAA\u2019s definition (±0.5 °C threshold).`] };
  });

  out.co2 = await sub(async () => {
    const txt = await fetchText('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.csv');
    const rows = txt.trim().split('\n').filter((l) => /^\d{4},/.test(l));
    const last = rows[rows.length - 1].split(',');
    return { lines: [`CO₂ at Mauna Loa: ${last[4]} ppm (daily mean, ${last[0]}-${last[1]}-${last[2]}).`] };
  });

  out.spc = await sub(async () => {
    const count = async (kind) => {
      const txt = await fetchText(`https://www.spc.noaa.gov/climo/reports/today_${kind}.csv`);
      return Math.max(0, txt.trim().split('\n').length - 1);
    };
    const [torn, wind, hail] = await Promise.all([count('torn'), count('wind'), count('hail')]);
    return { lines: [`Storm reports today (SPC, since 12 UTC): tornado ${torn} · wind ${wind} · hail ${hail}.`] };
  });

  out.nhc = await sub(async () => {
    const j = await fetchJSON('https://www.nhc.noaa.gov/CurrentStorms.json');
    const storms = (j.activeStorms || []).map((s) => `${s.name} (${s.classification}, ${s.intensity} kt, ${s.pressure} mb)`);
    return { lines: storms.length ? [`Active tropical systems (NHC): ${storms.join(' · ')}`] : ['Active tropical systems (NHC): none right now.'] };
  });

  return out;
}

// ---------------- DEEP FIELD II ----------------
export async function getDeep2() {
  const out = { source: 'NOAA SWPC · NASA DONKI · NASA/JPL SSD (Sentry & CNEOS) · NASA DSN Now' };

  out.scales = await sub(async () => {
    const j = await fetchJSON('https://services.swpc.noaa.gov/products/noaa-scales.json');
    const cur = j['0'];
    const lines = [`Today\u2019s NOAA scales — geomagnetic G${cur.G.Scale} (${cur.G.Text}), radio blackout R${cur.R.Scale} (${cur.R.Text}), radiation S${cur.S.Scale} (${cur.S.Text}).`];
    try {
      const dst = await fetchJSON('https://services.swpc.noaa.gov/products/kyoto-dst.json');
      const last = dst[dst.length - 1];
      lines.push(`Dst index now: ${last.dst} nT (${last.time_tag} UTC).`);
    } catch { lines.push('Dst index: unavailable this build.'); }
    try {
      const mag = await fetchJSON('https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1_hour.json');
      const rows = mag.filter((r) => r.bz_gsm != null);
      const last = rows[rows.length - 1];
      if (last) lines.push(`Interplanetary field Bz at L1: ${last.bz_gsm} nT (GSM, ${last.time_tag}).`);
    } catch { lines.push('IMF Bz: unavailable this build.'); }
    return { lines };
  });

  out.sun = await sub(async () => {
    const lines = [];
    const f = await fetchJSON('https://services.swpc.noaa.gov/json/f107_cm_flux.json');
    const rows = f.filter((r) => r.flux != null).sort((a, b) => (a.time_tag < b.time_tag ? -1 : 1));
    if (rows.length) lines.push(`Solar flux F10.7: ${Math.round(rows[rows.length - 1].flux)} sfu (latest report ${rows[rows.length - 1].time_tag}).`);
    try {
      const sc = await fetchJSON('https://services.swpc.noaa.gov/json/solar-cycle/observed-solar-cycle-indices.json');
      const withSsn = sc.filter((r) => r.ssn != null && r.ssn >= 0);
      const last = withSsn[withSsn.length - 1];
      if (last) lines.push(`Sunspot number (monthly observed, ${last['time-tag']}): ${last.ssn}. Solar Cycle 25 began Dec 2019; at ~11 years long it is roughly ${Math.min(99, Math.round(((Date.now() - Date.UTC(2019, 11, 1)) / (11 * 365.25 * 864e5)) * 100))}% through its expected span (estimate from cycle length).`);
    } catch { /* F10.7 line stands alone */ }
    if (!lines.length) throw new Error('no solar indices returned');
    return { lines };
  });

  out.cme = await sub(async () => {
    const start = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const j = await fetchJSON(`https://api.nasa.gov/DONKI/CME?startDate=${start}&endDate=${todayET}&api_key=DEMO_KEY`);
    const list = Array.isArray(j) ? j : [];
    const lines = [`Coronal mass ejections catalogued past 7 days (DONKI): ${list.length}.`];
    if (list.length) {
      const last = list[list.length - 1];
      const an = (last.cmeAnalyses || []).find((a) => a.isMostProbable);
      lines.push(`Latest: ${last.startTime}${an ? ` · speed ${an.speed} km/s · ${an.type || ''}` : ''}.`);
    }
    return { lines };
  });

  out.sentry = await sub(async () => {
    const j = await fetchJSON('https://ssd-api.jpl.nasa.gov/sentry.api');
    return { lines: [`Sentry risk list (JPL): ${j.count} objects with a computed future impact possibility, all at very low probability — the list existing is normal science, not an alarm.`] };
  });

  out.fireball = await sub(async () => {
    const j = await fetchJSON('https://ssd-api.jpl.nasa.gov/fireball.api?limit=5');
    const fields = j.fields, rows = j.data || [];
    if (!rows.length) throw new Error('no fireball rows');
    const r = Object.fromEntries(fields.map((f, i) => [f, rows[0][i]]));
    return { lines: [`Latest satellite-detected fireball (NASA CNEOS): ${r.date} UTC · energy ${r.energy} kt · at ${r.lat}°${r['lat-dir']}, ${r.lon}°${r['lon-dir']}${r.alt ? ` · burst altitude ${r.alt} km` : ''}. CNEOS reports lag events by weeks — this is the newest on record, not necessarily recent.`] };
  });

  out.dsn = await sub(async () => {
    const xml = await fetchText('https://eyes.nasa.gov/dsn/data/dsn.xml');
    const pairs = [];
    for (const m of xml.matchAll(/<dish name="([^"]+)"[\s\S]*?<target name="([^"]+)"/g)) pairs.push(`${m[2]} via ${m[1]}`);
    const uniq = [...new Set(pairs)];
    if (!uniq.length) throw new Error('no active DSN links parsed');
    return { lines: [`Deep Space Network right now: ${uniq.slice(0, 6).join(' · ')}${uniq.length > 6 ? ` · +${uniq.length - 6} more` : ''}.`] };
  });

  out.launches = await sub(async () => {
    const j = await fetchJSON('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=5', 12000);
    const lines = (j.results || []).map((l) => `${l.name} — ${l.net} (${l.launch_service_provider?.name || 'provider n/a'})`);
    if (!lines.length) throw new Error('no launches returned');
    return { lines };
  });

  return out;
}

// ---------------- SKY TONIGHT (computed) ----------------
const RADIANT = { Leonids: 'Leo', Perseids: 'Perseus', Geminids: 'Gemini', Quadrantids: 'Boötes', Lyrids: 'Lyra', 'Eta Aquariids': 'Aquarius', 'Delta Aquariids': 'Aquarius', Orionids: 'Orion', 'Southern Taurids': 'Taurus', 'Northern Taurids': 'Taurus', Ursids: 'Ursa Minor' };

export async function getSkyTonight(activeShowers, kpForecastMax) {
  const ev = sunEvents(dayUTC, LAT, LON);
  const lines = [];
  lines.push(`Twilight tonight: sunset ${fmtET(ev.sunSet)} · civil dusk ${fmtET(ev.civilSet)} · nautical dusk ${fmtET(ev.nauticalSet)} · astronomical night from ${fmtET(ev.astroSet)} to ${fmtET(ev.astroRise)} · dawn ${fmtET(ev.sunRise)}.`);
  // moonless dark window inside astronomical night (10-min samples)
  let darkMin = 0;
  for (let t = ev.astroSet.getTime(); t < ev.astroRise.getTime() + 864e5 && t < ev.astroSet.getTime() + 14 * 3600e3; t += 600000) {
    const d = new Date(t);
    if (sunAltitude(d, LAT, LON) < -18 && moonAltitude(d, LAT, LON) < 0) darkMin += 10;
    if (t > ev.astroSet.getTime() + 12 * 3600e3) break;
  }
  lines.push(`Moonless dark-sky window tonight: about ${Math.floor(darkMin / 60)}h ${darkMin % 60}m of astronomical night with the moon below the horizon (computed by sampling).`);
  const kp = kpForecastMax;
  const chance = kp == null ? 'Kp outlook unavailable — chance not computed.' :
    kp >= 7 ? `Kp outlook max ${kp}: a real chance — aurora can reach this latitude at Kp 7+.` :
    kp >= 5 ? `Kp outlook max ${kp}: low chance — a northern-horizon glow is possible on a clear, dark night.` :
    `Kp outlook max ${kp}: essentially nil — aurora at 37.3° N generally needs Kp 7+.`;
  lines.push(`Aurora chance for Pembroke tonight: ${chance}`);
  const gc1 = altitudeForRaDec(17.761, -29.0, new Date(dayUTC.getTime() + 14 * 3600e3), LAT, LON);
  const gc2 = altitudeForRaDec(17.761, -29.0, new Date(dayUTC.getTime() + 16 * 3600e3), LAT, LON);
  lines.push(`Galactic core (Sagittarius A* direction): ${Math.max(gc1, gc2) > 0 ? `up to ${Math.round(Math.max(gc1, gc2))}° above the horizon this evening — November is the tail of core season, low in the southwest after dusk.` : 'below the horizon tonight — core season has closed until spring.'}`);
  if (activeShowers && activeShowers.length) {
    lines.push(`Meteor radiant tonight: ${activeShowers.map((s) => `${s.name} from ${RADIANT[s.name] || 'its namesake constellation'}`).join(' · ')}.`);
  }
  // planet rise/set by hourly scan + conjunctions at 21:00
  const tonight = new Date(dayUTC.getTime() + 14 * 3600e3);
  const bodies = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];
  const pos = {};
  for (const b of bodies) pos[b] = geoPlanet(b, tonight);
  const ill = moonIllumination(now);
  const conj = [];
  const sep = (a, b) => Math.hypot(((a.lon - b.lon + 540) % 360) - 180, 0); // ecliptic-longitude separation (simple)
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const s = Math.abs(((pos[bodies[i]].lon - pos[bodies[j]].lon + 540) % 360) - 180);
    if (s < 5) conj.push(`${bodies[i]}–${bodies[j]} conjunction: ${s.toFixed(1)}° apart in ecliptic longitude`);
  }
  for (const b of bodies) {
    const s = Math.abs(((pos[b].lon - ill.moonLon + 540) % 360) - 180);
    if (s < 8) conj.push(`Moon–${b} pairing: ${s.toFixed(1)}° apart`);
  }
  lines.push(conj.length ? `Pairings in tonight\u2019s sky: ${conj.join(' · ')}.` : 'Pairings in tonight\u2019s sky: no close planet–planet conjunctions or Moon pairings (by ecliptic longitude).');
  const riseSet = [];
  for (const b of bodies) {
    let prevT = dayUTC, prev = planetAltitude(b, dayUTC, LAT, LON), rise = null, set = null;
    for (let h = 1; h <= 24; h++) {
      const t = new Date(dayUTC.getTime() + h * 3600e3);
      const a = planetAltitude(b, t, LAT, LON);
      if (prev < 0 && a >= 0 && !rise) rise = new Date(prevT.getTime() + (0 - prev) / (a - prev) * 3600e3);
      if (prev >= 0 && a < 0 && rise && !set) set = new Date(prevT.getTime() + (0 - prev) / (a - prev) * 3600e3);
      prev = a; prevT = t;
    }
    if (rise) riseSet.push(`${b} rises ${fmtET(rise)}${set ? `, sets ${fmtET(set)}` : ''}`);
  }
  if (riseSet.length) lines.push(`Planet rise/set (ET, computed): ${riseSet.join(' · ')}.`);
  return { source: 'Computed at build time for 37.303° N, 80.602° W (solar/lunar math + JPL approximate planetary elements; Kp outlook by NOAA SWPC)', lines };
}

// ---------------- CYCLES & SIGNS — full tracked system ----------------
const BODIES = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'];
const STEMS = ['Jia (Wood)', 'Yi (Wood)', 'Bing (Fire)', 'Ding (Fire)', 'Wu (Earth)', 'Ji (Earth)', 'Geng (Metal)', 'Xin (Metal)', 'Ren (Water)', 'Gui (Water)'];
const BRANCHES = ['Zi (Rat)', 'Chou (Ox)', 'Yin (Tiger)', 'Mao (Rabbit)', 'Chen (Dragon)', 'Si (Snake)', 'Wu (Horse)', 'Wei (Goat)', 'Shen (Monkey)', 'You (Rooster)', 'Xu (Dog)', 'Hai (Pig)'];
const TZOLKIN_NAMES = ['Imix', 'Ik', 'Akbal', 'Kan', 'Chicchan', 'Cimi', 'Manik', 'Lamat', 'Muluc', 'Oc', 'Chuen', 'Eb', 'Ben', 'Ix', 'Men', 'Cib', 'Caban', 'Etznab', 'Cauac', 'Ajaw'];
const HAAB = ['Pop', 'Wo', 'Sip', 'Sotz', 'Sek', 'Xul', 'Yaxkin', 'Mol', 'Chen', 'Yax', 'Sak', 'Keh', 'Mak', 'Kankin', 'Muwan', 'Pax', 'Kayab', 'Kumku', 'Wayeb'];
const ICHING = ['The Creative', 'The Receptive', 'Difficulty at the Beginning', 'Youthful Folly', 'Waiting', 'Conflict', 'The Army', 'Holding Together', 'Small Taming', 'Treading', 'Peace', 'Standstill', 'Fellowship', 'Great Possession', 'Modesty', 'Enthusiasm', 'Following', 'Work on the Decayed', 'Approach', 'Contemplation', 'Biting Through', 'Grace', 'Splitting Apart', 'Return', 'Innocence', 'Great Taming', 'Nourishment', 'Preponderance of the Great', 'The Abysmal (Water)', 'The Clinging (Fire)', 'Influence', 'Duration', 'Retreat', 'Great Power', 'Progress', 'Darkening of the Light', 'The Family', 'Opposition', 'Obstruction', 'Deliverance', 'Decrease', 'Increase', 'Breakthrough', 'Coming to Meet', 'Gathering Together', 'Pushing Upward', 'Oppression', 'The Well', 'Revolution', 'The Cauldron', 'The Arousing (Thunder)', 'Keeping Still (Mountain)', 'Development', 'The Marrying Maiden', 'Abundance', 'The Wanderer', 'The Gentle (Wind)', 'The Joyous (Lake)', 'Dispersion', 'Limitation', 'Inner Truth', 'Preponderance of the Small', 'After Completion', 'Before Completion'];
const RUNES = ['Fehu', 'Uruz', 'Thurisaz', 'Ansuz', 'Raidho', 'Kenaz', 'Gebo', 'Hagalaz', 'Nauthiz', 'Isa', 'Jera', 'Eihwaz', 'Perthro', 'Algiz', 'Sowilo', 'Tiwaz', 'Berkana', 'Ehwaz', 'Mannaz', 'Laguz', 'Ingwaz', 'Dagaz', 'Othala'];
const TREE_SIGNS = [[1, 19, 'Birch'], [2, 15, 'Rowan'], [3, 14, 'Ash'], [4, 11, 'Alder'], [5, 9, 'Willow'], [6, 6, 'Hawthorn'], [7, 4, 'Oak'], [8, 2, 'Holly'], [8, 30, 'Hazel'], [9, 27, 'Vine'], [10, 25, 'Ivy'], [11, 22, 'Reed'], [12, 20, 'Elder']];
const FULL_MOON_NAMES = { 1: 'Wolf', 2: 'Snow', 3: 'Worm', 4: 'Pink', 5: 'Flower', 6: 'Strawberry', 7: 'Buck', 8: 'Sturgeon', 9: 'Corn', 10: 'Hunter\u2019s', 11: 'Beaver', 12: 'Cold' };
const DAY_RULERS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn']; // Sun..Sat
const CHALDEAN = ['Saturn', 'Jupiter', 'Mars', 'Sun', 'Venus', 'Mercury', 'Moon'];

function geoLonAt(name, date) {
  if (name === 'Sun') { const ill = moonIllumination(date); return ill.sunLon; }
  if (name === 'Moon') { return moonIllumination(date).moonLon; }
  return geoPlanet(name, date).lon;
}
function isRetro(name, date) {
  if (name === 'Sun' || name === 'Moon') return false;
  const a = geoLonAt(name, date), b = geoLonAt(name, new Date(date.getTime() + 5 * 864e5));
  let d = b - a; if (d > 180) d -= 360; if (d < -180) d += 360;
  return d < 0;
}
const reduceNum = (n) => { while (n > 9) n = String(n).split('').map(Number).reduce((a, b) => a + b, 0); return n; };
const hashDate = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

export async function getCyclesFull() {
  const lines = [];
  const planets = BODIES.map((b) => {
    const lon = geoLonAt(b, now);
    return { name: b, sign: signOf(lon), degree: +(lon % 30).toFixed(1), retro: isRetro(b, now) };
  });
  lines.push('Planetary positions (sign · degree · motion, computed from JPL approximate elements):');
  for (const p of planets) lines.push(`${p.name}: ${p.sign} ${p.degree}°${p.retro ? ' — retrograde' : ''}`);

  // aspects (orb ≤ 6°, Moon ≤ 8°)
  const aspects = [];
  const ASP = [[0, 'conjunction'], [60, 'sextile'], [90, 'square'], [120, 'trine'], [180, 'opposition']];
  for (let i = 0; i < BODIES.length; i++) for (let j = i + 1; j < BODIES.length; j++) {
    const la = geoLonAt(BODIES[i], now), lb = geoLonAt(BODIES[j], now);
    const sepA = Math.abs(((la - lb + 540) % 360) - 180);
    for (const [ang, nm] of ASP) {
      const orb = Math.abs(sepA - ang);
      const maxOrb = (BODIES[i] === 'Moon' || BODIES[j] === 'Moon') ? 8 : 6;
      if (orb <= maxOrb) aspects.push({ text: `${BODIES[i]} ${nm} ${BODIES[j]} (orb ${orb.toFixed(1)}°)`, orb });
    }
  }
  aspects.sort((a, b) => a.orb - b.orb);
  lines.push(`Aspects in orb today: ${aspects.length ? aspects.slice(0, 8).map((a) => a.text).join(' · ') : 'none within orb'}.`);

  // void-of-course: last exact major aspect (scan back 36h, 30-min steps) → sign ingress
  const change = nextMoonSignChange(now);
  let lastAspect = null;
  outer: for (let m = 0; m <= 36 * 2; m++) {
    const t = new Date(now.getTime() - m * 1800e3);
    const ml = geoLonAt('Moon', t);
    for (const b of BODIES) {
      if (b === 'Moon') continue;
      const sepA = Math.abs(((ml - geoLonAt(b, t) + 540) % 360) - 180);
      for (const [ang] of ASP) if (Math.abs(sepA - ang) < 0.3) { lastAspect = { body: b, at: t }; break outer; }
    }
  }
  const ill = moonIllumination(now);
  lines.push(change
    ? `Void-of-course Moon: ${lastAspect ? `last exact major aspect was Moon–${lastAspect.body} at ${fmtET(lastAspect.at)} ET (30-minute scan)` : 'no exact major aspect found in the past 36 h scan'}; the window closes when the Moon enters ${change.sign} at ${fmtET(change.at)} ET. Moon is in ${signOf(ill.moonLon)} until then.`
    : 'Void-of-course Moon: no sign change in the next 72 h.');

  // Mercury stations (scan ±75 days for direction flips)
  const stations = [];
  let prevDir = null;
  for (let d = -75; d <= 75; d += 1) {
    const t = new Date(now.getTime() + d * 864e5);
    const dir = isRetro('Mercury', t) ? 'R' : 'D';
    if (prevDir && dir !== prevDir) stations.push({ at: t, kind: dir === 'R' ? 'stations retrograde' : 'stations direct' });
    prevDir = dir;
  }
  const past = stations.filter((s) => s.at <= now).pop(), future = stations.find((s) => s.at > now);
  lines.push(`Mercury: ${isRetro('Mercury', now) ? 'retrograde now' : 'direct now'}${past ? ` · last station ${past.kind} ~${fmtDayET(past.at)}` : ''}${future ? ` · next station ${future.kind} ~${fmtDayET(future.at)}` : ''} (daily scan, ±1 day). Shadow periods run roughly two weeks either side of the stations.`);

  // planetary hours
  const ev = sunEvents(dayUTC, LAT, LON);
  const dow = new Date(dayUTC.getTime()).getUTCDay();
  const dayRuler = DAY_RULERS[dow];
  const seqStart = CHALDEAN.indexOf(dayRuler);
  const isDay = now >= ev.sunRise && now < ev.sunSet;
  const spanStart = isDay ? ev.sunRise : ev.sunSet;
  const spanEnd = isDay ? ev.sunSet : new Date(ev.sunRise.getTime() + 864e5);
  const hourLen = (spanEnd - spanStart) / 12;
  const idx = Math.min(11, Math.floor((now - spanStart) / hourLen));
  const rulerNow = CHALDEAN[(seqStart + (isDay ? idx : 12 + idx)) % 7];
  lines.push(`Planetary hour now: ${rulerNow} (${isDay ? 'day' : 'night'} hour ${idx + 1} of 12; day ruler ${dayRuler}). Hours divide sunrise→sunset and sunset→sunrise into twelfths, sequenced by the Chaldean order.`);

  // numerology
  const ySum = String(ty).split('').map(Number).reduce((a, b) => a + b, 0);
  const mSum = ySum + tm, dSum = mSum + td;
  const masters = [ySum, mSum, dSum].filter((n) => [11, 22, 33].includes(n));
  lines.push(`Numerology: Universal Year ${reduceNum(ySum)} · Universal Month ${reduceNum(mSum)} · Universal Day ${reduceNum(dSum)}${masters.length ? ` · master number present before reduction: ${masters.join(', ')}` : ''}.`);

  // moon calendar: next new + full (6-h scan of cycle fraction)
  const cyc = (d) => moonIllumination(d).cycle;
  let prev = cyc(now), nextNew = null, nextFull = null;
  for (let h = 6; h <= 40 * 24 && (!nextNew || !nextFull); h += 6) {
    const t = new Date(now.getTime() + h * 3600e3), c = cyc(t);
    if (prev < 0.5 && c >= 0.5 && !nextFull) nextFull = t;
    if (prev > c && !nextNew) nextNew = t; // wrapped past 1.0 → new
    prev = c;
  }
  if (nextFull) {
    const dist = moonDistanceKm(nextFull);
    const mName = FULL_MOON_NAMES[Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric' }).format(nextFull))];
    lines.push(`Next full moon: ~${fmtDayET(nextFull)} — the ${mName} Moon · distance ~${dist.toLocaleString()} km${dist < 360000 ? ' · supermoon range (near perigee)' : dist > 400000 ? ' · micromoon range (near apogee)' : ''} (±6 h scan).`);
  }
  if (nextNew) lines.push(`Next new moon: ~${fmtDayET(nextNew)} (±6 h scan).`);

  // solstice / equinox / cross-quarter countdown
  const sunLonAt = (d) => moonIllumination(d).sunLon;
  const targets = [[0, 'March equinox'], [45, 'cross-quarter (Beltane point)'], [90, 'June solstice'], [135, 'cross-quarter (Lughnasa point)'], [180, 'September equinox'], [225, 'cross-quarter (Samhain point)'], [270, 'December solstice'], [315, 'cross-quarter (Imbolc point)']];
  let nextSolar = null;
  for (let d = 1; d <= 370 && !nextSolar; d++) {
    const a = sunLonAt(new Date(now.getTime() + (d - 1) * 864e5)), b = sunLonAt(new Date(now.getTime() + d * 864e5));
    for (const [deg, nm] of targets) {
      const crossed = (a < deg && b >= deg) || (deg === 0 && a > 350 && b >= 0 && b < 10);
      if (crossed) { nextSolar = { name: nm, days: d }; break; }
    }
  }
  if (nextSolar) lines.push(`Next solar station: ${nextSolar.name} in ~${nextSolar.days} day(s).`);

  // calendars
  try { lines.push(`Hebrew date: ${new Intl.DateTimeFormat('en-u-ca-hebrew', { dateStyle: 'full', timeZone: 'America/New_York' }).format(now)}.`); } catch { /* ICU calendar unavailable */ }
  try { lines.push(`Islamic date: ${new Intl.DateTimeFormat('en-u-ca-islamic', { dateStyle: 'full', timeZone: 'America/New_York' }).format(now)}.`); } catch { /* unavailable */ }
  try { lines.push(`Chinese lunar date: ${new Intl.DateTimeFormat('en-u-ca-chinese', { dateStyle: 'full', timeZone: 'America/New_York' }).format(now)}.`); } catch { /* unavailable */ }
  const yrIdx = ((ty - 4) % 60 + 60) % 60;
  lines.push(`Chinese year pillar: ${STEMS[yrIdx % 10]} ${BRANCHES[yrIdx % 12]} (sexagenary cycle, year turns at Lunar New Year / Li Chun by school).`);
  const daysSince1900 = Math.floor(Date.UTC(ty, tm - 1, td) / 864e5) - Math.floor(Date.UTC(1900, 0, 1) / 864e5);
  const dayIdx = ((10 + daysSince1900) % 60 + 60) % 60; // 1900-01-01 = Jia-Xu (index 10)
  lines.push(`Chinese day pillar: ${STEMS[dayIdx % 10]} ${BRANCHES[dayIdx % 12]} (continuous sexagenary count from the 1900-01-01 Jia-Xu anchor).`);
  // Mayan
  const daysSinceEpoch = Math.floor(Date.UTC(ty, tm - 1, td) / 864e5) + 719162; // days since 0001-01-01 → adjust below
  const GMT = 584283; // Julian day number of 0.0.0.0.0
  const jdn = Math.floor(Date.UTC(ty, tm - 1, td) / 864e5) + 2440588;
  const lc = jdn - GMT;
  const baktun = Math.floor(lc / 144000), katun = Math.floor((lc % 144000) / 7200), tun = Math.floor((lc % 7200) / 360), winal = Math.floor((lc % 360) / 20), kin = lc % 20;
  const tzNum = ((lc % 13) + 3) % 13 + 1, tzName = TZOLKIN_NAMES[((lc % 20) + 19) % 20];
  const haabPos = ((lc + 328) % 365 + 365) % 365;
  lines.push(`Mayan: Long Count ${baktun}.${katun}.${tun}.${winal}.${kin} · Tzolkin ${tzNum} ${tzName} · Haab ${haabPos % 20} ${HAAB[Math.floor(haabPos / 20)]} (GMT correlation 584283).`);
  void daysSinceEpoch;
  // deterministic day picks
  const h = hashDate(todayET);
  lines.push(`I Ching hexagram of the day: ${ICHING[h % 64]} (King Wen #${(h % 64) + 1}, drawn deterministically from the date).`);
  lines.push(`Rune of the day: ${RUNES[h % 24]} (Elder Futhark, drawn deterministically from the date).`);
  const tree = TREE_SIGNS.find((s, i) => {
    const next = TREE_SIGNS[(i + 1) % TREE_SIGNS.length];
    const cur = tm * 100 + td, f = s[0] * 100 + s[1], t = next[0] * 100 + next[1];
    return f <= t ? (cur >= f && cur < t) : (cur >= f || cur < t);
  });
  if (tree) lines.push(`Celtic tree calendar: ${tree[2]} season (Graves\u2019 tree calendar dates).`);

  return {
    source: 'Computed exactly by each system\u2019s own rules — ephemeris from JPL approximate elements, calendars from their standard arithmetic',
    planets, aspects: aspects.slice(0, 8).map((a) => a.text), lines,
  };
}

// ---------------- HUMAN WORLD II ----------------
export async function getHuman2() {
  const out = { source: 'CoinGecko · data.ny.gov (NY Lottery results) · FEMA Open Data · openFDA' };
  out.eth = await sub(async () => {
    const j = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true');
    return { lines: [`Ethereum: $${j.ethereum.usd.toLocaleString()} (${j.ethereum.usd_24h_change >= 0 ? '+' : ''}${j.ethereum.usd_24h_change.toFixed(2)}% / 24 h, CoinGecko).`] };
  });
  out.metals = await sub(async () => {
    const one = async (sym) => {
      const txt = await fetchText(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`);
      const row = txt.trim().split('\n')[1];
      if (!row) throw new Error('no stooq row');
      return row.split(',');
    };
    const [au, ag, oil, spx] = await Promise.all([one('xauusd'), one('xagusd'), one('cl.f'), one('^spx')]);
    return { lines: [`At last close (Stooq): gold $${au[6]} · silver $${ag[6]} · WTI crude $${oil[6]} · S&P 500 ${spx[6]}.`] };
  });
  out.powerball = await sub(async () => {
    const j = await fetchJSON('https://data.ny.gov/resource/d6yy-54nr.json?$limit=1&$order=draw_date%20DESC');
    const r = j[0];
    return { lines: [`Powerball latest draw (${r.draw_date.slice(0, 10)}, via NY Lottery data): ${r.winning_numbers}${r.multiplier ? ` · multiplier ${r.multiplier}` : ''}. Jackpot is not in the results feed — see the official site for the current figure.`] };
  });
  out.fema = await sub(async () => {
    const j = await fetchJSON("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=state%20eq%20'VA'&$orderby=declarationDate%20desc&$top=3");
    const list = (j.DisasterDeclarationsSummaries || []).map((d) => `${d.declarationType} ${d.declarationDate.slice(0, 10)} — ${d.declarationTitle}`);
    if (!list.length) throw new Error('no VA declarations returned');
    return { lines: [`Latest FEMA declarations for Virginia: ${list.join(' · ')}.`] };
  });
  out.fda = await sub(async () => {
    const j = await fetchJSON('https://api.fda.gov/food/enforcement.json?limit=3');
    const list = (j.results || []).map((r) => `${r.recalling_firm} — ${(r.product_description || '').slice(0, 80)} (${r.report_date})`);
    if (!list.length) throw new Error('no recalls returned');
    return { lines: [`Latest FDA food enforcement reports: ${list.join(' · ')}.`] };
  });
  return out;
}

// ---------------- ANOMALY REGISTRY BITS ----------------
export async function getAnomalyBits() {
  const out = {};
  out.days_since = await sub(async () => {
    const res = {};
    for (const [key, mag] of [['m7', 7], ['m8', 8]]) {
      try {
        const start = new Date(Date.now() - 3 * 365.25 * 864e5).toISOString().slice(0, 10);
        const j = await fetchJSON(`https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${start}&minmagnitude=${mag}&orderby=time&limit=1`);
        if (j.features && j.features.length) {
          const t = j.features[0].properties.time;
          res[key] = { days: Math.floor((Date.now() - t) / 864e5), date: new Date(t).toISOString().slice(0, 10), place: j.features[0].properties.place, mag: j.features[0].properties.mag };
        } else res[key] = { days: null, note: `none in the past 3 years` };
      } catch { res[key] = { days: null, note: 'query failed this build' }; }
    }
    return res;
  });
  return out;
}
export { fmtET, fmtDayET, todayET };
