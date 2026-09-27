# Wave 3 Track 2c / 2.13 — GDELT planetary attention bubbles — Integration Guide

Queries the GDELT GKG GeoJSON v1 endpoint and clusters geolocated news
mentions into "attention bubbles": size = mention count, color = average
article tone (green positive → gold neutral → red negative). Bounded
per-query server cache; the globe polls every 5 minutes.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/gdelt.js` | `export function gdeltProxy({fetchImpl, now})` — mounts `/api/gdelt`; per-query bounded cache (max 8 keys). Workerd-safe. Exports `normalizeGdeltFeature`, `parseGdeltGeojson`. |
| `src/frontier/wave3/gdelt/model.js` | `clusterMentions` (2° grid clustering, tone averaging, URL/name dedup), `bubbleSize`, `toneColorCss`. |
| `src/frontier/wave3/gdelt/source.js` | `createGdeltSource({fetchImpl, apiPath})` — browser snapshot client (`getSnapshot({q, timespan})`). |
| `src/frontier/wave3/gdelt/index.js` | `init({viewer, apiPath, q, timespan})` — fail-soft Cesium mount; bubbles + click-through article links, 5-min refresh. |
| `src/frontier/wave3/gdelt/gdelt.test.mjs` | 8 tests: real v1 feature, bad-geometry rejection, **http(s)-only URL guard**, clustering/tone averaging, source shape validation. |

## 2. Probe outcomes (verified 2026-09-27)

| Fact | Detail |
|---|---|
| Endpoint | `https://api.gdeltproject.org/api/v1/gkg_geojson` → 200 GeoJSON |
| Parameter case | **lowercase** `query=earthquake&timespan=60` returns features; UPPERCASE `QUERY`/`TIMESPAN` returns an empty FeatureCollection — provider uses lowercase only |
| Sample | Real Madrid feature (`-3.6833, 40.4000`, tone −4.37) parsed end-to-end |
| Security | Article URLs rendered as `<a href>` are scheme-restricted to `http(s)` at the provider; all upstream strings are `escapeHtml`'d at render |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the feodo import:

```js
import { feodoProxy } from './wave3/feodo.js';
import { gdeltProxy } from './wave3/gdelt.js';   // ADD
```

and in `localProviderPlugins()`, after `feodoProxy(),`:

```js
    feodoProxy(),
    gdeltProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `feodo` entry:

```js
  {   // ADD
    name: 'gdelt',
    routes: ['/api/gdelt'],
    load: () => import('../providers/wave3/gdelt.js').then((m) => m.gdeltProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Gdelt } from './wave3/gdelt/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.13: GDELT planetary attention bubbles —
  attempt('wave3-gdelt', () => {
    const handle = initWave3Gdelt({ viewer, q: 'earthquake', timespan: 60 });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.feodo',`):

```js
  'feature.gdelt',
```

and in `BASE_STRINGS` (after `'feature.feodo.offline': 'Historical / offline listings',`):

```js
  'feature.gdelt': 'Planetary attention (GDELT)',
  'feature.gdelt.positive': 'Positive tone',
  'feature.gdelt.neutral': 'Neutral tone',
  'feature.gdelt.negative': 'Negative tone',
```

## 4. Consumer contract

`GET /api/gdelt?q=earthquake&timespan=60` → 200 (`timespan` 1–1440 min, default 60; `q` ≤ 120 chars)

```json
{
  "fetchedAt": 1758940000000, "stale": false, "unavailable": false, "reason": null,
  "q": "earthquake", "timespan": 60, "count": 2,
  "mentions": [{
    "lon": -3.683, "lat": 40.4, "name": "Madrid, Madrid, Spain",
    "tone": -4.37, "url": "https://www.mediafax.ro/stirile-zilei/protest-23814818",
    "themes": ";SECURITY_SERVICES;TAX_FNCACT_POLICE;", "publishedAt": "2026-09-27T05:00:00Z"
  }]
}
```

- `url` is null unless it starts with `http://`/`https://` (XSS guard).
- Upstream down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 5 min per (q, timespan) key; max 8 cached queries; body cap
  8 MB; timeout 25 s; max 400 features per response.
- Bubbles are clustered client-side on a 2° grid; tone is a mean of article
  tones, not a sentiment judgment.
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.
