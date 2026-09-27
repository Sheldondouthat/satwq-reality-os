# INTEGRATION — Wave 3 Track 2a.4: NOAA SWPC space weather

**Status:** built 2026-09-27 · source VERIFIED live (Kp 1-min + alerts, current 2026-09-27 data)
**Extended:** 2026-09-27 — Wave A ticker (#1, #2, #4–#6, #13–#14, #16); schemaVersion 2
**Files (mine only):**
- `server/providers/wave3/swpc.js` — `swpcProxy()` factory → `/api/space-weather`
- `server/providers/wave3/swpc.test.mjs` — 16 tests, all passing
- `src/frontier/wave3/swpc/model.js` — pure client model (Kp colors, glow geometry)
- `src/frontier/wave3/swpc/index.js` — `init({viewer, mount, chip, trackLayer, t})` + dock ticker line
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
→ `{ schemaVersion:2, generatedAt, kp, estimatedKp, timeTagMs, gScale, alerts:[{productId,code,issueMs,headline}], fetchedAt, stale, ... }`
- `gScale`: NOAA G0–G5 from Kp. `alerts`: last 48 h, newest first, boilerplate
  header lines skipped so the ticker shows the real headline.
- Alerts feed is best-effort: if it fails, Kp still serves with `alerts: []`.

Wave A ticker blocks (null = that feed was unreachable; the core Kp feed is
still REQUIRED — if it fails with no cache the route returns
`{unavailable: true}`):
- `solarWind: {speed, bt, bz, timeTagMs}` — #1 proton speed + #2 B-field (GSM Bz)
- `kpThreeHour: [{timeTagMs, kp}]` — last 24 h of 3-hourly Kp (#4)
- `kpForecast: [{timeTagMs, kp, noaaScale}]` — predicted entries only, ~3 days (#4)
- `scales: {r:{scale,text}, s:{...}, g:{...}, outlook:{rMinorProb, rMajorProb, sProb}}` — NOAA R/S/G (#5)
- `xray: {flux, class, timeTagMs}` — GOES primary long-wave flux + letter class, e.g. `B4.4` (#6)
- `hamqsl: {sfi, aIndex, kIndex, updated}` — hamqsl.com solar ticker, credit N0NBH (#13)
- `wwv: {issued, text}` — SWPC Geophysical Alert Message, trimmed to 1600 chars (#14)
- `gfz: {kp, ap, timeTagMs}` — GFZ Kp nowcast, latest non-sentinel 3-hour block (#16)

Deferred to Wave B item 44 (NOT fetched): GOES protons/electrons (#7, #8),
GOES magnetometers (#9), geoelectric maps (#11), Ovation (#12), SILSO (#15).

## Physics-honesty note (shown in the dock legend)
> Shell is a Kp-driven visualization — not a measured magnetosphere. Source: NOAA SWPC.

## Verification
- Live: `services.swpc.noaa.gov/json/planetary_k_index_1m.json` → HTTP 200, Kp 3 at
  2026-09-27T05:48Z; `/products/alerts.json` → HTTP 200, live ALTEF3 alert. **VERIFIED.**
- Tests: `node --test src/frontier/wave3/swpc/swpc.test.mjs` → 12/12 pass.
