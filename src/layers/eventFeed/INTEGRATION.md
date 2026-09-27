# Event Feed (F1 + F6) — INTEGRATION.md

Wiring instructions for the integrator. Nothing in this directory edits
existing files; every snippet below is a copy-paste addition.

## 1. Server provider registration

### 1a. `server/pages/registry.mjs` (Pages Functions)

Add to the `REGISTRY` array (after the `fire-perimeters` entry, keeping the
established order):

```js
{
  name: 'event-synthesis',
  routes: ['/api/events', '/api/sky-alerts'],
  load: () => import('../providers/eventSynthesis.js').then((m) => m.eventSynthesisProxy()),
},
```

Pages-bundle safety: the provider uses only global `fetch` + the capped
readers from `server/providers/common/http.js`. No `node:` imports, no
`Buffer`, no `fs`, no WASM. Its imports (`./hmsSmoke.js` candidate-URL
helpers, `../../src/layers/hmsSmoke/records.js` KML parser, `./cyclones.js`
`parseCycloneStatus`, `../../src/layers/eventFeed/model.js` correlation
logic) are all already Pages-safe.

### 1b. `server/providers/local.js` (dev / preview server)

Add the import (with the other provider imports):

```js
import { eventSynthesisProxy } from './eventSynthesis.js';
```

And add to the array returned by `localProviderPlugins()` (after
`hmsSmokeProxy(),` to keep smoke-adjacent providers together):

```js
eventSynthesisProxy(),
```

## 2. Frontend wiring (`src/main.js` / HUD)

The panel is a self-contained DOM overlay (it injects its own scoped CSS, so
no stylesheet changes are needed). It needs a host element — add one to the
HUD markup or let the layer fall back to `document.body`:

```js
import { createEventFeedLayer } from './layers/eventFeed/index.js';

// After the Cesium viewer exists:
const eventFeedLayer = createEventFeedLayer({
  viewer,
  container: document.getElementById('event-feed-host'), // optional; defaults to document.body
  // onFlyTo: ({ lat, lon, title }) => myCustomFlyTo(lat, lon), // optional override
});
eventFeedLayer.init(viewer);
eventFeedLayer.enable();
```

Polling: the panel self-polls both endpoints every 60 s. If the app drives
layers on a tick, also call `await eventFeedLayer.update()` from that tick
(it is a no-op when disabled). Teardown: `eventFeedLayer.destroy()`.

`onFlyTo({ lat, lon, title })` — the default flies the Cesium camera to the
incident at 150 km altitude, 45° pitch. Override it to route through the
app's camera director instead.

## 3. Endpoint contract

`GET /api/events` →

```json
{
  "schemaVersion": 1,
  "incidents": [
    {
      "id": "smoke-traffic:33.65,-84.40",
      "type": "smoke-near-traffic",
      "title": "Heavy wildfire smoke near dense air traffic",
      "detail": "…",
      "severity": "low|moderate|high|critical",
      "confidence": 0.72,
      "sources": ["hms-smoke", "opensky"],
      "lat": 33.65, "lon": -84.4,
      "at": "2026-09-26T23:00:00.000Z"
    }
  ],
  "degraded": false,
  "degradedSources": [],
  "reason": null,
  "sources": [
    { "source": "hms-smoke", "ok": true, "count": 49 },
    { "source": "usgs-quakes", "ok": true, "count": 27 },
    { "source": "nhc-storms", "ok": true, "count": 5 },
    { "source": "opensky", "ok": true, "count": 5111 }
  ],
  "fetchedAt": "2026-09-26T23:00:00.000Z"
}
```

Incident types (every incident correlates ≥2 sources):
`smoke-near-traffic`, `quake-near-smoke`, `quake-near-storm`,
`storm-near-traffic`.

`GET /api/sky-alerts` →

```json
{
  "schemaVersion": 1,
  "alerts": [
    {
      "id": "squawk-7700:abc123",
      "kind": "squawk-7700",
      "title": "Emergency squawk 7700 — general emergency",
      "detail": "…",
      "icao24": "abc123", "callsign": "TEST123", "squawk": "7700",
      "lat": 33.65, "lon": -84.4,
      "at": "2026-09-26T23:00:00.000Z",
      "heuristic": false,
      "confidence": 1
    }
  ],
  "degraded": false,
  "reason": null,
  "fetchedAt": "…",
  "windowSec": 180,
  "snapshotCount": 4,
  "trackCount": 5112
}
```

Alert kinds: `squawk-7500` / `squawk-7600` / `squawk-7700` (exact,
`heuristic:false`, `confidence:1`) and the documented v1 heuristics
`holding-pattern` / `go-around` (`heuristic:true`, `confidence ≤ 0.6`).
Heuristics need ≥3 OpenSky snapshots spanning 90 s–10 min; a fresh server
instance reports "insufficient history" honestly (no alerts) until the
window fills.

Degradation contract: per-source try/catch; a failed source yields
`degraded:true` + `degradedSources:[{source, reason}]` while the healthy
sources still produce incidents/alerts. Total failure still returns HTTP 200
with an honest degraded payload — the panel shows a retrying empty state,
never a crash. Caching: events 300 s TTL, sky 120 s TTL, single-flight
refresh, serve-stale-on-error.

## 4. Known issues / upgrade paths (for the integrator)

- **HMS parser drift (OBSERVED 2026-09-26, pre-existing repo bug):** the live
  HMS KML names placemark styles `#Smoke_Light_style` / `#Smoke_Medium_style`
  (StyleMap ids), but `src/layers/hmsSmoke/records.js` `parseSmokeKml()`
  only matches bare `#Smoke_Light|Moderate|Heavy` — so it returns **0
  polygons on current files** (verified: 49 placemarks in the 2026-09-26
  file, 0 parsed). The existing hmsSmoke frontend layer is affected too.
  `records.js` was outside this task's writable dirs, so
  `server/providers/eventSynthesis.js` carries a documented feed-drift
  adapter that canonicalizes the real ids to the parser's vocabulary
  (`Medium → Moderate` is HMS's actual middle density class — a rename, not
  a reinterpretation). The durable fix is to widen the regex in
  `records.js`; until then this adapter keeps F1 working.
- **FIRMS upgrade path:** FIRMS is deliberately not a source (prod
  `FIRMS_MAP_KEY` is NOT-CONFIGURED). When a key exists, add a fifth source
  in `fetchEvents()` and a `hotspot-near-*` rule following the existing
  `synthesizeIncidents()` pattern — see the FIRMS-UPGRADE comment in
  `server/providers/eventSynthesis.js`.
- **OpenSky anonymous budget:** the provider polls `/states/all` at most
  once per 120 s with a 12 MB cap; the existing `opensky` aircraft provider
  has its own credit governor and is untouched. If the anonymous budget
  tightens, raise `skyTtlMs` in the `eventSynthesisProxy()` options.
- **Go-around airport list:** `MAJOR_AIRPORTS` in `model.js` is a 40-airport
  proximity sanity check (public reference data), not an airport database.
  Extend it if go-around coverage outside major hubs matters.

## 5. Files delivered

- `server/providers/eventSynthesis.js` — `eventSynthesisProxy()` factory,
  mounts `GET /api/events` + `GET /api/sky-alerts`.
- `src/layers/eventFeed/model.js` — pure correlation + sky-alert logic
  (zero imports; shared by provider and tests).
- `src/layers/eventFeed/panel.js` — DOM overlay panel (60 s poll,
  severity/source/confidence cards, `onFlyTo` hook, retrying empty state).
- `src/layers/eventFeed/index.js` — layer factory + default Cesium fly-to
  (only file in the layer that imports Cesium).
- `src/layers/eventFeed/model.test.mjs` — 25 tests: geometry, normalizers
  (incl. null→0 coercion edge cases), density grid, all 4 incident rules,
  exact squawks + both v1 heuristics + negative cases.
- `src/layers/eventFeed/panel.test.mjs` — 8 tests: card rendering, fly-to
  hook, retrying empty state, degraded banner, heuristic tagging, recovery,
  XSS-as-text.

Test results (2026-09-26, `node --test`): 25/25 model, 8/8 panel, 0
failures; `node --check` clean on all six new `.js` files. Live end-to-end
run against real upstreams: all 4 keyless sources OK (HMS 49 polygons via
the drift adapter, USGS 27 quakes, NHC 5 storms, OpenSky ~5.1k tracks) →
2 real `smoke-near-traffic` incidents, 0 sky alerts (no emergency squawks in
the live snapshot).
