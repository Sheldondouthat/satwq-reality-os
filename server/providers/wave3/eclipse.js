/**
 * Wave 3 / Track 3b — eclipse geometry provider (keyless, no upstream).
 *
 * Serves GET /api/eclipse?event=2045[&stepMin=5].
 *
 * The geometry is COMPUTED server-side from embedded Besselian elements
 * (NASA GSFC / Fred Espenak, Five Millennium Canon; see
 * src/frontier/wave3/eclipse/model.js for the source citation). There is no
 * upstream to fail — the elements are static published data, so the route
 * always serves (pure function of the query params).
 *
 * Response: event metadata + sampled centerline + umbral ellipses +
 * golden/blue-hour band definitions. Times are UTC ISO strings.
 */
import {
  ECLIPSE_2045,
  LIGHT_BANDS,
  sampleEclipse,
} from '../../../src/frontier/wave3/eclipse/model.js';

export const ECLIPSE_ROUTE = '/api/eclipse';

const EVENTS = {
  2045: ECLIPSE_2045,
};

export function describeEclipse(eventKey, stepMin) {
  const ev = EVENTS[eventKey];
  if (!ev) return null;
  const step = Math.max(1, Math.min(30, Math.floor(stepMin) || 5));
  const { samples, tStart, tEnd } = sampleEclipse(ev, { stepMin: step });
  const usSamples = samples.filter(
    (s) =>
      s.center.lonDeg > -130 &&
      s.center.lonDeg < -65 &&
      s.center.latDeg > 20 &&
      s.center.latDeg < 55,
  );
  return {
    schemaVersion: 1,
    event: eventKey,
    name: ev.name,
    saros: ev.saros,
    attribution:
      'Eclipse Predictions by Fred Espenak, NASA\u2019s GSFC ' +
      '(Five Millennium Canon of Solar Eclipses)',
    greatestEclipseUtc: ev.greatestEclipseUtc,
    published: {
      greatestLat: ev.greatestLat,
      greatestLon: ev.greatestLon,
      pathWidthKm: ev.pathWidthKm,
      centralDurationSec: ev.centralDurationSec,
    },
    honesty:
      'Centerline and shadow ellipses are computed from NASA-published ' +
      'Besselian elements (VSOP87/ELP2000-82). Edge accuracy is limited to ' +
      '~1-2 km by the lunar limb profile; 2045 ΔT follows Morrison & ' +
      'Stephenson (2004) and may drift. This is a rehearsal model, not an ' +
      'official prediction product.',
    stepMin: step,
    sampleCount: samples.length,
    samples: samples.map((s) => ({
      utc: s.utc,
      lat: +s.center.latDeg.toFixed(4),
      lon: +s.center.lonDeg.toFixed(4),
      widthKm: s.ellipse ? +s.ellipse.widthKm.toFixed(1) : null,
      semiMajorKm: s.ellipse ? +s.ellipse.semiMajorKm.toFixed(1) : null,
      majorAxisBearingDeg: s.ellipse
        ? +s.ellipse.majorAxisBearingDeg.toFixed(1)
        : null,
      sunAltitudeDeg: s.ellipse ? +s.ellipse.sunAltitudeDeg.toFixed(1) : null,
      durationSec: s.durationSec ? Math.round(s.durationSec) : null,
      inUs:
        s.center.lonDeg > -130 &&
        s.center.lonDeg < -65 &&
        s.center.latDeg > 20 &&
        s.center.latDeg < 55,
    })),
    usPassage:
      usSamples.length > 0
        ? {
            firstUtc: usSamples[0].utc,
            lastUtc: usSamples[usSamples.length - 1].utc,
            landfall: {
              lat: +usSamples[0].center.latDeg.toFixed(2),
              lon: +usSamples[0].center.lonDeg.toFixed(2),
            },
          }
        : null,
    lightBands: LIGHT_BANDS,
    windowTdt: { tStart, tEnd },
  };
}

export function eclipseProxy() {
  const installMiddleware = (server) => {
    server.middlewares.use(ECLIPSE_ROUTE, async (req, res) => {
      const sendJson = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        const eventKey = url.searchParams.get('event') || '2045';
        const stepMin = Number(url.searchParams.get('stepMin')) || 5;
        const doc = describeEclipse(eventKey, stepMin);
        if (!doc) {
          sendJson(404, {
            error: 'unknown_eclipse_event',
            knownEvents: Object.keys(EVENTS),
          });
          return;
        }
        sendJson(200, doc);
      } catch {
        sendJson(500, { error: 'eclipse proxy error' });
      }
    });
  };

  return {
    name: 'eclipse-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
