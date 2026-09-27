# INTEGRATION — Wave 5: leap-second / time-standard ticker (catalog Wave A item 20)

**Status:** built 2026-09-27 · both upstreams VERIFIED live (IERS Bulletin C
#72 dated 2026-07-06, UTC_TAI=-37; IANA leap-seconds.list, last line
`3692217600 37 # 1 Jan 2017`, expiry NTP 4023129600)
**Files (mine only):**
- `server/providers/wave5/time.js` — `timeProxy()` factory → `/api/time`
- `server/providers/wave5/time.test.mjs` — 10 tests, all passing
- `api/time.js` — Vercel mount (shared connect adapter)
- `src/frontier/wave5/time/model.js` — pure client model
- `src/frontier/wave5/time/index.js` — `init({mount, chip, t})` dock ticker
- `src/frontier/wave5/time/time.test.mjs` — 4 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { timeProxy } from './wave5/time.js';
```

`localProviderPlugins()` array, after `wxstationsProxy(),`:
```js
    wxstationsProxy(),
    timeProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `wxstations` entry (pure fetch/text — Pages-safe):
```js
  {
    name: 'time',
    routes: ['/api/time'],
    load: () => import('../providers/wave5/time.js').then((m) => m.timeProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initTime } from './wave5/time/index.js';
```

Inside `initFrontier`, next to the wxstations block:
```js
  // — Wave 5: leap-second / time-standard ticker —
  attempt('time', () => {
    const s = section(t('feature.time'));
    dock.appendChild(s);
    return initTime({ mount: s, chip, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.time',`
`BASE_STRINGS` += `'feature.time': 'Time standards (UTC/TAI)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.time': 'Clock standard'` |
| batcave | `'feature.time': 'Time standard watch'` |
| garage | `'feature.time': 'Time standards'` |
| noir | `'feature.time': 'Chronometer file'` |
| lcars | `'feature.time': 'Temporal reference'` |
| pipboy | `'feature.time': 'Time standards'` |
| jarvis | `'feature.time': 'Time standard'` |
| nerv | `'feature.time': 'Time pattern'` |
| nightcity | `'feature.time': 'Time feed'` |
| apollo | `'feature.time': 'Mission clock ref'` |
| weyland | `'feature.time': 'Chronology log'` |
| synthwave | `'feature.time': 'Time standards'` |
| scp | `'feature.time': 'Temporal file'` |
| tron | `'feature.time': 'Time program'` |

## API contract

`GET /api/time` →
`{ schemaVersion:1, generatedAt, taiMinusUtc, nextLeap, agreement,
   sources:[{id,name,status,taiMinusUtc,bulletinNumber?,bulletinDate?,
   lastLeapDate?,error?}], fileExpiry, stale, unavailable, reason, attribution }`
- `nextLeap`: null when neither source announces one (the normal state) —
  `{date, taiMinusUtc, announcedBy}` when announced.
- `agreement`: `agree` | `disagree` (IERS wins, reason explains) | `single-source`.
- Cache 24 h, stale 7 d, retry cooldown 60 s.

## Honesty note (dock)
> nextLeap null = no leap second announced, not missing data. IERS Bulletin C
> is authoritative on disagreement.

## Conventions noted
- `redirect:'follow'` — workerd rejects `redirect:'error'`.
- Bulletin C parsed with regexes (no XML lib — Pages-safe); the "current"
  offset is the latest `<UT>` line already in effect, never a future
  announcement line.

## Verification
- Live: both upstreams fetched 2026-09-27 ~15:45 EDT; both say TAI−UTC = 37;
  no future leap in either source.
- Tests: `node --test server/providers/wave5/time.test.mjs
  src/frontier/wave5/time/time.test.mjs` → 14/14 pass.
