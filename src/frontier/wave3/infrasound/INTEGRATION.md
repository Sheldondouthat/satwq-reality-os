# INTEGRATION — Wave 3 Track 3b.8: Volcano infrasound (EarthScope FDSN, keyless)

**Status:** built 2026-09-27 · source VERIFIED live (6/6 AV BDF stations → real
miniSEED; decoder validated 72/72 records, RMS 0.99–9.2 Pa, peaks ≤ 41 Pa)
**Files (mine only):**
- `server/providers/wave3/miniseed.js` — dependency-free miniSEED decoder
  (Steim-1/2, big/little endian). No `node:fs`, no `node:path`, no WASM —
  Pages-safe plain fetch/JSON.
- `server/providers/wave3/miniseed.test.mjs` — 6 tests (real AU22 record-0
  fixture), all passing.
- `server/providers/wave3/infrasound.js` — `infrasoundProxy()` → `/api/infrasound`
  (station metadata → dataselect → decode → counts→Pa via SEED scale).
- `server/providers/wave3/infrasound.test.mjs` — 6 tests, all passing.
- `src/frontier/wave3/infrasound/model.js` — pure client helpers.
- `src/frontier/wave3/infrasound/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/infrasound/infrasound.test.mjs` — 4 tests, all passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { infrasoundProxy } from './wave3/infrasound.js';
```

`localProviderPlugins()` array (place near the other wave3 proxies, e.g. after `donkiProxy(),`):
```js
    infrasoundProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'infrasound',
    routes: ['/api/infrasound'],
    load: () => import('../providers/wave3/infrasound.js').then((m) => m.infrasoundProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initInfrasound } from './wave3/infrasound/index.js';
```

Inside `initFrontier`, after the donki attempt block:
```js
  // — W3 3b.8 volcano infrasound —
  attempt('infrasound', () => {
    const s = section(t('feature.infrasound'));
    dock.appendChild(s);
    return initInfrasound({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.infrasound',`
`BASE_STRINGS` += `'feature.infrasound': 'Volcano infrasound',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.infrasound': 'Volcano infrasound monitor'` |
| batcave | `'feature.infrasound': 'Volcano infrasound monitor'` |
| garage | `'feature.infrasound': 'Volcano infrasound'` |
| noir | `'feature.infrasound': 'Infrasound dossier'` |
| lcars | `'feature.infrasound': 'Infrasound scan'` |
| pipboy | `'feature.infrasound': 'Volcano infrasound'` |
| jarvis | `'feature.infrasound': 'Infrasound listen'` |
| nerv | `'feature.infrasound': 'Infrasound pattern'` |
| nightcity | `'feature.infrasound': 'Infrasound feed'` |
| apollo | `'feature.infrasound': 'Volcano infrasound monitor'` |
| weyland | `'feature.infrasound': 'Infrasound log'` |
| synthwave | `'feature.infrasound': 'Volcano infrasound'` |
| scp | `'feature.infrasound': 'Infrasound file'` |
| tron | `'feature.infrasound': 'Infrasound program'` |

## API contract

`GET /api/infrasound`
→ `{ generatedAt, stations:[...], honesty }`
- station: `{net, sta, lat, lon, volcanoHint, state, sampleRateHz, nSamples,
  rmsPa, peakPa, pressure, envelopePa[120], windowStartUtc, windowEndUtc}`
- `state`: `live` | `no_data` | `no_station` | `decode_error` | `error`.
  Upstream outages degrade softly to per-station error states (HTTP 200);
  unexpected failures → 503 `{error:'infrasound_unavailable'}`.
- `pressure`: `quiet|active|elevated|loud` — RMS thresholds, **labeled heuristic**.
- `volcanoHint`: **inferred** from AVO station prefixes (e.g. `AU…` → Augustine);
  null where the mapping is ambiguous. Coordinates are authoritative FDSN metadata.

## Physics-honesty note (shown in the dock legend)
> Measured pressure via EarthScope FDSN (BDF channels), counts→Pa via each
> channel's SEED scale factor. Volcano names are inferred from station prefixes.
> Audify = envelope audification model (loudness follows the measured 10-min
> envelope), not raw audio.

## Verification
- Live 2026-09-27: 6/6 stations `live`, 30 000 samples each (10 min @ 50 Hz),
  RMS 0.99–9.2 Pa, peaks ≤ 41 Pa — physically plausible infrasound.
- Decoder: 72/72 records of the captured AV.AU22 payload decode with
  decoded-count == header nsamp sum; inter-record continuity ≤ 0.76 Pa.
  Steim-2 table ported from EarthScope libmseed `msr_decode_steim2`
  (`unpackdata.c`): dnib = bits 31–30 of the data word, first-frame dummy
  diff skipped.
- Tests: `node --test server/providers/wave3/miniseed.test.mjs` → 6/6;
  `node --test server/providers/wave3/infrasound.test.mjs` → 6/6;
  `node --test src/frontier/wave3/infrasound/infrasound.test.mjs` → 4/4.
