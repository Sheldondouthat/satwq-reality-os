# INTEGRATION — Wave 5: SatNOGS (TLE + ground stations + transmitters)

**Status:** built 2026-09-27 · all inputs VERIFIED live
(TLE: ISS 25544 rows; stations: Hackerspace.gr 1 with UHF 400–460 MHz antenna;
transmitters: alive USB 136.6585 MHz rows)
**Files (mine only):**
- `server/providers/wave5/satnogs.js` — `satnogsProxy()` → `/api/satnogs`
- `server/providers/wave5/satnogs.test.mjs` — 12 tests, all passing
- `api/satnogs.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/satnogs/model.js` — pure client helpers (status colors, antenna labels)
- `src/frontier/wave5/satnogs/index.js` — `init({viewer, mount, chip, trackLayer, t})` ground-station markers
- `src/frontier/wave5/satnogs/satnogs.test.mjs` — 6 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block (after the radioReference import):
```js
import { satnogsProxy } from './wave5/satnogs.js';
```

`localProviderPlugins()` array, after `radioReferenceProxy(),`:
```js
    radioReferenceProxy(),
    satnogsProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `radio-reference` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'satnogs',
    routes: ['/api/satnogs'],
    load: () => import('../providers/wave5/satnogs.js').then((m) => m.satnogsProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block (after the radioRef import):
```js
import { init as initSatnogs } from './wave5/satnogs/index.js';
```

Inside `initFrontier`, after the `radio-ref` attempt block:
```js
  // — Wave 5: SatNOGS ground stations —
  attempt('satnogs', () => {
    const s = section(t('feature.satnogs'));
    dock.appendChild(s);
    return initSatnogs({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` (after `'feature.radioRef',`):
```js
  'feature.satnogs',
```
`BASE_STRINGS` (after `'feature.radioRef': 'Radio reference',`):
```js
  'feature.satnogs': 'Ground stations (SatNOGS)',
```

`src/themes/themes.js` — in each theme's `strings` block, after the
`'feature.radioRef'` line:
| theme | string |
|---|---|
| medbay | `'feature.satnogs': 'Ground-station watch'` |
| batcave | `'feature.satnogs': 'Ground-station watch'` |
| garage | `'feature.satnogs': 'Ground stations (SatNOGS)'` |
| noir | `'feature.satnogs': 'Station dossier'` |
| lcars | `'feature.satnogs': 'Ground-station scan'` |
| pipboy | `'feature.satnogs': 'Ground stations (SatNOGS)'` |
| jarvis | `'feature.satnogs': 'Ground-station track'` |
| nerv | `'feature.satnogs': 'Station pattern'` |
| nightcity | `'feature.satnogs': 'Station feed'` |
| apollo | `'feature.satnogs': 'Ground-station watch'` |
| weyland | `'feature.satnogs': 'Station log'` |
| synthwave | `'feature.satnogs': 'Ground stations'` |
| scp | `'feature.satnogs': 'Station file'` |
| tron | `'feature.satnogs': 'Ground-station program'` |

## API contract

`GET /api/satnogs?dataset=tle|stations|transmitters&limit=500` (limit 1–2000, default 500)
- `tle` → `{ generatedAt, dataset, count, limitedTo, rows:[{noradCatId, name,
  line1, line2, tleSource, updated}], source, honesty }`
  - **Not a duplicate of /api/celestrak:** SatNOGS DB is the community
    radio-operator TLE catalog; CelesTrak is general GP data.
- `stations` → `{ generatedAt, dataset, count, withAntennas, limitedTo,
  stations:[{id, name, lat, lng, qthLocator, observations, futureObservations,
  lastSeen, status, antennas:[{band, frequencyLowHz, frequencyHighHz,
  antennaTypeName}]}], source, honesty }`
  - `status` derived: `observed` (>0 observations) | `scheduled` (>0 future) | `idle`.
- `transmitters` → `{ generatedAt, dataset, count, limitedTo,
  transmitters:[{uuid, noradCatId, description, mode, service, status, alive,
  uplinkHz:{low,high}, downlinkHz:{low,high}, updated}], source, honesty }`
  - alive-only filter; `honesty`: community records — verify against the SatNOGS DB before transmitting.
- Unknown dataset → 400 `{error:'usage', usage:'GET /api/satnogs?dataset=tle|stations|transmitters'}`.

## Physics-honesty note (shown in the dock legend)
> Antenna ranges = station-declared capability, not live measurements; status from observation counts. Source: SatNOGS network.

## Verification
- Live 2026-09-27 ~15:40 EDT: `db.satnogs.org/api/tle/` → 200, ISS (ZARYA) norad 25544 rows;
  `network.satnogs.org/api/stations/?format=json` → 200, station 1 "Hackerspace.gr 1"
  38.01697/23.7314 with UHF 400–460 MHz cross-yagi antenna; `db.satnogs.org/api/transmitters/`
  → 200, alive USB 136.6585 MHz rows. **VERIFIED.**
- `Number(null)===0` class bug caught during build: null lat/lng/norad_cat_id/freq
  passed finiteness checks as 0 — fixed with a `numOrNull` helper (same class as the
  2026-09-27 shortwave lesson). Regression-tested (station with `lat: null` is now dropped).
- Tests: `node --test server/providers/wave5/satnogs.test.mjs` → 12/12;
  `node --test src/frontier/wave5/satnogs/satnogs.test.mjs` → 6/6.
- Redirect note: `redirect:'follow'` + final-host pinning per dataset
  (`db.satnogs.org`, `network.satnogs.org`); workerd rejects `redirect:'error'` —
  the 2026-09-27 edge incident.
