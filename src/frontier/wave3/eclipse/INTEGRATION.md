# INTEGRATION — Wave 3 Track 3b.5: eclipse geometry engine + 2045 US rehearsal

**Status:** built 2026-09-27 · geometry VALIDATED against NASA's published
greatest-eclipse circumstances (25.9°N 78.5°W, 255.6 km, 6m06s, 17:41:10 UT)
**Files (mine only):**
- `src/frontier/wave3/eclipse/model.js` — pure Besselian engine:
  `evalElements`, `subShadowPoint`, `umbralEllipse`, `shadowSpeedKms`,
  `sampleEclipse`, `tdtHoursToUtc`/`utcToTdtHours`, `subsolarPointAt`,
  `LIGHT_BANDS`, `ringAroundPoint`. No `node:` imports, no Cesium —
  importable by both provider and tests.
- `src/frontier/wave3/eclipse/eclipse.test.mjs` — 10 tests, all passing,
  including the NASA-anchor validation.
- `server/providers/wave3/eclipse.js` — `eclipseProxy()` →
  `/api/eclipse?event=2045[&stepMin=5]`. No upstream: pure computation from
  the embedded elements. Always serves (404 only for unknown event keys).
- `server/providers/wave3/eclipse.test.mjs` — 4 tests, all passing.
- `src/frontier/wave3/eclipse/index.js` — `init({viewer, mount, chip, trackLayer, t})`:
  centerline polyline, scrubber-driven umbral ellipse, golden/blue-hour ring
  bands (polygon with hole), 30-second US-passage rehearsal player.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { eclipseProxy } from './wave3/eclipse.js';
```

`localProviderPlugins()` array:
```js
    eclipseProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

```js
  {
    name: 'eclipse',
    routes: ['/api/eclipse'],
    load: () => import('../providers/wave3/eclipse.js').then((m) => m.eclipseProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initEclipse } from './wave3/eclipse/index.js';
```

Inside `initFrontier`, after the schumann attempt block:
```js
  // — W3 3b.5 Eclipse 2045 —
  attempt('eclipse', () => {
    const s = section(t('feature.eclipse'));
    dock.appendChild(s);
    return initEclipse({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.eclipse',`
`BASE_STRINGS` += `'feature.eclipse': 'Eclipse 2045',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.eclipse': 'Eclipse rehearsal'` |
| batcave | `'feature.eclipse': 'Eclipse rehearsal'` |
| garage | `'feature.eclipse': 'Eclipse 2045'` |
| noir | `'feature.eclipse': 'Eclipse dossier'` |
| lcars | `'feature.eclipse': 'Eclipse scan'` |
| pipboy | `'feature.eclipse': 'Eclipse 2045'` |
| jarvis | `'feature.eclipse': 'Shadow track'` |
| nerv | `'feature.eclipse': 'Eclipse pattern'` |
| nightcity | `'feature.eclipse': 'Eclipse feed'` |
| apollo | `'feature.eclipse': 'Eclipse rehearsal'` |
| weyland | `'feature.eclipse': 'Eclipse log'` |
| synthwave | `'feature.eclipse': 'Eclipse 2045'` |
| scp | `'feature.eclipse': 'Eclipse file'` |
| tron | `'feature.eclipse': 'Eclipse program'` |

## API contract

`GET /api/eclipse?event=2045&stepMin=5`
→ `{ name, saros, attribution, greatestEclipseUtc, published:{...},
    honesty, stepMin, sampleCount, samples:[{utc,lat,lon,widthKm,
    semiMajorKm,majorAxisBearingDeg,sunAltitudeDeg,durationSec,inUs}],
    usPassage:{firstUtc,lastUtc,landfall:{lat,lon}}, lightBands, windowTdt }`

## Data provenance (in-code citation)
Besselian elements reproduced from NASA GSFC / Fred Espenak,
"Besselian Elements - Total Solar Eclipse of 2045 August 12"
(Five Millennium Canon), retrieved 2026-09-27. Attribution string
"Eclipse Predictions by Fred Espenak, NASA's GSFC" is served in the API
and shown in the panel legend. No elements were invented — the engine was
validated against the published greatest-eclipse circumstances before use.

## Validation results (in tests)
| quantity | computed | NASA published |
|---|---|---|
| GE lat | 25.75° | 25.9°N |
| GE lon | 78.91°W | 78.5°W |
| path width (major) | 255.8 km | 255.6 km |
| sun altitude | 77.8° | 77.6° |
| central duration | 365 s | 366 s (6m06s) |
| GE time | 17:41:09.9Z | 17:41:10 UT |

US passage (computed): landfall 16:18Z near 40.2°N 121.8°W (N. California);
exit 17:58Z near 21.3°N 73.8°W (Bahamas). Consistent with the published
city list (Reno → Salt Lake City → … → Orlando/Miami).

## Verification
- `node --test src/frontier/wave3/eclipse/eclipse.test.mjs` → 10/10;
  `node --test server/providers/wave3/eclipse.test.mjs` → 4/4.
