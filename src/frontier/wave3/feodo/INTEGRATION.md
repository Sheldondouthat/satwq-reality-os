# Wave 3 Track 2c / 2.12 — Feodo Tracker botnet C2 map — Integration Guide

Displays the abuse.ch Feodo Tracker IP blocklist (botnet command-and-control
infrastructure) as country-level markers: red = at least one currently
online C2, amber = historical/offline listings. **Defensive display only** —
no scanning, probing, or connections to listed IPs; the provider only
downloads the public JSON blocklist.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/feodo.js` | `export function feodoProxy({fetchImpl, now})` — mounts `/api/feodo`; normalizes the public blocklist, summarizes by country. Workerd-safe. Exports `normalizeFeodoRow`, `parseFeodoList`. |
| `src/frontier/wave3/feodo/model.js` | `countryMarkers` (country → centroid marker via shared `common/geo.js`), `markerSize`, `markerColorCss`. |
| `src/frontier/wave3/feodo/source.js` | `createFeodoSource({fetchImpl, apiPath})` — browser snapshot client. |
| `src/frontier/wave3/feodo/index.js` | `init({viewer, apiPath})` — fail-soft Cesium mount; country markers sized by C2 count, 30-min refresh. |
| `src/frontier/wave3/feodo/feodo.test.mjs` | 5 tests: real blocklist rows, bad-IP rejection, centroid placement, source shape validation. |

## 2. Probe outcomes (verified 2026-09-27)

| Fact | Detail |
|---|---|
| Endpoint | `https://feodotracker.abuse.ch/downloads/ipblocklist.json` → 200, 1,763 bytes, array of `{ip_address, port, status, as_number, as_name, country, first_seen, last_online, malware}` |
| Sample | 5 current rows: 3× US, 1× GB, 1× JP; one `online` (QakBot, `50.16.16.211:443`); two fetches returned identical bytes (not truncation) |
| Defensive | The provider performs zero active network behavior toward listed IPs — only the blocklist download |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the ripestat import:

```js
import { ripestatProxy } from './wave3/ripestat.js';
import { feodoProxy } from './wave3/feodo.js';   // ADD
```

and in `localProviderPlugins()`, after `ripestatProxy(),`:

```js
    ripestatProxy(),
    feodoProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `ripestat` entry:

```js
  {   // ADD
    name: 'feodo',
    routes: ['/api/feodo'],
    load: () => import('../providers/wave3/feodo.js').then((m) => m.feodoProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Feodo } from './wave3/feodo/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.12: Feodo Tracker C2 map (defensive display) —
  attempt('wave3-feodo', () => {
    const handle = initWave3Feodo({ viewer });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.ripestat',`):

```js
  'feature.feodo',
```

and in `BASE_STRINGS` (after `'feature.ripestat': 'Routing pulse (RIPEstat)',`):

```js
  'feature.feodo': 'Botnet C2 map (Feodo)',
  'feature.feodo.online': 'C2 currently online',
  'feature.feodo.offline': 'Historical / offline listings',
```

## 4. Consumer contract

`GET /api/feodo` → 200

```json
{
  "fetchedAt": 1758940000000, "stale": false, "unavailable": false, "reason": null,
  "total": 5, "online": 1,
  "byCountry": { "US": 3, "GB": 1, "JP": 1 },
  "entries": [{
    "ip": "50.16.16.211", "port": 443, "status": "online", "country": "US",
    "malware": "QakBot", "asNumber": 14618, "asName": "AMAZON-AES",
    "firstSeen": "2025-12-30 13:54:53", "lastOnline": "2026-03-12"
  }]
}
```

- Invalid IPs are dropped server-side, never served.
- Upstream down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 30 min; body cap 512 KB; timeout 20 s.
- Markers are **country-level** (approximate centroids from `common/geo.js`),
  never claims about physical C2 locations.
- No scanning, probing, or connections to listed IPs anywhere in this feature.
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.
