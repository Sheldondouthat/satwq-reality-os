# F13 "Invisible Ocean" — Integration Guide

Planetary ambient-RF observatory: live WSPRnet + PSK Reporter propagation
arcs on the globe (colored by band, fading with spot age) + an "EM weather"
ticker panel (solar wind, Kp, X-ray class, MUF-intuition band hints).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `src/layers/invisibleOcean/model.js` | Pure core: Maidenhead→lat/lon, great-circle math, band table, spot normalize/age/fade, PSK-XML + WSPR-HTML parsers, SWPC parsing, MUF intuition. No Cesium/DOM/node imports — shared by browser + server proxy. |
| `src/layers/invisibleOcean/source.js` | Client fetchers (injectable fetch): propagation via proxy, EM weather direct from SWPC. |
| `src/layers/invisibleOcean/index.js` | `createInvisibleOceanLayer({source, overlayHost})` — Cesium arcs, 3-min sweep, lifecycle per aurora pattern. |
| `src/layers/invisibleOcean/panel.js` | `createEmWeatherPanel({getState})` — EM weather ticker DOM, day/night band visualization, causality copy. |
| `src/layers/invisibleOcean/about.js` | Honesty copy (boundaries, model-not-measurement, empty-state policy). |
| `src/layers/invisibleOcean/invisibleOcean.test.mjs` | 25 tests: great-circle, aging, SWPC fixtures, MUF bounds, parsers, source orchestration. |
| `server/providers/invisibleOceanProxy.js` | `export function invisibleOceanProxy()` — cyclones-pattern provider mounting `/api/invisible-ocean/spots`; fetches + normalizes WSPRnet/PSK Reporter server-side (they lack CORS). |
| `src/indoor/CSI_STARTER.md` | ESP32 Wi-Fi CSI presence/breathing starter doc for the indoor twin. |

## 2. Probe outcomes (verified 2026-09-26 from sandbox)

| Source | Verdict | Working URL / params |
|---|---|---|
| **PSK Reporter** | ✅ keyless, machine-readable | `https://retrieve.pskreporter.info/query?flowStartSeconds=-900&rptlimit=1500&encap=2&rronly=1` → XML `<receptionReport>` attrs wrapped in `<js><![CDATA[…]]>`. ~2,010 reports per 15-min window at rptlimit=2000. **No CORS headers → server proxy required.** |
| **WSPRnet olddb** | ✅ keyless, HTML table | `https://www.wsprnet.org/olddb?mode=html&band=all&limit=300&sortby=time` (note: `wsprnet.org` 302-redirects to `www.` — follow redirects). Columns: Date/Call/Freq/SNR/Drift/Grid/dBm/W/**Reporter**/ReporterGrid/km/mi/Mode. **No CORS → server proxy, parsed server-side.** |
| wspr.live ClickHouse | ❌ skipped | Public `https://db1.wspr.live/` returns empty database list; schema unknown. Documented upgrade path: if wspr.live publishes a stable keyless table again, add it as a third provider in the proxy (pure SELECT, no auth). |
| **SWPC solar wind** | ✅ keyless + CORS `*` (direct browser fetch) | `https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json` → `[{"proton_speed":452,"time_tag":"…"}]` |
| **SWPC mag field** | ✅ keyless + CORS `*` | `…/products/summary/solar-wind-mag-field.json` → `[{"bt":4,"bz_gsm":0,…}]` |
| **SWPC X-ray** | ✅ keyless + CORS `*` | `https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json` → rows `{flux, energy:"0.1-0.8nm"}` (long channel = GOES class) |
| **SWPC Kp** | ✅ keyless + CORS `*` | `https://services.swpc.noaa.gov/json/planetary_k_index_1m.json` → rows `{kp_index, estimated_kp}` |
| **SWPC 10.7cm flux** | ✅ keyless + CORS `*` | `…/products/summary/10cm-flux.json` → `[{"flux":101,…}]` |
| ⚠️ `products/solar-wind/plasma-2-hour.json` + `mag-2-hour.json` (from the brief) | **404 as of 2026-09-26** | SWPC reorganized; the `products/summary/*` endpoints above are the working replacements. |
| TEC / ionosonde overlay | skipped | Nothing clean + keyless found in a light touch; the MUF intuition uses SWPC flux + day/night geometry instead, labelled MODEL. |
| VLF lightning energy | not shipped | No keyless VLF feed exists (Blitzortung needs a key). Sibling lightning layer owns strike rendering; we show propagation energy only. |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import (alphabetical neighbors shown):

```js
import { cycloneProxy } from './cyclones.js';
import { invisibleOceanProxy } from './invisibleOceanProxy.js';   // ADD
```

and in `localProviderPlugins()`, after `cycloneProxy(),`:

```js
    cycloneProxy(),
    invisibleOceanProxy(),   // ADD
```

### 3b. Server proxy — Cloudflare Pages Functions registry

`server/pages/registry.mjs` — add one entry to `REGISTRY` (isolated dynamic
import keeps a workerd load failure from affecting other providers):

```js
  {
    name: 'invisible-ocean',
    routes: ['/api/invisible-ocean'],
    load: () => import('../providers/invisibleOceanProxy.js').then((m) => m.invisibleOceanProxy()),
  },
```

The provider imports only `./common/http.js` and the pure
`../../src/layers/invisibleOcean/model.js` — no `node:` imports, no WASM, no
npm deps — so it is workerd-safe by construction.

### 3c. Source registration

`src/standalone/layerSources.js`:

```js
import { createInvisibleOceanSource } from '../layers/invisibleOcean/source.js';  // ADD
// ...
    aurora: createAuroraSource(),
    'invisible-ocean': createInvisibleOceanSource(),   // ADD
```

### 3d. App-layer glue — NEW file `src/app/layers/invisibleOcean.js`

```js
import { createInvisibleOceanLayer } from '../../layers/invisibleOcean/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire the Invisible Ocean RF propagation layer to the application overlay host. */
export function createApplicationInvisibleOcean(options) {
  return createInvisibleOceanLayer({ overlayHost, ...options });
}
```

### 3e. Catalog registration — `src/app/constructCatalog.js`

```js
import { createApplicationInvisibleOcean } from './layers/invisibleOcean.js';  // ADD (with other app-layer imports)
// capability map, near `aurora: ['getSnapshot'],`:
  'invisible-ocean': ['getPropagationSnapshot', 'getEmWeatherSnapshot'],   // ADD
// layer list, near createApplicationAurora(...):
        createApplicationInvisibleOcean({ source: sources['invisible-ocean'] }),   // ADD
```

### 3f. Panel mounting

Wherever the layer's detail/inspector UI is composed (next to other panels):

```js
import { createEmWeatherPanel } from '../layers/invisibleOcean/index.js';

const panel = createEmWeatherPanel({ getState: () => invisibleOceanLayer.getEmState() });
detailContainer.appendChild(panel.element);
panel.start();              // re-renders on a 60 s tick; call panel.update() after each layer sweep too
// on teardown: panel.stop(); panel.destroy();
```

About copy for an About/Info affordance:

```js
import { HONESTY_COPY } from '../layers/invisibleOcean/index.js';
// HONESTY_COPY.full  -> about view body
// HONESTY_COPY.short -> footer / tooltip
```

## 4. Behavior contract

- **Sweep:** `updateInterval: 180000` (3 min). Spots fade over `SPOT_TTL_MS`
  (15 min); newest 350 arcs render, oldest culled first.
- **Perf caps:** proxy serves ≤ 800 spots; client renders ≤ 350 arcs;
  WSPR HTML capped at 300 rows upstream, PSK at 1500 reports.
- **Empty states:** if the proxy is unreachable or both upstreams fail, the
  layer renders no arcs and `getStats().error` carries the reason; the panel
  shows the reason verbatim. **Never renders fake arcs.**
- **VLF/lightning:** intentionally not rendered here — no keyless feed;
  sibling lightning layer owns strike impulses.
- **MUF intuition:** `estimateMuf()` is clamped to 3–60 MHz, labelled
  `basis: 'intuition'` and "MODEL — not measurement" everywhere it surfaces.

## 5. Verification

```bash
cd ~/workspace/gods-eye-view
for f in src/layers/invisibleOcean/model.js src/layers/invisibleOcean/source.js \
         src/layers/invisibleOcean/index.js src/layers/invisibleOcean/panel.js \
         src/layers/invisibleOcean/about.js server/providers/invisibleOceanProxy.js; do
  node --check "$f" && echo "OK $f";
done
node --test src/layers/invisibleOcean/invisibleOcean.test.mjs
```

## 6. Known limits / follow-ups

- WSPRnet olddb is HTML scraping — brittle if they redesign the table; the
  proxy validates row shape and degrades per-provider, never all-or-nothing.
- PSK `flowStartSeconds` is reporter-clock epoch; the proxy bounds it to
  ±10 min of server time, else stamps arrival time.
- Day/night band visualization uses fixed day/night MUF intuitions (0.85 /
  0.15 dayFactor); a future pass could drive it from the terminator layer's
  subsolar point per arc midpoint.
