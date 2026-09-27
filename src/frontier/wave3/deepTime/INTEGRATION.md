# INTEGRATION — deepTime (wave3 sci-fi B #1)

**Status:** client module complete, 9/9 tests passing. No shared-file edits made
by the author; the parent applies the lines below.

## 1. server/providers/local.js — NOTHING (exclusion note)

Deep-time uses **pre-bundled static slices** (7 × ~130–175 KB GeoJSON-derived
JSON, lazy-loaded via dynamic `import()` → separate Vite chunks). No upstream
fetch at runtime, no server provider needed. Per PAGES_PORT.md conventions
this is a deliberate client-only feature, not an exclusion failure.

## 2. server/pages/registry.mjs — NOTHING

No `/api/*` routes. The `data/*.json` assets ship with the static `dist/`
bundle and are fetched by the browser as lazy chunks.

## 3. initFrontier mount call (src/frontier/index.js)

Static import (top of file, with the other frontier imports):

```js
import { init as initDeepTime } from './wave3/deepTime/index.js';
```

Attempt block — place after the `// — F13 invisible ocean —` attempt block:

```js
  // — sci-fi B1 deep time —
  attempt('deep-time', () => {
    const dt = initDeepTime(viewer);
    if (!dt) return;
    const s = section(t('feature.deepTime'));
    // initDeepTime mounts its own slider panel into document.body; re-home it:
    const ownPanel = document.body.lastElementChild;
    if (ownPanel && ownPanel !== dock) {
      // panel was appended to body — move it into the frontier section
      s.appendChild(ownPanel);
    }
    dock.appendChild(s);
    return () => dt.destroy();
  });
```

**Simpler recommended alternative** (avoids DOM re-homing): the module accepts
`{ mount }`. Prefer:

```js
  // — sci-fi B1 deep time —
  attempt('deep-time', () => {
    const s = section(t('feature.deepTime'));
    dock.appendChild(s);
    const dt = initDeepTime(viewer, { mount: s });
    if (!dt) return () => {};
    return () => dt.destroy();
  });
```

## 4. Theme dictionary strings (src/themes/engine.js)

Add to the default dictionary (next to the other `feature.*` entries):

```js
  'feature.deepTime': 'Deep time (paleogeography)',
```

## Provenance / honesty (for the record)

- Coastlines: GPlates Web Service `https://gws.gplates.org/reconstruct/coastlines/`,
  `model=ZAHIROVIC2022`, slices at 0/50/100/150/200/250/300 Ma, retrieved
  2026-09-27. Source GeoJSON (~1.1–1.6 MB/slice) decimated 5× and rounded to
  2 dp → `src/frontier/wave3/deepTime/data/deep_coast_<age>Ma.json`.
- The honesty caption (`DEEP_TIME_HONESTY` in model.js) is always rendered
  under the slider: model output, not observation; uncertainty grows with age.
- Refresh: re-run the fetch + simplify script any time; keep the 50 Myr grid
  and the `deep_coast_<age>Ma.json` naming so `SLICE_LOADERS` keeps working.
