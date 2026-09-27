# INTEGRATION — Wave 3 Track 2a.4: NOAA SWPC space weather

**Status:** built 2026-09-27 · source VERIFIED live (Kp 1-min + alerts, current 2026-09-27 data)
**Files (mine only):**
- `server/providers/wave3/swpc.js` — `swpcProxy()` factory → `/api/space-weather`
- `src/frontier/wave3/swpc/model.js` — pure client model (Kp colors, glow geometry)
- `src/frontier/wave3/swpc/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/swpc/swpc.test.mjs` — 10 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { swpcProxy } from './wave3/swpc.js';
```

`localProviderPlugins()` array, after `sensorCommunityProxy(),`:
```js
    sensorCommunityProxy(),
    swpcProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `sensor-community` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'swpc',
    routes: ['/api/space-weather'],
    load: () => import('../providers/wave3/swpc.js').then((m) => m.swpcProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initSpaceWeather } from './wave3/swpc/index.js';
```

Inside `initFrontier`, after the air-quality attempt block:
```js
  // — W3 2.4 SWPC magnetosphere glow —
  attempt('space-weather', () => {
    const s = section(t('feature.spaceWeather'));
    dock.appendChild(s);
    return initSpaceWeather({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.spaceWeather',`
`BASE_STRINGS` += `'feature.spaceWeather': 'Space weather (Kp)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.spaceWeather': 'Magnetosphere vitals'` |
| batcave | `'feature.spaceWeather': 'Magnetosphere status'` |
| garage | `'feature.spaceWeather': 'Space weather'` |
| noir | `'feature.spaceWeather': 'Magnetosphere file'` |
| lcars | `'feature.spaceWeather': 'Magnetosphere status'` |
| pipboy | `'feature.spaceWeather': 'Space weather'` |
| jarvis | `'feature.spaceWeather': 'Magnetosphere monitor'` |
| nerv | `'feature.spaceWeather': 'Magnetosphere alert'` |
| nightcity | `'feature.spaceWeather': 'Magnetosphere static'` |
| apollo | `'feature.spaceWeather': 'Magnetosphere monitor'` |
| weyland | `'feature.spaceWeather': 'Magnetosphere survey'` |
| synthwave | `'feature.spaceWeather': 'Space weather'` |
| scp | `'feature.spaceWeather': 'Magnetosphere anomaly'` |
| tron | `'feature.spaceWeather': 'Magnetosphere grid'` |

## API contract

`GET /api/space-weather`
→ `{ schemaVersion:1, kp, estimatedKp, timeTagMs, gScale, alerts:[{productId,code,issueMs,headline}], fetchedAt, stale, ... }`
- `gScale`: NOAA G0–G5 from Kp. `alerts`: last 48 h, newest first, boilerplate
  header lines skipped so the ticker shows the real headline.
- Alerts feed is best-effort: if it fails, Kp still serves with `alerts: []`.

## Physics-honesty note (shown in the dock legend)
> Shell is a Kp-driven visualization — not a measured magnetosphere. Source: NOAA SWPC.

## Verification
- Live: `services.swpc.noaa.gov/json/planetary_k_index_1m.json` → HTTP 200, Kp 3 at
  2026-09-27T05:48Z; `/products/alerts.json` → HTTP 200, live ALTEF3 alert. **VERIFIED.**
- Tests: `node --test src/frontier/wave3/swpc/swpc.test.mjs` → 12/12 pass.
