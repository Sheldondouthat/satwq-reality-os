# INTEGRATION — Wave 5: radio-reference (Callook + AMSAT TLE + numbers-stations ref)

**Status:** built 2026-09-27 · all inputs VERIFIED live
(Callook W1AW → ARRL HQ, 41.714707/-72.728411; AMSAT nasa.all → TLE blocks with
text preamble; numbers-stations WP search UVB-76 → article hits)
**Files (mine only):**
- `server/providers/wave5/radioReference.js` — `radioReferenceProxy()` → `/api/radio-reference`
- `server/providers/wave5/radioReference.test.mjs` — 12 tests, all passing
- `api/radio-reference.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/radioRef/model.js` — pure client helpers (band class, honesty labels)
- `src/frontier/wave5/radioRef/index.js` — `init({viewer, mount, chip, trackLayer, t})` dock panel
- `src/frontier/wave5/radioRef/radioRef.test.mjs` — 6 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block (after the pota import):
```js
import { radioReferenceProxy } from './wave5/radioReference.js';
```

`localProviderPlugins()` array, after `potaProxy(),`:
```js
    potaProxy(),
    radioReferenceProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `pota` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'radio-reference',
    routes: ['/api/radio-reference'],
    load: () => import('../providers/wave5/radioReference.js').then((m) => m.radioReferenceProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block (after the pota import):
```js
import { init as initRadioRef } from './wave5/radioRef/index.js';
```

Inside `initFrontier`, after the `pota` attempt block:
```js
  // — Wave 5: radio reference (dock lookups) —
  attempt('radio-ref', () => {
    const s = section(t('feature.radioRef'));
    dock.appendChild(s);
    return initRadioRef({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` (after `'feature.pota',`):
```js
  'feature.radioRef',
```
`BASE_STRINGS` (after `'feature.pota': "Who's on the air (POTA)",`):
```js
  'feature.radioRef': 'Radio reference',
```

`src/themes/themes.js` — in each theme's `strings` block, after the
`'feature.pota'` line:
| theme | string |
|---|---|
| medbay | `'feature.radioRef': 'License lookup'` |
| batcave | `'feature.radioRef': 'License lookup'` |
| garage | `'feature.radioRef': 'Radio reference'` |
| noir | `'feature.radioRef': 'Signal dossier'` |
| lcars | `'feature.radioRef': 'Reference scan'` |
| pipboy | `'feature.radioRef': 'Radio reference'` |
| jarvis | `'feature.radioRef': 'Callbook'` |
| nerv | `'feature.radioRef': 'Signal records'` |
| nightcity | `'feature.radioRef': 'Radio directory'` |
| apollo | `'feature.radioRef': 'License lookup'` |
| weyland | `'feature.radioRef': 'Signal log'` |
| synthwave | `'feature.radioRef': 'Radio reference'` |
| scp | `'feature.radioRef': 'Reference file'` |
| tron | `'feature.radioRef': 'Directory program'` |

## API contract

`GET /api/radio-reference?call=W1AW` → `{ generatedAt, callsign, name, type,
licenseClass, trustee, address, lat, lon, gridsquare, expires, source, honesty }`
- 404 `{error:'callsign_not_found'}` when Callook returns non-VALID status.
- 400 `{error:'invalid_callsign'}` for malformed callsigns.

`GET /api/radio-reference?tle=1` → `{ generatedAt, count, rows:[{name, line1, line2,
noradId}], source, honesty }`
- Parses AMSAT's `nasa.all` (skips the human-readable preamble, pairs `0 NAME`/`1 `/`2 ` triples).
- **Not a duplicate of /api/celestrak:** AMSAT publishes amateur-radio sats with a
  contact point the CelesTrak groups don't always carry — this is the complement lane.

`GET /api/radio-reference?search=UVB-76` → `{ generatedAt, query, count,
results:[{id, title, url, type, subtype}], source, honesty }`
- **Honestly labeled:** numbers-stations.com is a WordPress reference article DB —
  NOT live telemetry. There is no public live API for numbers stations.

No query param → 400 `{error:'usage', usage:...}`.

## Honesty notes (shown in the dock)
- Callsign: "FCC license record via Callook — a lookup, not live telemetry."
- TLE: "AMSAT element sets; positions are computed, not measured. Complements the CelesTrak layer."
- Numbers: "Reference article database — NOT live telemetry."

## Verification
- Live 2026-09-27 ~15:40 EDT: `callook.info/W1AW/json` → VALID, ARRL HQ OPERATORS CLUB,
  41.714707/-72.728411 FN31pr; `amsat.org/tle/current/nasa.all` → 200 with `0 ISS (ZARYA)`
  3LE blocks after a ~15-line text preamble (parser skips it); numbers-stations WP
  search → article hits with titles/urls. **VERIFIED.**
- Tests: `node --test server/providers/wave5/radioReference.test.mjs` → 12/12;
  `node --test src/frontier/wave5/radioRef/radioRef.test.mjs` → 6/6.
- Redirect note: `redirect:'follow'` + final-host pinning per dataset
  (`callook.info`, `www.amsat.org`, `www.numbers-stations.com`);
  workerd rejects `redirect:'error'` — the 2026-09-27 edge incident.
