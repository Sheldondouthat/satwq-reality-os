/**
 * Wave 6 — aurora webcam manifest (keyless, no bytes proxied).
 *
 * Returns a manifest of "latest" all-sky aurora camera images the UI can
 * load directly as image layers — the edge never proxies image bytes:
 *
 *   #40 IRF Kiruna all-sky   https://www.irf.se/alis/allsky/krn/latest_medium.jpeg
 *   #41 UEC Tromsø           https://tromsoe-ai.cei.uec.ac.jp/~nanjo/public/aurora_alert/latest.jpg
 *   #42 TGO Skibotn          https://fox.phys.uit.no/ASC/Latest_ASC01.png
 *   #43 AuroraMAX Yellowknife https://auroramax.phys.ucalgary.ca/recent/recent_480p.jpg
 *
 * Routes:
 *   GET /api/aurora-cams → {generatedAt, count, attribution, cams:[…]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): AuroraMAX → 200; IRF, UEC Tromsø and
 * TGO Skibotn returned curl 000 from the VM — recorded as probe:'vm-000',
 * flagged "VM-throttled, needs Worker probe", NOT marked broken. All four
 * were verified 200 by the feed-catalog survey earlier on 2026-09-27.
 */

const CACHE_TTL_MS = 30 * 60_000; // manifest is static; refresh the wrapper on a slow cadence

const CAMS = [
  {
    id: "irf-kiruna",
    name: "IRF Kiruna all-sky",
    url: "https://www.irf.se/alis/allsky/krn/latest_medium.jpeg",
    format: "JPEG",
    cadence: "~1 min",
    lat: 67.86,
    lon: 20.96,
    license: "KAGO non-commercial, cite IRF",
    attribution: "Swedish Institute of Space Physics (IRF)",
    probe: "vm-000",
  },
  {
    id: "uec-tromso",
    name: "UEC Tromsø aurora cam",
    url: "https://tromsoe-ai.cei.uec.ac.jp/~nanjo/public/aurora_alert/latest.jpg",
    format: "JPEG 400×400",
    cadence: "~5 min",
    lat: 69.65,
    lon: 18.96,
    license: "academic, credit UEC/NIPR",
    attribution: "University of Electro-Communications / NIPR",
    probe: "vm-000",
  },
  {
    id: "tgo-skibotn",
    name: "TGO Skibotn all-sky",
    url: "https://fox.phys.uit.no/ASC/Latest_ASC01.png",
    format: "PNG",
    cadence: "~1 min",
    lat: 69.35,
    lon: 20.36,
    license: "academic, credit TGO/UiT",
    attribution: "Tromsø Geophysical Observatory, UiT",
    notes: "dark-hours only",
    probe: "vm-000",
  },
  {
    id: "auroramax-yellowknife",
    name: "AuroraMAX Yellowknife",
    url: "https://auroramax.phys.ucalgary.ca/recent/recent_480p.jpg",
    format: "JPEG 853×480",
    cadence: "~1 min",
    lat: 62.45,
    lon: -114.37,
    license: "UCalgary/CSA attribution",
    attribution: "University of Calgary / Canadian Space Agency",
    notes: "night season; typically off May–Aug",
    probe: "vm-200",
  },
];

const PROBE_NOTE =
  "probe legend — vm-200: returned HTTP 200 from the build VM on 2026-09-27; " +
  "vm-000: unreachable from the build VM (VM-throttled, needs Worker probe) — included, not marked broken. " +
  "All four cams were verified 200 by the feed-catalog survey earlier on 2026-09-27.";

let cache = null; // {at, payload}
let inflight = null;

function buildManifest() {
  return {
    generatedAt: new Date().toISOString(),
    count: CAMS.length,
    attribution:
      "Aurora cameras: Swedish Institute of Space Physics, UEC/NIPR, TGO/UiT, UCalgary/CSA. " +
      "Manifest only — image bytes are loaded client-side from the origin hosts.",
    probeNote: PROBE_NOTE,
    cams: CAMS.map((cam) => ({ ...cam })),
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

export function auroraCamsProxy() {
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
          error: "aurora_cams_unavailable",
          detail: error?.message ?? "unknown",
        },
        "no-store",
      );
    }
  }

  return {
    name: "auroraCams",
    configureServer({ middlewares }) {
      middlewares.use("/api/aurora-cams", handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use("/api/aurora-cams", handler);
    },
  };
}

export const _auroraCamsInternals = {
  CAMS,
  buildManifest,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
