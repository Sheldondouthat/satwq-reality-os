# Wave 3 Track 2c / 2.15 — EiBi shortwave "on air now" — Integration Guide

Polls the EiBi A26-season shortwave schedule CSV (**plain HTTP** — the HTTPS
variant returns an empty reply, verified 2026-09-27) and computes, per UTC
minute, which HF broadcasters are on the air. The globe shows one marker per
country (sized by station count); clicking lists live
frequency/band/station/language/target/site. The same parsed shape feeds
W8's shortwave oracle (see §6).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/eibi.js` | `export function eibiProxy({fetchImpl, now})` — mounts `/api/eibi`; parses the 11-column CSV, computes on-air per UTC minute. Workerd-safe. Exports `parseDaysCell`, `parseTimeWindow`, `parseSeasonDate`, `parseLastHeard`, `isOnAir`, `normalizeEibiRow`, `parseEibiCsv`. |
| `src/frontier/wave3/eibi/model.js` | `bandOf` (HF band labels), `isoForItu` (ITU→ISO2, null for non-countries), `aggregateOnAir`, `markerSize`. |
| `src/frontier/wave3/eibi/source.js` | `createEibiSource({fetchImpl, apiPath})` — browser snapshot client. |
| `src/frontier/wave3/eibi/index.js` | `init({viewer, apiPath})` — fail-soft Cesium mount; country markers + station tables, 1-min refresh. |
| `src/frontier/wave3/eibi/eibi.test.mjs` | 12 tests: days notation (ranges, wrap, concatenation), time windows (0000-2400, midnight wrap), DDMM vs [MMYY] log dates, persistence codes, real VLF row, aggregation. |

## 2. Probe outcomes (verified 2026-09-27, corrected against README.TXT)

| Fact | Detail |
|---|---|
| URL | `http://eibispace.de/dx/sked-a26.csv` (HTTP only) → 518,865 bytes, 9,443 lines, `;`-delimited |
| Column semantics | Per README.TXT entries #8–#11: field 8 is the transmitter-**site** code (header mislabels it "Remarks"); field 9 is the **persistence** code, NOT power (0=this season, 1=everlasting, 4=winter-only, 5=summer-only, 6=part-season, 8=inactive); Start/Stop are **DDMM** ("0401"=4th January) |
| Bracketed dates | `[MMYY]` is the most-recent-**log** date ("[0212]"=last heard Feb 2012) — informational only, never a season bound |
| Empty Days | README: empty Days field = daily (verified against the file) |
| P distribution | 80 rows P=8 (excluded from on-air), 359 P=4, 357 P=5, 570 P=6 — all honored by `isOnAir` |
| Coordinates | The CSV carries **no transmitter coordinates** — markers are honest country-level centroids |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the gmn import:

```js
import { gmnProxy } from './wave3/gmn.js';
import { eibiProxy } from './wave3/eibi.js';   // ADD
```

and in `localProviderPlugins()`, after `gmnProxy(),`:

```js
    gmnProxy(),
    eibiProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `gmn` entry:

```js
  {   // ADD
    name: 'eibi',
    routes: ['/api/eibi'],
    load: () => import('../providers/wave3/eibi.js').then((m) => m.eibiProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Eibi } from './wave3/eibi/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.15: EiBi shortwave "on air now" —
  attempt('wave3-eibi', () => {
    const handle = initWave3Eibi({ viewer });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.meteors',`):

```js
  'feature.eibi',
```

and in `BASE_STRINGS` (after `'feature.meteors.mass': 'Estimated mass',`):

```js
  'feature.eibi': 'Shortwave on air (EiBi)',
  'feature.eibi.onAir': 'on air now',
  'feature.eibi.site': 'Transmitter site code',
```

## 4. Consumer contract (also the W8 shortwave-oracle shape)

`GET /api/eibi` → 200

```json
{
  "fetchedAt": 1758940000000, "season": "a26", "stale": false,
  "unavailable": false, "reason": null, "total": 9443,
  "onAirCount": 231, "byItu": { "CHN": 42, "IND": 17 },
  "onAir": [{
    "freqKhz": 15560, "time": "1100-1200", "days": "Mo-Fr", "itu": "CHN",
    "station": "China Radio Int.", "lang": "", "target": "SAs",
    "site": "ka", "persistence": 1, "start": "2903", "stop": "",
    "lastHeard": null
  }]
}
```

- `persistence`: 0=this season, 1=everlasting, 2/3=DST-shifted everlasting,
  4=winter-only, 5=summer-only, 6=part-season (Start/Stop apply), 8=inactive
  (never included in `onAir`).
- `lastHeard`: `{month, year}` from the bracketed `[MMYY]` log annotation, or null.
- Upstream down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 60 s ("on air now" is minute-precision); body cap 2 MB; timeout 30 s; max 400 on-air entries served.
- P=4/5 winter/summer filtering uses a **northern-hemisphere convention**
  (winter=Oct–Mar, summer=Apr–Sep) — documented assumption; the README does
  not name a hemisphere.
- Markers are **country-level** (approximate centroids) — never site pins.
  ITU codes with no country mapping (CLA/CLM clandestine, UN, XUU, P) are
  listed in `unmapped`, never plotted.
- Ambient broadcast schedules only — no content interception.
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.

## 6. W8 shortwave-oracle notes

`/api/eibi` is the oracle's data feed: poll it each minute, match the
user's receiver location against `target` area codes and the on-air
`freqKhz` list, and surface `station`/`lang`/`site`/`lastHeard` for tuning.
No extra parsing is needed client-side.
