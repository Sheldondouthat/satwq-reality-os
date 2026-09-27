# INTEGRATION — Wave 3 Track 3b.4: Cumiana Schumann-resonance panel

**Status:** built 2026-09-27 · provider + tests verified live
(livedata.html parsed: evlf + plotted charts; last_E-VLF.jpg proxied live →
200, image/jpeg, 254,581 bytes)
**Files (mine only):**
- `server/providers/wave3/schumann.js` — `schumannProxy()` →
  `/api/schumann` (document) + `/api/schumann/image?kind=evlf|plotted`
  (same-origin JPEG proxy; the station is HTTP-only so direct HTTPS
  embedding would be mixed-content). Strict kind allowlist, no SSRF.
- `server/providers/wave3/schumann.test.mjs` — 5 tests, all passing.
- `src/frontier/wave3/schumann/model.js` — escapeHtml.
- `src/frontier/wave3/schumann/index.js` — `init({viewer, mount, chip, trackLayer, t})`.
- `src/frontier/wave3/schumann/schumann.test.mjs` — 1 test, passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { schumannProxy } from './wave3/schumann.js';
```

`localProviderPlugins()` array:
```js
    schumannProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

```js
  {
    name: 'schumann',
    routes: ['/api/schumann', '/api/schumann/image'],
    load: () => import('../providers/wave3/schumann.js').then((m) => m.schumannProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initSchumann } from './wave3/schumann/index.js';
```

Inside `initFrontier`, after the sargassum attempt block:
```js
  // — W3 3b.4 Schumann —
  attempt('schumann', () => {
    const s = section(t('feature.schumann'));
    dock.appendChild(s);
    return initSchumann({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.schumann',`
`BASE_STRINGS` += `'feature.schumann': 'Schumann resonance',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.schumann': 'Cavity monitor'` |
| batcave | `'feature.schumann': 'Cavity monitor'` |
| garage | `'feature.schumann': 'Schumann resonance'` |
| noir | `'feature.schumann': 'Cavity dossier'` |
| lcars | `'feature.schumann': 'Resonance scan'` |
| pipboy | `'feature.schumann': 'Schumann resonance'` |
| jarvis | `'feature.schumann': 'Cavity field'` |
| nerv | `'feature.schumann': 'Resonance pattern'` |
| nightcity | `'feature.schumann': 'Resonance feed'` |
| apollo | `'feature.schumann': 'Cavity monitor'` |
| weyland | `'feature.schumann': 'Resonance log'` |
| synthwave | `'feature.schumann': 'Schumann resonance'` |
| scp | `'feature.schumann': 'Resonance file'` |
| tron | `'feature.schumann': 'Resonance program'` |

## API contract

`GET /api/schumann`
→ `{ charts:[{kind,title,cadenceNote,directUrl,proxiedUrl}], honesty, attribution, stale }`
- `GET /api/schumann/image?kind=evlf|plotted` → JPEG. Unknown kind → 400.

## Honesty architecture
- The provider performs NO pixel analysis; the honesty note states the charts
  are images, not numerical 7.83 Hz telemetry.
- The panel's play button starts a SYMBOLIC Web Audio tone (7.83/14.3/20.8 Hz
  sines, gesture-gated) explicitly labeled representational — it does not use
  the shared sonification bus (which supports only quake/lightning/ISS
  methods) and does not claim to reproduce the station signal.

## Verification
- Live 2026-09-27: page parsed, both charts found, E-VLF JPEG proxied →
  200, image/jpeg, 254,581 bytes (matches the 254,424-byte direct fetch
  within live-chart drift).
- Tests: `node --test server/providers/wave3/schumann.test.mjs` → 5/5;
  `node --test src/frontier/wave3/schumann/schumann.test.mjs` → 1/1.
