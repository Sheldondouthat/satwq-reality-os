# INTEGRATION — Wave 3 Track 3b.6: Orcasound hydrophones

**Status:** built 2026-09-27 · provider + tests verified live
(7 hydrophones parsed from __NEXT_DATA__, 6 online, all 6 playlists
resolved live, e.g. rpi_orcasound_lab → …/hls/1790406012/live.m3u8)
**Files (mine only):**
- `server/providers/wave3/orcasound.js` — `orcasoundProxy()` →
  `/api/orcasound`. Parses __NEXT_DATA__ from live.orcasound.net/listen
  (build ID never hardcoded), resolves each online node's latest.txt →
  live.m3u8 at serve time. 60 s cache, 503-with-stale-cache.
- `server/providers/wave3/orcasound.test.mjs` — 6 tests, all passing.
- `src/frontier/wave3/orcasound/model.js` — format helpers.
- `src/frontier/wave3/orcasound/index.js` — `init({viewer, mount, chip, trackLayer, t})`:
  click-to-play live HLS via lazy `import('hls.js')` (same pattern as
  src/layers/cctv/videoPlayback.js), Safari native-HLS fallback, click
  name to fly the camera to the hydrophone.
- `src/frontier/wave3/orcasound/orcasound.test.mjs` — 2 tests, all passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { orcasoundProxy } from './wave3/orcasound.js';
```

`localProviderPlugins()` array:
```js
    orcasoundProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

```js
  {
    name: 'orcasound',
    routes: ['/api/orcasound'],
    load: () => import('../providers/wave3/orcasound.js').then((m) => m.orcasoundProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initOrcasound } from './wave3/orcasound/index.js';
```

Inside `initFrontier`, after the eclipse attempt block:
```js
  // — W3 3b.6 Orcasound —
  attempt('orcasound', () => {
    const s = section(t('feature.orcasound'));
    dock.appendChild(s);
    return initOrcasound({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.orcasound',`
`BASE_STRINGS` += `'feature.orcasound': 'Hydrophones',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.orcasound': 'Hydrophones'` |
| batcave | `'feature.orcasound': 'Hydrophones'` |
| garage | `'feature.orcasound': 'Hydrophones'` |
| noir | `'feature.orcasound': 'Hydrophone dossier'` |
| lcars | `'feature.orcasound': 'Acoustic scan'` |
| pipboy | `'feature.orcasound': 'Hydrophones'` |
| jarvis | `'feature.orcasound': 'Ocean audio'` |
| nerv | `'feature.orcasound': 'Acoustic pattern'` |
| nightcity | `'feature.orcasound': 'Hydrophone feed'` |
| apollo | `'feature.orcasound': 'Hydrophones'` |
| weyland | `'feature.orcasound': 'Acoustic log'` |
| synthwave | `'feature.orcasound': 'Hydrophones'` |
| scp | `'feature.orcasound': 'Acoustic file'` |
| tron | `'feature.orcasound': 'Acoustic program'` |

## API contract

`GET /api/orcasound`
→ `{ count, onlineCount, hydrophones:[{name,nodeName,slug,lat,lon,
    online,thumbUrl,latestTxtUrl,playlistTemplate,hlsUrl,streamLive}],
    honesty, attribution, stale }`
- `hlsUrl` is null for offline nodes or when latest.txt is unparseable.
- No audio bytes pass through this server — the browser plays the S3
  playlist directly (bucket sends `Access-Control-Allow-Origin: *`,
  verified 2026-09-27).

## Honesty
The panel states the audio is the live stream unmodified and performs no
orca-call detection. Ambient broadcast metadata only.

## Verification
- Live 2026-09-27: 7 feeds parsed, 6 online with resolved HLS URLs.
- Tests: `node --test server/providers/wave3/orcasound.test.mjs` → 6/6;
  `node --test src/frontier/wave3/orcasound/orcasound.test.mjs` → 2/2.
