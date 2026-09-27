# Wave 3 Track 2c / 2.11 — RIPEstat internet routing pulse — Integration Guide

Polls the keyless RIPEstat Data API `bgp-state` endpoint for four curated
anycast DNS prefixes and distills, per RIS route collector (RRC), how many
peers observe each prefix and with what AS-path lengths. The globe layer
draws "routing pulse" arcs between the RRC/IXP cities that see each prefix.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/ripestat.js` | `export function ripestatProxy({fetchImpl, now})` — mounts `/api/ripestat`; fans out ≤4 concurrent `bgp-state` calls (RIPEstat allows 8/IP; we cap at 4). Workerd-safe. Exports `parseBgpState`. |
| `server/providers/wave3/lib/proxy.js` | Shared keyless-proxy factory (`createKeylessProxy`, `fetchUpstreamText`, `mapLimit`): capped bodies, timeouts, TTL cache, stale fallback, singleflight, waiter cap, post-failure retry cooldown. |
| `src/frontier/wave3/ripestat/model.js` | `RRC_TABLE` (22 collectors → city/IXP/lon/lat, per RIPE NCC ris-docs), `locateCollectors`, `starArcs`, `pulseSize`. |
| `src/frontier/wave3/ripestat/source.js` | `createRipestatSource({fetchImpl, apiPath})` — browser snapshot client. |
| `src/frontier/wave3/ripestat/index.js` | `init({viewer, apiPath})` — fail-soft Cesium mount; collector markers + pulse arcs, 10-min refresh. |
| `src/frontier/wave3/ripestat/ripestat.test.mjs` | 6 tests: real bgp-state rows, RRC table completeness/coords, arc hub selection, source shape validation. |

## 2. Probe outcomes (verified 2026-09-27)

| Fact | Detail |
|---|---|
| Endpoint | `https://stat.ripe.net/data/bgp-state/data.json?resource=1.1.1.0/24` → 200, `data.bgp_state[]` with `source_id` (`"00-102.208.105.2"` → RRC `rrc00`), `path`, `community`, `timestamp` |
| RRC locations | RIPE NCC ris-docs confirm collector city/IXP siting (Amsterdam AMS-IX, London LINX/LONAP, Tokyo JPIX/JPNAP, New York NYIIX, Palo Alto PAIX, São Paulo IX.br, Singapore SGIX, …) |
| Prefixes | `1.1.1.0/24` (Cloudflare), `8.8.8.0/24` (Google), `9.9.9.0/24` (Quad9), `208.67.222.0/24` (OpenDNS) — all globally anycast, visible from nearly every collector |
| Rate discipline | Documented limit 8 concurrent req/IP; implementation caps at 4 (`mapLimit(PREFIXES, 4)`) |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the sigmets import:

```js
import { sigmetsProxy } from './wave3/sigmets.js';
import { ripestatProxy } from './wave3/ripestat.js';   // ADD
```

and in `localProviderPlugins()`, after `sigmetsProxy(),`:

```js
    sigmetsProxy(),
    ripestatProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `sigmets` entry:

```js
  {   // ADD
    name: 'ripestat',
    routes: ['/api/ripestat'],
    load: () => import('../providers/wave3/ripestat.js').then((m) => m.ripestatProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Ripestat } from './wave3/ripestat/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.11: RIPEstat routing-pulse arcs —
  attempt('wave3-ripestat', () => {
    const handle = initWave3Ripestat({ viewer });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.sigmets',`):

```js
  'feature.ripestat',
```

and in `BASE_STRINGS` (after `'feature.sigmets': 'Aviation SIGMETs',`):

```js
  'feature.ripestat': 'Routing pulse (RIPEstat)',
  'feature.ripestat.collector': 'RIS collector',
  'feature.ripestat.originAs': 'Origin AS',
```

## 4. Consumer contract

`GET /api/ripestat` → 200

```json
{
  "fetchedAt": 1758940000000, "stale": false, "unavailable": false, "reason": null,
  "prefixes": [{
    "prefix": "1.1.1.0/24", "originAsn": 13335, "totalPeers": 412,
    "collectors": [{ "rrc": "rrc00", "peers": 38, "avgPathLen": 3.2,
                     "samplePaths": [[328840, 327727, 174, 13335]] }]
  }]
}
```

- `originAsn`: mode of AS-path tails across all peers (null when no paths).
- Per-prefix failure never fails the whole response — a failed prefix is
  listed with `error`; all-down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 10 min (BGP state moves slowly); body cap 2 MB per prefix;
  timeout 20 s per call; ≤4 concurrent upstream calls.
- `source_id` values that don't match `^\d{2}-` are skipped, never plotted.
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.
