# F9 Forecast Layers — Integration Guide

New files (this directory, created 2026-09-26):

| File | Contents |
|---|---|
| `fireSpread.js` | Pure spread math: `projectSpread()`, `DEFAULT_WIND`, wind/ignition normalizers |
| `fireSpread.test.mjs` | Geometry fixtures (downwind bias, monotone growth, validation) |
| `cones.js` | `/api/cyclones` fetch + cone validation + `coneStormEntity()` rendering |
| `cones.test.mjs` | Cone parsing/rendering fixtures |
| `ash.js` | Tokyo VAAC list + advisory-text parsing, `createVaacSource()`, `renderAshPanel()` |
| `ash.test.mjs` | VAAC fixtures (real ICAO advisory format) |
| `index.js` | `createFireSpreadLayer`, `createForecastConesLayer`, `createVolcanicAshLayer` |
| `forecast.test.mjs` | Layer lifecycle + rendering + empty/degraded states |

No existing file was modified. All new code is client-side, no new npm deps, no keys.

## 1. Register the layers (edit `src/app/constructCatalog.js`)

```js
import {
  createFireSpreadLayer,
  createForecastConesLayer,
  createVolcanicAshLayer,
} from '../layers/forecast/index.js';

// ...inside the catalog array, after createApplicationFirePerimeters:
createFireSpreadLayer({
  ignitions: () => smokeCentroidIgnitions(sources['hms-smoke']),
  // Omit windProvider to use the labeled DEFAULT_WIND (assumed from-W
  // 20 km/h). See §2 for the measured-wind upgrade.
}),
createForecastConesLayer(),   // fetches /api/cyclones itself
createVolcanicAshLayer(),     // fetches /api/vaac (see §3) or degrades
```

The layers follow the standard lifecycle (`init/enable/disable/update/destroy`,
`updateInterval`, `getStats`, `getRowControls`) so the catalog manager and
the row-controls tray (`src/app/layerPresentation.js` → `getRowControls(id)`)
pick them up automatically — including the fire-spread `+6h/+12h/+24h` step
chips and the ash advisory list.

## 2. Data-source wiring

### Ignitions (fire spread)

HMS smoke polygons are the keyless ignition proxy. Add this helper where the
application layers are composed (e.g. `src/app/layers/forecast.js`):

```js
const ringCentroid = (ring) => {
  let lon = 0, lat = 0;
  for (const [lo, la] of ring) { lon += lo; lat += la; }
  return { lon: lon / ring.length, lat: lat / ring.length };
};

/** HMS smoke centroids -> labeled ignition proxies (keyless tier). */
export async function smokeCentroidIgnitions(hmsSource, { max = 25 } = {}) {
  const snapshot = await hmsSource.getSnapshot({});
  return (snapshot.polygons ?? []).slice(0, max).map((poly, i) => {
    const c = ringCentroid(poly.ring);
    return {
      lat: c.lat, lon: c.lon,
      label: `HMS smoke centroid ${i + 1} (${poly.density})`,
      source: 'NOAA HMS smoke centroid — ignition PROXY, not a mapped ignition',
    };
  });
}
```

`ignitions` also accepts a plain array or a function returning one, so WFIGS
perimeter anchors (`fire-perimeters` layer `getAnalystRecords()` → `{lat, lon}`)
can be mixed in:

```js
ignitions: async () => [
  ...(await smokeCentroidIgnitions(sources['hms-smoke'])),
  // ...perimeter anchors from the fire-perimeters layer instance
],
```

KEYED UPGRADE: replace with FIRMS active-fire hotspots (`sources.firms`
→ `/api/firms`, keyed, NOT-CONFIGURED in prod) — same `{lat, lon, label, source}` shape.

### Wind (fire spread)

Default: `DEFAULT_WIND` (from W, 20 km/h) with the honest "assumed wind —
modeled projection, not measured" label rendered in the layer info. To wire
measured wind, pass `windProvider` — an async function returning
`{ fromDeg, speedKmh, label, measured: true }`:

```js
windProvider: async () => {
  // Example: sample the weather/wind API at the first ignition.
  // /api/weather is a GRIB window proxy; /api/wind is 404 on Pages (excluded).
  // Until a server-side wind sampler exists, expose a small UI control and
  // return the user's values with measured:false — never claim measured data.
  return { fromDeg: userDir, speedKmh: userSpeed, label: 'User-set wind', measured: false };
},
```

KEYED UPGRADE: server-side GRIB sampling at each ignition (the wind layer's
`fields.js` machinery), marked `measured: true`.

### Cyclone cones

`createForecastConesLayer()` needs no wiring: it fetches `/api/cyclones`
directly (same API the existing `weather-cyclones` layer uses) and validates
the already-attached `storm.cone` GeoJSON. Storms with `geometryStatus !==
'current'` are skipped, never relabeled. Empty-state ("No active storms") is
surfaced via `getRowControls().info` and `getStats().empty`.

### Volcanic ash — the /api/vaac proxy (§3)

Tokyo VAAC sends **no CORS headers**, so browsers cannot fetch it directly
(same situation as HMS smoke's `/api/hms-smoke` proxy). The ash layer fetches
the same-origin `VAAC_PROXY_PATH = '/api/vaac'` and degrades honestly without it.

## 3. VAAC proxy to create (`api/vaac.js` — NEW file, not included)

VAAC probe outcome, 2026-09-26 (OBSERVED):
- `https://www.ssd.noaa.gov/VAAC/` (Washington VAAC): **unreachable** from this
  runtime (curl http=000). Remains the documented US upgrade path.
- `https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html` (Tokyo VAAC):
  **reachable, keyless, live** — probe saw real 2026-09-26 advisories for
  SHEVELUCH (Russia), MAYON (Philippines), SAKURAJIMA (Japan).
- Advisory bodies are ICAO-standard VAA text → the parser works for any VAAC.

The proxy mirrors the list page and follows advisory links (or serve cached):

```js
// api/vaac.js — Vercel/Cloudflare-style: GET /api/vaac -> Tokyo VAAC list HTML;
// GET /api/vaac?u=<encoded advisory URL> -> that advisory's HTML (allow-listed host only).
import { mountProvider } from './_lib/connect.js';

const LIST_URL = 'https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html';
const ALLOWED = new Set(['ds.data.jma.go.jp']);

async function proxyText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Gods Eye View (public VAAC context)' } });
  if (!res.ok) throw new Error(`vaac_upstream_${res.status}`);
  return new Response(await res.text(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export default mountProvider(async (req) => {
  const u = new URL(req.url).searchParams.get('u');
  if (!u) return proxyText(LIST_URL);
  const target = new URL(u);
  if (!ALLOWED.has(target.hostname) || !/^\/svd\/vaac\/data\/TextData\//.test(target.pathname))
    return new Response('forbidden', { status: 403 });
  return proxyText(target.href);
});
```

And point the layer at it (the layer defaults `listUrl` to `/api/vaac`; the
advisory `href`s it follows are absolute Tokyo URLs, so pass them through the
proxy):

```js
createVolcanicAshLayer({
  source: createVaacSource({
    listUrl: '/api/vaac',
    // rewrite advisory fetches through the proxy:
    fetchImpl: (url, opts) =>
      fetch(url.startsWith('https://') ? `/api/vaac?u=${encodeURIComponent(url)}` : url, opts),
  }),
});
```

Until the proxy exists, `renderAshPanel()` and `getRowControls().info` show
the degraded state: volcanoes-layer context + "feed unavailable" + upgrade path.

## 4. Ash advisory panel mounting

```js
import { createVolcanicAshLayer } from '../layers/forecast/index.js';
const ashLayer = createVolcanicAshLayer();
// after layer.update() has run at least once:
ashLayer.renderPanel(document.getElementById('ash-panel'));
```

Or rely on `getRowControls()` — the app's row-controls tray renders the
advisory list items automatically.

## 5. Tests

```bash
cd ~/workspace/gods-eye-view
node --test src/layers/forecast/fireSpread.test.mjs \
           src/layers/forecast/cones.test.mjs \
           src/layers/forecast/ash.test.mjs \
           src/layers/forecast/forecast.test.mjs
# or the full suite: npm test  (discovers *.test.mjs automatically)
node --check src/layers/forecast/index.js   # plus each module
```

## 6. Honesty invariants (do not regress)

- Every spread ring carries `modeled: true`; the layer info panel says
  "MODELED projection — not a physics simulation" with the wind label.
- Ignition markers are labeled "ignition proxy".
- Cones skip non-current geometry; the cone is described as "center-track
  uncertainty, not the hazard area".
- Ash advisories are parsed from real advisory text only; any fetch/parse
  failure yields the degraded panel — never synthesized advisories.
