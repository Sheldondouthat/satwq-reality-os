# F10 Planetary Notebook — Integration Guide

New files (this directory, created 2026-09-26):

| File | Contents |
|---|---|
| `notebook.js` | Storage core: `createNotebook()`, `createLocalStorageBackend()`, `createMemoryBackend()`, `backendFromAsync()` |
| `notebook.test.mjs` | CRUD, reload persistence, corruption quarantine, export/import, async-backend wrapper |
| `notebookPanel.js` | DOM panel + Cesium pin entities + click-to-add hook |

No existing file was modified. No new npm deps, no keys, client-side only.
(The existing `src/annotations/` draw-tool system is unrelated; names do not collide.)

## 1. Mount the panel

```js
import { createNotebook, createLocalStorageBackend } from '../annotations/notebook.js';
import { createNotebookPanel } from '../annotations/notebookPanel.js';

const notebook = createNotebook(); // localStorageBackend by default
const panel = createNotebookPanel({ notebook });

panel.mount(document.getElementById('notebook-panel')); // DOM
panel.attachViewer(viewer);                             // Cesium pin entities

// Add a pin at the map center from anywhere:
panel.addPinAtCenter();

// Later:
panel.unmount();
```

The panel renders: pin list (title, coords, Focus/Edit/Delete), "Add pin at
map center", click-to-add toggle, Export JSON (download), Import JSON (file
input). Clicking a globe point with click-to-add ON (LEFT_CLICK) drops a pin
at the picked ellipsoid point. Every pin becomes a Cesium point entity with a
📍 label; entities re-render from storage on attach and on every notebook
change, so pins survive reload.

## 2. Storage backend interface (the swap point)

```js
// Any backend implementing this drops into createNotebook({ backend }):
{
  list(),          // -> pin[]  (newest first)
  add(pin),        // -> pin   (throws on invalid/limit)
  update(id, patch), // -> pin | null
  remove(id),      // -> boolean
}
// Optional: getStorageInfo() -> { kind, persistent, count, ... }
```

Pin schema: `{ id, lat, lon, title, body, kind:'note', createdAt, updatedAt }`.

Default is `createLocalStorageBackend({ storage?, key? })` under
`satwq.planetary-notebook.v1`. Corrupt payloads are quarantined to
`<key>.corrupt.<ts>` and the notebook starts empty — never a crash.
Hard cap: 500 pins (`NOTEBOOK_MAX_PINS`).

## 3. Cloudflare KV swap (documented, not implemented)

The app already runs on Cloudflare Pages. To move notebook storage to KV:

1. Create the KV-backed API in a NEW file (e.g. `api/notebook.js`) exposing
   `GET/PUT/DELETE /api/notebook` per-pin JSON behind the app's auth.
2. Swap the backend — one line, nothing else changes:

```js
import { createNotebook, backendFromAsync } from '../annotations/notebook.js';

const kvBackend = {
  list: async () => (await (await fetch('/api/notebook')).json()).pins,
  add: async (pin) => { await fetch('/api/notebook', { method: 'PUT', body: JSON.stringify(pin) }); },
  update: async (id, patch) => { await fetch(`/api/notebook/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); },
  remove: async (id) => { await fetch(`/api/notebook/${id}`, { method: 'DELETE' }); },
};

const notebook = createNotebook({ backend: backendFromAsync(kvBackend) });
```

`backendFromAsync` keeps a write-through memory cache: reads stay synchronous
(the panel never awaits), writes apply instantly locally and flush to KV in
the background. A failed flush never breaks the UI; the storage badge shows
`hydrated:false` until the first successful list.

## 4. Export / import

```js
const json = notebook.exportJSON();          // { format:'satwq-planetary-notebook', version:1, pins:[...] }
const { imported, skipped } = notebook.importJSON(json);
```

Import is idempotent on pin ids (duplicates skipped), invalid pins skipped
with a count — never throws past garbage.

## 5. Tests

```bash
cd ~/workspace/gods-eye-view
node --test src/annotations/notebook.test.mjs
# or: npm test   (auto-discovered)
node --check src/annotations/notebook.js src/annotations/notebookPanel.js
```

The panel module needs a DOM for `mount()`; its entity factory and notebook
core are covered by the storage tests. For DOM-level panel tests, the repo's
browser test harness can import `createNotebookPanel` with a jsdom-like
document (not included — no new deps allowed).
