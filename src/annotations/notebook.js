/**
 * F10 planetary notebook — coordinate-pinned user annotations.
 *
 * Storage-only core: no Cesium, no DOM. The pin schema is backend-agnostic:
 *
 *   { id, lat, lon, title, body, kind, createdAt, updatedAt }
 *
 * Storage backend interface (duck-typed; all methods synchronous):
 *   { list() -> pin[], add(pin) -> pin, update(id, patch) -> pin|null,
 *     remove(id) -> boolean }
 *
 * Default: localStorageBackend (zero infra). The documented swap point for a
 * future Cloudflare KV backend is `createNotebook({ backend })` — any object
 * implementing the interface drops in with no other changes. A synchronous
 * async wrapper (`backendFromAsync`) is provided for KV-style promise
 * backends; INTEGRATION.md has the exact swap snippet.
 */

export const NOTEBOOK_STORAGE_KEY = 'satwq.planetary-notebook.v1';
export const NOTEBOOK_MAX_PINS = 500;

const now = () => Date.now();
const uid = () =>
  `nb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

function sanitizePin(raw) {
  const lat = Number(raw?.lat);
  const lon = Number(raw?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const title =
    typeof raw?.title === 'string' && raw.title.trim()
      ? raw.title.trim().slice(0, 140)
      : 'Untitled note';
  const body = typeof raw?.body === 'string' ? raw.body.slice(0, 4000) : '';
  const createdAt = Number.isFinite(raw?.createdAt) ? raw.createdAt : now();
  const updatedAt = Number.isFinite(raw?.updatedAt) ? raw.updatedAt : createdAt;
  return {
    id:
      typeof raw?.id === 'string' && raw.id
        ? String(raw.id).slice(0, 64)
        : uid(),
    lat,
    lon,
    title,
    body,
    kind: 'note',
    createdAt,
    updatedAt,
  };
}

/** In-memory backend — the test double and the KV adapter's offline fallback. */
export function createMemoryBackend(seed = []) {
  const pins = new Map();
  for (const raw of seed) {
    const pin = sanitizePin(raw);
    if (pin) pins.set(pin.id, pin);
  }
  return {
    list: () => [...pins.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    add: (pin) => {
      const clean = sanitizePin(pin);
      if (!clean) throw new Error('notebook: invalid pin');
      if (pins.size >= NOTEBOOK_MAX_PINS)
        throw new Error('notebook: pin limit reached');
      pins.set(clean.id, clean);
      return clean;
    },
    update: (id, patch) => {
      const prev = pins.get(id);
      if (!prev) return null;
      const clean = sanitizePin({
        ...prev,
        ...patch,
        id,
        createdAt: prev.createdAt,
        updatedAt: now(),
      });
      if (!clean) return null; // invalid patch: no change, not an exception
      pins.set(id, clean);
      return clean;
    },
    remove: (id) => pins.delete(id),
  };
}

/**
 * localStorage backend — the default. Corrupt payloads are quarantined
 * (renamed aside, notebook starts empty) rather than crashing the app.
 */
export function createLocalStorageBackend({
  storage = null,
  key = NOTEBOOK_STORAGE_KEY,
} = {}) {
  const store =
    storage ??
    (typeof globalThis.localStorage !== 'undefined'
      ? globalThis.localStorage
      : null);
  if (!store) return createMemoryBackend(); // honest fallback: no persistence
  const read = () => {
    let raw = null;
    try {
      raw = store.getItem(key);
    } catch {
      return [];
    }
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      return parsed.map(sanitizePin).filter(Boolean);
    } catch {
      try {
        store.setItem(`${key}.corrupt.${Date.now()}`, raw);
        store.removeItem(key);
      } catch {
        /* best effort */
      }
      return [];
    }
  };
  const write = (pins) => {
    try {
      store.setItem(key, JSON.stringify(pins));
    } catch {
      /* quota/full: keep serving from memory; surfaced via getStats */
    }
  };
  const mem = createMemoryBackend(read());
  return {
    list: mem.list,
    add: (pin) => {
      const added = mem.add(pin);
      write(mem.list());
      return added;
    },
    update: (id, patch) => {
      const updated = mem.update(id, patch);
      if (updated) write(mem.list());
      return updated;
    },
    remove: (id) => {
      const removed = mem.remove(id);
      if (removed) write(mem.list());
      return removed;
    },
    /** Introspection for the panel's storage badge. */
    getStorageInfo: () => ({
      kind: 'localStorage',
      key,
      persistent: true,
      count: mem.list().length,
    }),
  };
}

/**
 * Wrap an async (KV-style) backend in the synchronous interface with a
 * write-through memory cache. Reads are synchronous from cache; writes apply
 * to the cache immediately and flush async in the background.
 * This is the documented swap point for Cloudflare KV (see INTEGRATION.md).
 */
export function backendFromAsync(asyncBackend) {
  const cache = createMemoryBackend();
  let hydrated = false;
  const hydrate = () => {
    if (hydrated) return Promise.resolve();
    return Promise.resolve()
      .then(() => asyncBackend.list())
      .then((pins) => {
        hydrated = true;
        for (const raw of pins ?? []) {
          try {
            cache.add(raw);
          } catch {
            /* skip invalid cached pins */
          }
        }
      })
      .catch(() => {
        hydrated = true; // serve cache on failure; surfaced via getStats
      });
  };
  const flush = (op, ...args) =>
    hydrate()
      .then(() => asyncBackend[op](...args))
      .catch(() => null);
  hydrate();
  return {
    list: cache.list,
    add: (pin) => {
      const added = cache.add(pin);
      flush('add', added);
      return added;
    },
    update: (id, patch) => {
      const updated = cache.update(id, patch);
      if (updated) flush('update', id, patch);
      return updated;
    },
    remove: (id) => {
      const removed = cache.remove(id);
      if (removed) flush('remove', id);
      return removed;
    },
    getStorageInfo: () => ({
      kind: 'async-backed',
      persistent: true,
      hydrated,
      count: cache.list().length,
    }),
  };
}

/** The notebook: CRUD + export/import over any storage backend. */
export function createNotebook({ backend = createLocalStorageBackend() } = {}) {
  if (
    typeof backend?.list !== 'function' ||
    typeof backend?.add !== 'function' ||
    typeof backend?.update !== 'function' ||
    typeof backend?.remove !== 'function'
  ) {
    throw new TypeError(
      'notebook: backend must implement {list,add,update,remove}',
    );
  }
  const listeners = new Set();
  const notify = (event) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        /* listener faults never break CRUD */
      }
    }
  };
  const notebook = {
    list: () => backend.list(),
    get: (id) => backend.list().find((p) => p.id === id) ?? null,

    add({ lat, lon, title, body } = {}) {
      const pin = backend.add({ lat, lon, title, body });
      notify({ type: 'add', pin });
      return pin;
    },

    update(id, patch = {}) {
      const clean = {};
      for (const key of ['lat', 'lon', 'title', 'body']) {
        if (patch[key] !== undefined) clean[key] = patch[key];
      }
      const updated = backend.update(id, clean);
      if (updated) notify({ type: 'update', pin: updated });
      return updated;
    },

    remove(id) {
      const removed = backend.remove(id);
      if (removed) notify({ type: 'remove', id });
      return removed;
    },

    exportJSON() {
      return JSON.stringify(
        {
          format: 'satwq-planetary-notebook',
          version: 1,
          exportedAt: new Date(now()).toISOString(),
          pins: backend.list(),
        },
        null,
        2,
      );
    },

    /**
     * Import a JSON document (from exportJSON or hand-built). Returns
     * { imported, skipped }. Invalid pins are skipped, never thrown past.
     */
    importJSON(jsonText) {
      let doc;
      try {
        doc = JSON.parse(jsonText);
      } catch {
        throw new Error('notebook: import is not valid JSON');
      }
      const pins = Array.isArray(doc) ? doc : doc?.pins;
      if (!Array.isArray(pins))
        throw new Error('notebook: import has no pins array');
      let imported = 0;
      let skipped = 0;
      const existing = new Set(backend.list().map((p) => p.id));
      for (const raw of pins) {
        const clean = sanitizePin(raw);
        if (!clean) {
          skipped += 1;
          continue;
        }
        if (existing.has(clean.id)) {
          skipped += 1; // duplicate id: keep the existing pin
          continue;
        }
        try {
          backend.add(clean);
          existing.add(clean.id);
          imported += 1;
        } catch {
          skipped += 1;
        }
      }
      if (imported) notify({ type: 'import', count: imported });
      return { imported, skipped };
    },

    clear() {
      const ids = backend.list().map((p) => p.id);
      for (const id of ids) backend.remove(id);
      notify({ type: 'clear', count: ids.length });
      return ids.length;
    },

    onChange(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getStorageInfo() {
      return (
        backend.getStorageInfo?.() ?? {
          kind: 'custom',
          persistent: false,
          count: backend.list().length,
        }
      );
    },
  };
  return notebook;
}
