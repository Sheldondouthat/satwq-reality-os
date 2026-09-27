# Wave 3 Track 2b — 2.8 IOC Sea Level (legacy ONLY) — Integration Guide

Tide-gauge data provider: IOC Sea Level Monitoring **legacy** `service.php`
API → stratified global gauge snapshots with 6-h trend at `/api/sealevel`.
Data layer only — the tidal sentinel ring UX is owned by a sibling worker,
which consumes the JSON contract below (or this feature's frontend data
client).

**NEVER touch the v2 API** — it requires a key. This provider only calls
`service.php?query=stationlist|data&format=json`.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/iocSealevel.js` | `export function iocSealevelProxy({fetchImpl})` — mounts `/api/sealevel`; station list (cached 24 h) → deterministic stratified pick (one most-recent live gauge per 30°×30° cell, ≤24) → per-gauge observations → latest level + least-squares 6-h trend. Self-contained → workerd-safe. Exports `stratifyStations`, `trendPerHour`, `normalizeStation`. |
| `src/frontier/wave3/ioc-sealevel/source.js` | `createSealevelSource({fetchImpl, proxyBase, refreshMs})` — browser data client, fail-soft. |
| `src/frontier/wave3/ioc-sealevel/index.js` | `init(opts)` — fail-soft mount entry point; never throws. |
| `src/frontier/wave3/ioc-sealevel/ioc-sealevel.test.mjs` | 15 tests: mount, stratification, trend math, normalization, custom `?stations=` selection, code validation, per-gauge error isolation, all-down 502, frontend client. |

## 2. Probe outcomes (verified 2026-09-27 from sandbox)

| Fact | Detail |
|---|---|
| Station list | `service.php?query=stationlist&format=json` → 1,935 stations, 1,922 `status:1`; fields `Code, Location, country, type, Lat, Lon, statday, status` |
| Observations | `service.php?query=data&code=aarh&format=json` → `[{slevel, stime:"2026-09-26 12:10:00", sensor}]` (metres above gauge datum) |
| Freshness | Per-gauge; `statday` in the list shows last report (typically < 1 day) |
| Type codes | Raw values observed: SL, SW, SF, SD, SB, SS — passed through verbatim, never interpreted (mapping not verified) |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the vaac import:

```js
import { vaacProxy } from './vaac.js';
import { iocSealevelProxy } from './wave3/iocSealevel.js';   // ADD
```

and in `localProviderPlugins()`, after `vaacProxy(),`:

```js
    invisibleOceanProxy(),
    vaacProxy(),
    iocSealevelProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `vaac` entry:

```js
  {   // ADD
    name: 'ioc-sealevel',
    routes: ['/api/sealevel'],
    load: () => import('../providers/wave3/iocSealevel.js').then((m) => m.iocSealevelProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps, no cross-file imports.

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Sealevel } from './wave3/ioc-sealevel/index.js';   // ADD (top imports)
// inside initFrontier:
  // — Wave 3 Track 2b: IOC sea-level data (sentinel-ring UX separate) —
  attempt('wave3-sealevel', () => {
    const handle = initWave3Sealevel();
    return () => handle.stop();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

```js
  'feature.seaLevel': 'Sea-level sentinel (IOC)',
  'feature.seaLevel.trend': '6-hour trend',
  'feature.seaLevel.gauge': 'Tide gauge',
```

## 4. Consumer contract

`GET /api/sealevel` → stratified sample; `GET /api/sealevel?stations=aarh,bres`
→ custom selection (codes validated `^[a-z0-9_-]{1,24}$`, unknown codes
dropped, 400 on zero valid codes).

```json
{
  "fetchedAt": 1758940000000, "ttlMs": 600000, "stale": false,
  "selection": "stratified",
  "stations": [{
    "code": "aarh", "location": "Aarhus", "country": "DMK",
    "lat": 56.15, "lon": 10.22, "type": "SF",
    "latest": { "t": "2026-09-26T13:00:00.000Z", "level": 0.2 },
    "trendMPerH": -0.084, "samples": 6, "status": "ok"
  }],
  "unavailable": false, "reason": null
}
```

- `trendMPerH`: least-squares slope of the last 6 h of observations,
  metres/hour — DERIVED. It describes recent water movement, NOT a tsunami
  detection; genuine tsunami alerts come from warning centres, never here.
- Per-gauge failures are isolated (`status:'error'`); all down + no cache →
  502 `{error:'sealevel_upstream_unavailable'}`; all down + cache → `stale:true`.

## 5. Behavior contract

- Station-list cache 24 h; snapshot cache 10 min; list body cap 2 MB, data
  cap 256 KB/gauge; timeout 20 s.
- Stratified pick is deterministic (most-recent `statday` per cell) so the
  ring is stable across refreshes.
- Legacy `service.php` only. No keys, no paid deps, no WASM, no `node:`
  imports in the registry path.

## 6. Verification

```bash
cd ~/workspace/gods-eye-view
node --check server/providers/wave3/iocSealevel.js
node --check src/frontier/wave3/ioc-sealevel/source.js
node --check src/frontier/wave3/ioc-sealevel/index.js
node --test src/frontier/wave3/ioc-sealevel/ioc-sealevel.test.mjs
# live smoke (needs network):
curl -s 'http://localhost:4173/api/sealevel?stations=aarh' | head -c 400
```

## 7. Known limits / follow-ups

- Gauge `type` codes (SL/SW/SF/…) are passed through raw; the UX must not
  label a gauge "tsunami/DART" from the type code alone (mapping unverified).
- Gauges go quiet; `status:'nodata'` rows carry the last-known position
  with nulls — the ring should render them dimmed, never drop them silently.
