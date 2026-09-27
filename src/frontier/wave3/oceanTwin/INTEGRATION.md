# INTEGRATION — oceanTwin (wave3 sci-fi B #2)

**Status:** client module complete, 10/10 tests passing. No shared-file edits
made by the author; the parent applies the lines below.

## 1. server/providers/local.js — NOTHING (exclusion note)

Current particles advect on a **pre-bundled RTOFS snapshot**
(`data/currents_snapshot.json`, 9,907 vectors, 278 KB, lazy-loaded).
A live server current feed was attempted and rejected on evidence:

- OSCAR: PO.DAAC requires Earthdata login (keyed) — excluded.
- NOAA CoastWatch ERDDAP: no OSCAR dataset id exists (`erdOscarVel` → 404).
- NOMADS DODS: decommissioned (SCN25-81 consolidation notice).
- HYCOM TDS OPeNDAP: dataset paths not resolvable keyless from this network.
- RTOFS NetCDF via FTPPRD: empty replies from this network; the same files
  ARE keyless on `nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod/` — the
  snapshot was built from `rtofs.20260927/rtofs_glo_2ds_n000_prog.nc`
  (155 MB analysis, valid 2026-09-26T00:00Z) and decimated to ~3°.

Cables reuse the existing TeleGeography bundled source
(`src/layers/submarineCables/bundledSource.js`) — no new data.
Argo floats come from **W5's `/api/argo`** (server/providers/wave3/argo.js);
the twin renders them when registered and degrades gracefully until then.

Per PAGES_PORT.md conventions this is a deliberate client-only feature.

## 2. server/pages/registry.mjs — NOTHING

No new `/api/*` routes. (W5's `/api/argo` registration is W5's INTEGRATION.md.)

## 3. initFrontier mount call (src/frontier/index.js)

Static import (top of file):

```js
import { init as initOceanTwin } from './wave3/oceanTwin/index.js';
```

Attempt block — place after the deep-time block:

```js
  // — sci-fi B2 ocean twin —
  attempt('ocean-twin', () => {
    const s = section(t('feature.oceanTwin'));
    dock.appendChild(s);
    const twin = initOceanTwin(viewer, { mount: s });
    if (!twin) return () => {};
    return () => twin.destroy();
  });
```

## 4. Theme dictionary strings (src/themes/engine.js)

```js
  'feature.oceanTwin': 'Ocean twin (currents · cables · Argo)',
```

## Notes for the integrator

- The module imports `../argo/source.js` (W5's client) — read-only reuse, no
  edits to W5's files.
- The module imports `../../../layers/submarineCables/bundledSource.js` —
  read-only reuse of the existing cable dataset (CC BY-NC-SA 3.0, noted in UI).
- Honesty: the panel caption always states the currents are a snapshot, not
  live telemetry; Argo tooltips note drift between 10-day fixes is unknown.
