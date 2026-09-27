# F4 — Lightning "nervous system" layer · INTEGRATION.md

Ships as **new files only** under `src/layers/lightning/`. Nothing existing was edited.

## Files

| File | Role |
|---|---|
| `model.js` | Cesium-free pure model: seeded RNG, night-side test (`subsolarPoint` from `../terminator/model.js`), flash decay envelope, warm-pixel convective heuristic, tile↔lon/lat math, weighted strike sampler, analyst-record mapping |
| `source.js` | Two `{ getStrikes() }` implementations: `createRadarModeledLightningSource` (default) + `createBlitzortungSource` (documented inert stub) |
| `index.js` | `createLightningLayer({ source, overlayHost, now, onFlash })` — init/enable/disable/update/destroy lifecycle matching aurora/meteors |
| `model.test.mjs`, `source.test.mjs` | 20 tests, no browser/Cesium needed |

## What it does

- On `update()` / a 900 ms spawn timer, pulls strike impulses from `source.getStrikes()`.
- **Night-side only**: strikes ignite only where `isNightSide(lat, lon, date)` — more than 95° from the subsolar point — so flashes read against dark terrain.
- Each strike becomes a Cesium point entity that flashes white→blue-violet and decays over `STRIKE_TTL_MS` (4200 ms); a 250 ms decay timer fades alpha and retires dead entities. Cap: `MAX_ACTIVE_STRIKES` (240).
- `onFlash({lat, lon, intensity})` callback fires per ignition — wire it to sonification (F8).
- HUD name: **"Lightning (modeled)"**, source label **"Modeled from RainViewer radar"**. Every strike, analyst record, and stat carries `modeled: true` — never presented as a detection.

## The modeled source (default)

Pipeline: RainViewer radar snapshot (`getSnapshot` → `{template, frameTimeMs}`) → fetch 16 coarse tiles at z=3 over radar-rich regions (`DEFAULT_RADAR_TILES`) → decode via `createImageBitmap` + canvas → scan each tile's 4×4 cells for warm-color pixels (orange/red/magenta = high-dBZ bins; `isConvectivePixel`) → cache cells per radar frame (repeat `getStrikes()` calls are pure re-samples, no network) → `sampleStrikes()` picks intensity-weighted cells and jitters strikes.

- Optional `getCycloneCenters({signal})` hook adds eyewall cells around active cyclone centers (best-effort; failure degrades to radar cells).
- Failure modes degrade honestly: radar down → `getStrikes()` rejects (layer logs, keeps old flashes decaying); all tiles 404 → rejects; transparent tiles → empty cell list → no strikes (honest empty state).

## The Blitzortung stub

`createBlitzortungSource()` is **inert**: `getStrikes()` throws `LIGHTNING_ACCOUNT_REQUIRED` without credentials (documented upgrade steps in `BLITZORTUNG_UPGRADE_NOTES`, also re-exported from `index.js`). With credentials it throws `LIGHTNING_NOT_IMPLEMENTED` rather than fabricating strikes. Swapping in a real feed later = replace the source passed to the layer; the layer never changes.

## Keyless-source research (2026-09-27, single probes)

| Candidate | Result |
|---|---|
| `https://data.blitzortung.org/Data_1.php` | **HTTP 401** — login wall; free blitzortung.org account required |
| `https://mesonet.agron.iastate.edu/geojson/glm.geojson` | HTTP 301 → IEM API docs; no such endpoint |
| NOAA GOES-R GLM, `noaa-goes` S3 (`GLM-L2-LCFA/…`) | Bucket listings returned 0 keys for every probed prefix; GLM files are NetCDF (needs a new dependency to decode) |
| lightningmaps.org | Same Blitzortung login wall (not probed further) |

Conclusion: no practical keyless real-time strike feed for a dependency-free browser app → v1 is radar-modeled, honestly labeled. GOES-GLM remains the v2 path if NetCDF parsing (dep or server-side) becomes available.

## Wiring (for the parent — exact snippets, no existing files touched by this build)

**1. New app-layer wrapper** `src/app/layers/lightning.js` (new file, mirrors `meteors.js`):

```js
import { createLightningLayer } from '../../layers/lightning/index.js';
import { overlayHost } from './overlayHost.js';
/** Wire radar-modeled lightning to the application overlay host. */
export function createApplicationLightning({ sonification, ...options } = {}) {
  return createLightningLayer({
    overlayHost,
    onFlash: sonification ? (s) => sonification.lightningStrike(s) : null,
    ...options,
  });
}
```

**2. Sources map** — wherever `sources` is assembled (see `constructCatalog.js` usage):

```js
import { createRadarModeledLightningSource } from './layers/lightning/source.js';
// or from the barrel: '../../layers/lightning/index.js'
sources.lightning = createRadarModeledLightningSource({
  // optional: getCycloneCenters wired from the cyclones feed
});
```

**3. Catalog** — in `src/app/constructCatalog.js`, add the import + entry next to meteors:

```js
import { createApplicationLightning } from './layers/lightning.js';
// required-methods table:
lightning: ['getStrikes'],
// layer list:
createApplicationLightning({ source: sources.lightning, sonification }),
```

**4. F8 hookup** — pass the sonification handle (created in `src/cinematic/index.js`, see `src/cinematic/INTEGRATION.md`) into the catalog/lightning wrapper as `sonification`. Throttle tip: flashes can be frequent — e.g. `onFlash: (s) => { if (s.intensity > 0.55) son.lightningStrike(s); }`.

## Test results

- `node --check`: all 5 lightning files parse.
- `node --test` on `model.test.mjs` + `source.test.mjs`: **20/20 pass** (seeded sampling, night-side math, decay envelope, warm-pixel heuristic, tile scanning, frame caching, abort, honest failures, Blitzortung stub codes).
- Full repo `npm test`: running at build time — new files add 32 tests total (incl. sonification); see build report for the suite verdict.
