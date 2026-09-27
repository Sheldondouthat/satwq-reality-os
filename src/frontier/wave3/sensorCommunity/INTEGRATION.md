# INTEGRATION — Wave 3 Track 2a.3: Sensor.Community air quality

**Status:** built 2026-09-27 · source VERIFIED live (HTTP 200, 211 sensors Ghent, 2026-09-27 readings)
**Files (mine only):**
- `server/providers/wave3/sensorCommunity.js` — `sensorCommunityProxy()` factory → `/api/air-quality`
- `src/frontier/wave3/sensorCommunity/model.js` — pure client model (AQI colors, haze radii)
- `src/frontier/wave3/sensorCommunity/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/sensorCommunity/sensorCommunity.test.mjs` — 13 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { sensorCommunityProxy } from './wave3/sensorCommunity.js';
```

`localProviderPlugins()` array, after `nwpsProxy(),`:
```js
    nwpsProxy(),
    sensorCommunityProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `nwps` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'sensor-community',
    routes: ['/api/air-quality'],
    load: () => import('../providers/wave3/sensorCommunity.js').then((m) => m.sensorCommunityProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initAirQuality } from './wave3/sensorCommunity/index.js';
```

Inside `initFrontier`, after the nwps attempt block:
```js
  // — W3 2.3 citizen air-quality haze —
  attempt('air-quality', () => {
    const s = section(t('feature.airQuality'));
    dock.appendChild(s);
    return initAirQuality({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.airQuality',`
`BASE_STRINGS` += `'feature.airQuality': 'Air-quality haze (citizen sensors)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.airQuality': 'Air-quality haze'` |
| batcave | `'feature.airQuality': 'Air-quality haze'` |
| garage | `'feature.airQuality': 'Air-quality haze'` |
| noir | `'feature.airQuality': 'Air-quality haze'` |
| lcars | `'feature.airQuality': 'Atmospheric particulates'` |
| pipboy | `'feature.airQuality': 'Air quality'` |
| jarvis | `'feature.airQuality': 'Air-quality analysis'` |
| nerv | `'feature.airQuality': 'Air-quality haze'` |
| nightcity | `'feature.airQuality': 'Air-quality haze'` |
| apollo | `'feature.airQuality': 'Air-quality haze'` |
| weyland | `'feature.airQuality': 'Atmospheric quality'` |
| synthwave | `'feature.airQuality': 'Air-quality haze'` |
| scp | `'feature.airQuality': 'Air-quality survey'` |
| tron | `'feature.airQuality': 'Air-quality haze'` |

## API contract

`GET /api/air-quality?lat=51.05&lon=3.72&r=10` (r in km, 0.5–50)
→ `{ schemaVersion:1, area, summary:{count,withPm25,avgPm25,maxPm25,worstAqi},
    sensors:[{id,lat,lon,pm25,pm10,aqi,timeMs}], aqiModel, fetchedAt, stale, ... }`
- `aqi`: 1–6 from US EPA PM2.5 breakpoints — an **estimate**, labeled in
  `aqiModel` and the client legend. Indoor sensors excluded (skew the field).
- Upstream truncates wide-area responses at ~96 KB mid-JSON (OBSERVED); the
  provider detects this and returns **502 `{error:'air_upstream_truncated',
  hint:'reduce r'}`** instead of corrupt data.

## Physics-honesty note (shown in the dock legend)
> Citizen sensors (Sensor.Community). Categories = US EPA PM2.5 breakpoints, estimate only.

## Verification
- Live: `data.sensor.community/airrohr/v1/filter/area=51.05,3.73,25` → HTTP 200,
  live 2026-09-27 05:53 UTC readings, value types P1 (PM10) / P2 (PM2.5) confirmed. **VERIFIED.**
- Tests: `node --test src/frontier/wave3/sensorCommunity/sensorCommunity.test.mjs` → 14/14 pass.
