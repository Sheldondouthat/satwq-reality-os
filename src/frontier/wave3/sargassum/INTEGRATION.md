# INTEGRATION — Wave 3 Track 3b.3: NOAA AOML Sargassum watch

**Status:** built 2026-09-27 · provider + tests verified live
(SIR page parsed: analysis 20260925, all 5 regions; GOMF.png proxied live —
valid PNG, 638,545 bytes)
**Files (mine only):**
- `server/providers/wave3/sargassum.js` — `sargassumProxy()` →
  `/api/sargassum` (document) + `/api/sargassum/image` (same-origin PNG
  proxy with strict date/region allowlist). No `node:` imports beyond the
  Buffer precedent in cctv.js; no WASM; fail-soft 503.
- `server/providers/wave3/sargassum.test.mjs` — 8 tests, all passing.
- `src/frontier/wave3/sargassum/model.js` — date formatting helpers.
- `src/frontier/wave3/sargassum/index.js` — `init({viewer, mount, chip, trackLayer, t})`.
- `src/frontier/wave3/sargassum/sargassum.test.mjs` — 2 tests, all passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { sargassumProxy } from './wave3/sargassum.js';
```

`localProviderPlugins()` array:
```js
    sargassumProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

```js
  {
    name: 'sargassum',
    routes: ['/api/sargassum', '/api/sargassum/image'],
    load: () => import('../providers/wave3/sargassum.js').then((m) => m.sargassumProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initSargassum } from './wave3/sargassum/index.js';
```

Inside `initFrontier`, after the tess attempt block:
```js
  // — W3 3b.3 Sargassum —
  attempt('sargassum', () => {
    const s = section(t('feature.sargassum'));
    dock.appendChild(s);
    return initSargassum({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.sargassum',`
`BASE_STRINGS` += `'feature.sargassum': 'Sargassum watch',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.sargassum': 'Sargassum watch'` |
| batcave | `'feature.sargassum': 'Sargassum watch'` |
| garage | `'feature.sargassum': 'Sargassum watch'` |
| noir | `'feature.sargassum': 'Sargassum dossier'` |
| lcars | `'feature.sargassum': 'Sargassum scan'` |
| pipboy | `'feature.sargassum': 'Sargassum watch'` |
| jarvis | `'feature.sargassum': 'Algae drift'` |
| nerv | `'feature.sargassum': 'Sargassum pattern'` |
| nightcity | `'feature.sargassum': 'Sargassum feed'` |
| apollo | `'feature.sargassum': 'Sargassum watch'` |
| weyland | `'feature.sargassum': 'Sargassum log'` |
| synthwave | `'feature.sargassum': 'Sargassum watch'` |
| scp | `'feature.sargassum': 'Sargassum file'` |
| tron | `'feature.sargassum': 'Sargassum program'` |

## API contract

`GET /api/sargassum`
→ `{ analysisDate, fetchedAt, stale, regions:[{code,name,imageUrl,barUrl,
    proxiedImageUrl,proxiedBarUrl}], kmzUrl, pdfUrl, honesty, attribution }`
- Regions (page order, alt-text names observed): GOMF (Gulf of America), CA
  (Central America), GREATER, LESSER, SA (South America).
- `GET /api/sargassum/image?date=YYYYMMDD&region=CODE[&kind=bar]` → PNG.
  Non-allowlisted params → 400 (SSRF guard).

## Why an image scraper (documented design decision)
Probed 2026-09-27: no public WMS/GeoJSON/KML (all 404); the KMZ is a ZIP
the Pages provider graph cannot inflate. The provider therefore returns the
official regional PNG renderings and proxies them same-origin. It performs
no pixel analysis — the honesty note says so in both the API and the panel.

## Verification
- Live 2026-09-27: page parsed, analysis 20260925, 5/5 regions,
  GOMF.png proxied → 200, image/png, valid PNG magic, 638,545 bytes.
- Tests: `node --test server/providers/wave3/sargassum.test.mjs` → 8/8;
  `node --test src/frontier/wave3/sargassum/sargassum.test.mjs` → 2/2.
