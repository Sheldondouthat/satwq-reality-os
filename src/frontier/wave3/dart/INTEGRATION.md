# INTEGRATION.md — 1.9 DART tsunami coupling (`wave3/dart`)

Feature dir: `src/frontier/wave3/dart/` · Provider: `server/providers/wave3/dart.js`
Tests: `src/frontier/wave3/dart/dart.test.mjs` (6) + `server/providers/wave3/dart.test.mjs` (19) — all passing.
Live verifications (2026-09-27): NDBC `.dart` format on station 46404
(`YYYY MM DD hh mm ss T HEIGHT_m`, T=1 valid); NWS `api.weather.gov/alerts/active?event=Tsunami%20Warning`
returns live keyless JSON.

## 1. Exact lines for `server/providers/local.js`

Add to the import block (after the vaac import line):

```js
import { dartCouplingProxy } from './wave3/dart.js';
```

Add to the `localProviderPlugins()` array (after `vaacProxy(),`):

```js
    dartCouplingProxy(),
```

Route served: `GET /api/dart-coupling` — qualifying M6.5+ subduction quakes
with nearest live DART buoys + NWS tsunami alerts. Zero keys; no WASM/node:fs.

## 2. Exact lines for `server/pages/registry.mjs`

Append to the `REGISTRY` array (after the vaac entry):

```js
  {
    name: 'dart-coupling',
    routes: ['/api/dart-coupling'],
    load: () => import('../providers/wave3/dart.js').then((m) => m.dartCouplingProxy()),
  },
```

No exclusion: the module is plain fetch + text/JSON parsing (esbuild-safe).

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js`:

```js
import { initDartLayer } from './wave3/dart/index.js';
```

Add a mount attempt (after the invisible-ocean block, before forecast):

```js
  // — Wave 3 · 1.9 DART tsunami coupling —
  attempt('dart-coupling', () => {
    const s = section(t('feature.dartCoupling'));
    const handle = initDartLayer({
      viewer,
      mount: (node) => s.appendChild(node),
    });
    dock.appendChild(s);
    return () => handle.destroy();
  });
```

## 4. New UI strings for theme dictionaries

Canonical (English) values; add `feature.dartCoupling` to every theme
manifest per `src/themes/KEYS.md` (the `t()` lookup falls back to the
canonical default when a theme lacks the key, so the feature works
untranslated until manifests are updated):

```js
'feature.dartCoupling': 'DART tsunami coupling',
```

## Honesty notes for the UI copy

- Buoy coordinates in `DART_REGISTRY` are APPROXIMATE (coupling-distance
  math only); NDBC is authoritative.
- The coupling rule is a geometric heuristic (M6.5+, depth ≤100 km, inside
  a subduction-zone box, nearest buoys ≤3500 km) — NOT a tsunami forecast.
- Buoys in the Indian Ocean are not yet in the registry (coordinates for
  the Indonesian DARTs were not verifiable 2026-09-27) — documented gap.
