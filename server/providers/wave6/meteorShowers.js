/**
 * Wave 6 — IMO Meteor Shower Calendar (keyless, static).
 *
 * Annual major meteor showers per the International Meteor Organization
 * shower calendar. No upstream fetch: shower peaks are astronomical
 * clockwork (Earth crossing known comet debris streams), so the calendar
 * is computed from peak month/day, not observed live.
 *
 * Peak dates and ZHR (zenithal hourly rate at peak) are the IMO's
 * long-term values; active windows are the IMO's published activity
 * periods. daysToPeak is computed against the NEXT occurrence (rolls to
 * next year once this year's peak has passed).
 *
 * Routes:
 *   GET /api/meteor-showers → {generatedAt, count, showers:[...], honesty:{...}}
 *
 * Honesty: static calendar, not observations — a quiet night during an
 * "active" window is normal (ZHR is a peak ideal, not a nightly promise);
 * moonlight and clouds are not modeled here.
 */

const SHOWERS = [
  { name: 'Quadrantids', peak: '01-03', active: '12-28/01-12', zhr: 110 },
  { name: 'Lyrids', peak: '04-22', active: '04-16/04-25', zhr: 18 },
  { name: 'Eta Aquariids', peak: '05-06', active: '04-19/05-28', zhr: 50 },
  { name: 'Perseids', peak: '08-13', active: '07-17/08-24', zhr: 100 },
  { name: 'Orionids', peak: '10-21', active: '10-02/11-07', zhr: 20 },
  { name: 'Leonids', peak: '11-18', active: '11-06/11-30', zhr: 15 },
  { name: 'Geminids', peak: '12-14', active: '12-04/12-17', zhr: 120 },
  { name: 'Ursids', peak: '12-22', active: '12-17/12-26', zhr: 10 },
];

const DAY_MS = 86_400_000;

function nextPeak(peakMd, now) {
  const [m, d] = peakMd.split('-').map(Number);
  const y = now.getUTCFullYear();
  let dt = new Date(Date.UTC(y, m - 1, d));
  if (dt < now) dt = new Date(Date.UTC(y + 1, m - 1, d));
  return dt;
}

export function buildPayload(now = new Date()) {
  const showers = SHOWERS.map((s) => {
    const peakDate = nextPeak(s.peak, now);
    return {
      name: s.name,
      peak: peakDate.toISOString().slice(0, 10),
      active: s.active,
      zhr: s.zhr,
      daysToPeak: Math.floor((peakDate - now) / DAY_MS),
    };
  }).sort((a, b) => a.daysToPeak - b.daysToPeak);
  return {
    generatedAt: now.toISOString(),
    count: showers.length,
    showers,
    honesty: {
      kind: 'static calendar, not live observations',
      zhr: 'zenithal hourly rate at peak under ideal dark skies — not a nightly promise',
      moonAndClouds:
        'not modeled; a bright moon washes out all but the brightest meteors',
      source:
        'International Meteor Organization shower calendar (long-term values)',
    },
  };
}

function sendJson(res, status, body, cache = 'public, max-age=86400') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cache,
  });
  res.end(JSON.stringify(body));
}

async function handler(req, res) {
  if (req.method !== 'GET')
    return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
  sendJson(res, 200, buildPayload());
}

export function meteorShowersProxy() {
  return {
    name: 'meteor-showers',
    configureServer({ middlewares }) {
      middlewares.use('/api/meteor-showers', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/meteor-showers', handler);
    },
  };
}
