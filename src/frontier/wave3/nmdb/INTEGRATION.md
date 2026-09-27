# Wave 3 Track 2b — 2.6 NMDB neutron monitors — Integration Guide

Cosmic-ray ground-station data provider: NMDB NEST real-time ASCII service
→ normalized per-station intensity snapshots at `/api/nmdb`. Data layer
only — cosmic-ray WEATHER UX/alerts are owned by worker W7, which consumes
the JSON contract below (or this feature's frontend data client).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/nmdb.js` | `export function nmdbProxy({fetchImpl})` — mounts `/api/nmdb`; fetches NEST ASCII for the curated 12-station set, parses + normalizes server-side. Self-contained (no imports from shared provider code) → workerd-safe by construction. Exports `parseNestAscii` + `normalizeStationBlock` for tests/consumers. |
| `src/frontier/wave3/nmdb/source.js` | `createNmdbSource({fetchImpl, proxyBase, refreshMs})` — browser data client with fail-soft refresh, listener notify, last-good retention. No DOM/Cesium. |
| `src/frontier/wave3/nmdb/index.js` | `init(opts)` — fail-soft mount entry point; never throws. |
| `src/frontier/wave3/nmdb/nmdb.test.mjs` | 13 tests: provider mount, NEST parser fixtures, normalization math, allowlist, 502/405/stale-cache, frontend client, init handle. |

## 2. Probe outcomes (verified 2026-09-27 from sandbox)

| Fact | Detail |
|---|---|
| NEST ASCII endpoint | `https://www.nmdb.eu/nest/draw_graph.php?formchk=1&stations[]=<CODE>&output=ascii&tabchoice=revori&dtype=corr_for_efficiency&date_choice=last&lastndays=1` → 200, embedded ASCII in the HTML page |
| ASCII layout | `#`-header block per station (`STATION:`, `START TIME:`, `DATA TYPE:`, `ORIGINAL RES: 1 min`) then `YYYY-MM-DD HH:MM:SS; value` lines; multiple `stations[]` return multiple blocks in one request |
| Series semantics | `corr_for_efficiency` arrives as a small deviation-scale series (e.g. −1.007, 1.550) — NMDB serves it pre-normalized. We additionally derive `deviation` (latest − window median, native units) and `deviationMAD` (robust standardized deviation vs the median absolute deviation) and label them as such |
| Rate | Keyless, no auth. One request serves all 12 stations (~17k lines/day/station set, under the 2 MB body cap) |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the vaac import:

```js
import { vaacProxy } from './vaac.js';
import { nmdbProxy } from './wave3/nmdb.js';   // ADD
```

and in `localProviderPlugins()`, after `vaacProxy(),`:

```js
    invisibleOceanProxy(),
    vaacProxy(),
    nmdbProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `vaac` entry:

```js
  {
    name: 'vaac',
    routes: ['/api/vaac'],
    load: () => import('../providers/vaac.js').then((m) => m.vaacProxy()),
  },
  {   // ADD
    name: 'nmdb',
    routes: ['/api/nmdb'],
    load: () => import('../providers/wave3/nmdb.js').then((m) => m.nmdbProxy()),
  },
];
```

Workerd safety: the module uses only global `fetch`, `AbortController`,
`setTimeout`, `TextDecoder`-free string ops — no `node:` imports, no WASM,
no npm deps, no cross-file imports. Degrades to 503 per-route if the
isolate can't load it (never affects other providers).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

Data layer only (W7 owns the UX). Add near the other wave3 mounts:

```js
import { init as initWave3Nmdb } from './wave3/nmdb/index.js';   // ADD (top imports)
// inside initFrontier, next to other attempt(...) mounts:
  // — Wave 3 Track 2b: NMDB cosmic-ray data (W7 owns the weather UX) —
  attempt('wave3-nmdb', () => {
    const handle = initWave3Nmdb();
    return () => handle.stop();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

Add to the canonical defaults object (near `feature.invisibleOcean`):

```js
  'feature.cosmicRay': 'Cosmic-ray weather (NMDB)',
  'feature.cosmicRay.deviation': 'Intensity deviation',
  'feature.cosmicRay.station': 'Neutron monitor',
```

## 4. Consumer contract (for worker W7)

`GET /api/nmdb?days=1&stations=OULU,KERG`

- `days`: 1–3 (default 1). `stations`: comma list, allow-listed to the 12
  curated codes; unknown codes are dropped. Omit for the full set.
- 200 →

```json
{
  "fetchedAt": 1758940000000,
  "period": { "days": 1, "start": null, "end": null },
  "ttlMs": 600000, "stale": false,
  "stations": [{
    "code": "OULU", "name": "Oulu", "lat": 65.05, "lon": 25.47,
    "latest": { "t": "2026-09-26T05:56:00Z", "value": 2.3 },
    "median": 2.2, "deviation": 0.1, "deviationMAD": 1.0,
    "samples": 1440,
    "status": "ok"
  }],
  "unavailable": false, "reason": null
}
```

- `latest.value`: the NEST `corr_for_efficiency` series value — a
  deviation-scale quantity in NMDB's native served units (OBSERVED live:
  per-minute values like −1.335 with window medians near zero).
- `deviation` = latest − window median (native units); `deviationMAD` =
  `deviation` / median-absolute-deviation — DERIVED, label as model, not
  absolute flux. Percent-of-median was deliberately NOT used: the window
  median sits near zero, and it produced a spurious −2934% on live Oulu
  data (verified 2026-09-27).
- `status: 'nodata'|'error'` rows carry nulls; never invent values.
- Failure: upstream down + no cache → 502 `{error:'nmdb_upstream_unavailable'}`;
  upstream down + cache → 200 with `stale:true`. Non-GET → 405.

## 5. Behavior contract

- Cache TTL 10 min; body cap 2 MB; upstream timeout 30 s (NEST is slow).
- Station coordinates are the published NMDB station coordinates (nmdb.eu
  station table), baked in — no per-request metadata scraping.
- No keys, no paid deps, no WASM, no `node:` imports in the registry path.

## 6. Verification

```bash
cd ~/workspace/gods-eye-view
node --check server/providers/wave3/nmdb.js
node --check src/frontier/wave3/nmdb/source.js
node --check src/frontier/wave3/nmdb/index.js
node --test src/frontier/wave3/nmdb/nmdb.test.mjs
# live smoke (needs network):
curl -s 'http://localhost:4173/api/nmdb?stations=OULU,KERG' | head -c 400
```

## 7. Known limits / follow-ups

- NEST HTML-embedded ASCII is screen-scrape-adjacent; the parser validates
  row shape and skips malformed lines. If NEST redesigns the page, the
  provider 502s rather than serving garbage.
- `revori` (revised-original) tab is used; for the last ~15 min some
  stations report provisional values — the `status` field does not
  distinguish provisional from revised (NEST doesn't label it per row).
