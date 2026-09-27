# INTEGRATION — Wave 3 Track 3b.2: TESS exoplanet transit alerts

**Status:** built 2026-09-27 · provider + tests verified live
(NASA Exoplanet Archive TAP returned real TOIs; 5 transits within the hour
observed, e.g. TOI 1080.01 P=3.97d at 06:38Z)
**Files (mine only):**
- `server/providers/wave3/tess.js` — `tessProxy()` → `/api/transits?days&limit`.
  Keyless TAP POST with correct `toi` columns (`ra`, `dec` — the initial
  `st_ra`/`st_dec` attempt failed with ORA-00904 and is regression-tested).
  12 h cache, 25 s timeout, 503-with-stale-cache, 503 when empty.
- `server/providers/wave3/tess.test.mjs` — 14 tests, all passing.
- `src/frontier/wave3/tess/model.js` — countdown/disposition/format helpers.
- `src/frontier/wave3/tess/index.js` — `init({viewer, mount, chip, trackLayer, t})`.
- `src/frontier/wave3/tess/tess.test.mjs` — 3 tests, all passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { tessProxy } from './wave3/tess.js';
```

`localProviderPlugins()` array:
```js
    tessProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

```js
  {
    name: 'tess-transits',
    routes: ['/api/transits'],
    load: () => import('../providers/wave3/tess.js').then((m) => m.tessProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initTess } from './wave3/tess/index.js';
```

Inside `initFrontier`, after the shortwave attempt block:
```js
  // — W3 3b.2 TESS transits —
  attempt('tess', () => {
    const s = section(t('feature.tess'));
    dock.appendChild(s);
    return initTess({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.tess',`
`BASE_STRINGS` += `'feature.tess': 'Exoplanet transits',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.tess': 'Transit watch'` |
| batcave | `'feature.tess': 'Transit watch'` |
| garage | `'feature.tess': 'Exoplanet transits'` |
| noir | `'feature.tess': 'Transit dossier'` |
| lcars | `'feature.tess': 'Exoplanet scan'` |
| pipboy | `'feature.tess': 'Exoplanet transits'` |
| jarvis | `'feature.tess': 'Transit events'` |
| nerv | `'feature.tess': 'Transit pattern'` |
| nightcity | `'feature.tess': 'Transit feed'` |
| apollo | `'feature.tess': 'Transit watch'` |
| weyland | `'feature.tess': 'Transit log'` |
| synthwave | `'feature.tess': 'Exoplanet transits'` |
| scp | `'feature.tess': 'Transit file'` |
| tron | `'feature.tess': 'Transit program'` |

## API contract

`GET /api/transits?days=14&limit=25`
→ `{ generatedAt, windowDays, count, transits, honesty }`
- transit: `{ toi, tid, raDeg, decDeg, tmag, disposition, periodDays,
  epochBjd, durationH, radiusRe, nextTransitBjd, nextTransitUtc,
  hoursUntil, tonight }`
- Sorted soonest-first; `hoursUntil` computed at request time.
- `honesty`: "Transit times are Kepler predictions (epoch + n·period) …
  pl_tranmid is BJD_TDB; conversion to UTC ignores light-travel/TT−UTC
  offsets, so predicted times are approximate to a few minutes. Candidate
  dispositions (PC/CP) are not confirmed planets."

## Verification
- Live 2026-09-27: TAP POST returned 500 TOIs in 1.4 s; first 5 transits
  (TOI 1080.01/1009.01/1264.01/1685.01/2149.01) all within the hour.
- Tests: `node --test server/providers/wave3/tess.test.mjs` → 14/14;
  `node --test src/frontier/wave3/tess/tess.test.mjs` → 3/3.
