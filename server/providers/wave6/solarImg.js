/**
 * Wave 6 — solar imagery manifest (keyless, no bytes proxied).
 *
 * Returns a manifest of "latest" solar-image URLs the UI can load directly
 * as image layers — the edge never proxies image bytes, it only hands out
 * URLs:
 *
 *   SDO AIA/HMI  (#32–36)  https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_{ch}.jpg
 *   SOHO         (#18–22)  https://soho.nascom.nasa.gov/data/realtime/{inst}/{size}/latest.jpg
 *   STEREO       (#23–25)  https://stereo-ssc.nascom.nasa.gov/beacon/…
 *   SUVI         (#26–31)  https://services.swpc.noaa.gov/images/animations/suvi/primary/{ch}/latest.png
 *   PROBA2       (#37–38)  https://proba2.sidc.be/…
 *
 * Routes:
 *   GET /api/solar-img → {generatedAt, count, attribution, images:[…]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): SDO latest_1024_0193.jpg → 200;
 * SOHO c2/1024/latest.jpg → 200; STEREO ahead_euvi_195_latest.jpg → 200;
 * SWPC hosts verified 200 across the space-weather build today; the two
 * Belgian SIDC hosts (proba2.sidc.be) returned curl 000 from the VM —
 * recorded as probe:'vm-000', flagged "VM-throttled, needs Worker probe",
 * NOT marked broken.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const CACHE_TTL_MS = 30 * 60_000; // manifest is static; refresh the wrapper on a slow cadence
const USER_AGENT = "Gods Eye View (solar imagery manifest)";

const IMAGES = [
  // ——— SDO (NASA/SDO) ———
  {
    id: "sdo-aia-193",
    name: "SDO AIA 193 Å",
    instrument: "SDO/AIA",
    url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/SDO",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "sdo-aia-304",
    name: "SDO AIA 304 Å",
    instrument: "SDO/AIA",
    url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0304.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/SDO",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "sdo-aia-211",
    name: "SDO AIA 211 Å",
    instrument: "SDO/AIA",
    url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0211.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/SDO",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "sdo-aia-1600",
    name: "SDO AIA 1600 Å",
    instrument: "SDO/AIA",
    url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_1600.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/SDO",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "sdo-hmi-continuum",
    name: "SDO HMI continuum",
    instrument: "SDO/HMI",
    url: "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg",
    format: "JPEG 1024px",
    cadence: "~45 s",
    attribution: "NASA/SDO",
    license: "NASA",
    probe: "vm-200",
  },
  // ——— SOHO (NASA/ESA) ———
  {
    id: "soho-lasco-c2",
    name: "SOHO LASCO C2",
    instrument: "SOHO/LASCO",
    url: "https://soho.nascom.nasa.gov/data/realtime/c2/1024/latest.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/ESA SOHO",
    license: "NASA/ESA",
    probe: "vm-200",
  },
  {
    id: "soho-lasco-c3",
    name: "SOHO LASCO C3",
    instrument: "SOHO/LASCO",
    url: "https://soho.nascom.nasa.gov/data/realtime/c3/512/latest.jpg",
    format: "JPEG 512px",
    cadence: "~12 min",
    attribution: "NASA/ESA SOHO",
    license: "NASA/ESA",
    probe: "vm-200",
  },
  {
    id: "soho-eit-304",
    name: "SOHO EIT 304 Å",
    instrument: "SOHO/EIT",
    url: "https://soho.nascom.nasa.gov/data/realtime/eit_304/512/latest.jpg",
    format: "JPEG 512px",
    cadence: "~12 min",
    attribution: "NASA/ESA SOHO",
    license: "NASA/ESA",
    probe: "vm-200",
  },
  {
    id: "soho-eit-195",
    name: "SOHO EIT 195 Å",
    instrument: "SOHO/EIT",
    url: "https://soho.nascom.nasa.gov/data/realtime/eit_195/512/latest.jpg",
    format: "JPEG 512px",
    cadence: "~12 min",
    attribution: "NASA/ESA SOHO",
    license: "NASA/ESA",
    probe: "vm-200",
  },
  {
    id: "soho-hmi-igr",
    name: "SOHO HMI intensitygram",
    instrument: "SOHO/HMI",
    url: "https://soho.nascom.nasa.gov/data/realtime/hmi_igr/1024/latest.jpg",
    format: "JPEG 1024px",
    cadence: "~12 min",
    attribution: "NASA/ESA SOHO",
    license: "NASA/ESA",
    probe: "vm-200",
  },
  // ——— STEREO (NASA STEREO SSC) ———
  {
    id: "stereo-ahead-euvi-195",
    name: "STEREO ahead EUVI 195 Å",
    instrument: "STEREO/EUVI",
    url: "https://stereo-ssc.nascom.nasa.gov/beacon/latest_256/ahead_euvi_195_latest.jpg",
    format: "JPEG 256px",
    cadence: "beacon",
    attribution: "NASA STEREO SSC",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "stereo-behind-cor2",
    name: "STEREO behind COR2",
    instrument: "STEREO/COR2",
    url: "https://stereo-ssc.nascom.nasa.gov/beacon/latest_256/behind_cor2_latest.jpg",
    format: "JPEG 256px",
    cadence: "beacon",
    attribution: "NASA STEREO SSC",
    license: "NASA",
    probe: "vm-200",
  },
  {
    id: "stereo-euvi-195-movie",
    name: "STEREO EUVI 195 rotation movie",
    instrument: "STEREO/EUVI",
    url: "https://stereo-ssc.nascom.nasa.gov/beacon/euvi_195_rotated.gif",
    format: "GIF 256px",
    cadence: "rolling",
    attribution: "NASA STEREO SSC",
    license: "NASA",
    probe: "vm-200",
  },
  // ——— SUVI (NOAA) ———
  {
    id: "suvi-304",
    name: "SUVI 304 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/304/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  {
    id: "suvi-094",
    name: "SUVI 094 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/094/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  {
    id: "suvi-131",
    name: "SUVI 131 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/131/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  {
    id: "suvi-171",
    name: "SUVI 171 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/171/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  {
    id: "suvi-195",
    name: "SUVI 195 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/195/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  {
    id: "suvi-284",
    name: "SUVI 284 Å",
    instrument: "GOES/SUVI",
    url: "https://services.swpc.noaa.gov/images/animations/suvi/primary/284/latest.png",
    format: "PNG 1280px",
    cadence: "~5 min",
    attribution: "NOAA",
    license: "NOAA public domain",
    probe: "catalog",
  },
  // ——— PROBA2 (ROB/SIDC) ———
  {
    id: "proba2-swap-synoptic",
    name: "PROBA2 SWAP synoptic map",
    instrument: "PROBA2/SWAP",
    url: "https://proba2.sidc.be/swap/data/SWAPsynopticMap/LatestSWAPsynopticMap.png",
    format: "PNG 3084×609",
    cadence: "daily",
    attribution: "ROB/SIDC",
    license: "ROB/SIDC, credit PROBA2",
    probe: "vm-000",
  },
  {
    id: "proba2-lyra-quicklook",
    name: "PROBA2 LYRA 3-day quicklook",
    instrument: "PROBA2/LYRA",
    url: "https://proba2.sidc.be/lyra/data/3DayQuicklook/LyraCalSWClatest.png",
    format: "PNG 650×500",
    cadence: "3-day window",
    attribution: "ROB/SIDC",
    license: "ROB/SIDC",
    probe: "vm-000",
  },
];

const PROBE_NOTE =
  "probe legend — vm-200: returned HTTP 200 from the build VM on 2026-09-27; " +
  "catalog: host verified 200 by the feed-catalog survey 2026-09-27; " +
  "vm-000: unreachable from the build VM (VM-throttled, needs Worker probe) — included, not marked broken.";

let cache = null; // {at, payload}
let inflight = null;

function buildManifest() {
  return {
    generatedAt: new Date().toISOString(),
    count: IMAGES.length,
    attribution:
      "Solar imagery: NASA/SDO, NASA/ESA SOHO, NASA STEREO SSC, NOAA SWPC (public domain), ROB/SIDC PROBA2 (credit). " +
      "Manifest only — image bytes are loaded client-side from the origin hosts.",
    probeNote: PROBE_NOTE,
    images: IMAGES.map((img) => ({ ...img })),
  };
}

async function getManifest() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.resolve(buildManifest())
      .then((payload) => {
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = "public, max-age=1800") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function solarImgProxy() {
  async function handler(req, res) {
    if (req.method !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" }, "no-store");
    try {
      sendJson(res, 200, await getManifest());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === "AbortError" ||
        /aborted?/i.test(error?.message ?? "");
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: "solar_img_unavailable",
          detail: error?.message ?? "unknown",
        },
        "no-store",
      );
    }
  }

  return {
    name: "solarImg",
    configureServer({ middlewares }) {
      middlewares.use("/api/solar-img", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/solar-img", handler);
    },
  };
}

export const _solarImgInternals = {
  IMAGES,
  buildManifest,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
