/**
 * Akashic Records — persistence.
 *
 * Events live in IndexedDB (`akashic-db` / `events`, keyPath `id`) so the
 * planetary log survives reloads. When IndexedDB is unavailable (private
 * mode, old browsers, test runners) the store fails soft to an in-memory
 * backend with the same async interface — recording keeps working, it just
 * does not survive reload.
 *
 * The store caps the log at `cap` events (default 10k) and prunes the oldest
 * first. No DOM, no Cesium, no network.
 */
import {
  AKASHIC_MAX_EVENTS,
  compareEventsOldestFirst,
  isAkashicEvent,
} from './schema.js';

const DB_NAME = 'akashic-db';
const STORE_NAME = 'events';
const DB_VERSION = 1;

/** In-memory backend: same async shape as the IndexedDB backend. */
export function createMemoryBackend() {
  const map = new Map();
  return {
    kind: 'memory',
    async getAll() {
      return [...map.values()].sort(compareEventsOldestFirst);
    },
    async put(events) {
      for (const e of events) map.set(e.id, e);
    },
    async has(id) {
      return map.has(id);
    },
    async deleteIds(ids) {
      for (const id of ids) map.delete(id);
    },
    async clear() {
      map.clear();
    },
    async count() {
      return map.size;
    },
  };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('time', 'time', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB backend. Every method fails soft (throws -> caller degrades). */
export function createIndexedDbBackend() {
  let dbPromise = null;
  const db = () => (dbPromise ??= openDatabase());
  const tx = async (mode) => {
    const database = await db();
    return database.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  };
  return {
    kind: 'indexeddb',
    async getAll() {
      const store = await tx('readonly');
      return idbRequest(store.getAll());
    },
    async put(events) {
      const store = await tx('readwrite');
      await Promise.all(events.map((e) => idbRequest(store.put(e))));
    },
    async has(id) {
      const store = await tx('readonly');
      const value = await idbRequest(store.getKey(id));
      return value !== undefined;
    },
    async deleteIds(ids) {
      const store = await tx('readwrite');
      await Promise.all(ids.map((id) => idbRequest(store.delete(id))));
    },
    async clear() {
      const store = await tx('readwrite');
      await idbRequest(store.clear());
    },
    async count() {
      const store = await tx('readonly');
      return idbRequest(store.count());
    },
  };
}

/**
 * Create the Akashic event store.
 * @param {object} [options]
 * @param {number} [options.cap] Max events retained (default 10k).
 * @param {object} [options.backend] Injected backend (tests). Otherwise auto-detect.
 */
export function createAkashicStore({
  cap = AKASHIC_MAX_EVENTS,
  backend = null,
} = {}) {
  const maxEvents = Math.max(1, Math.floor(Number(cap) || AKASHIC_MAX_EVENTS));
  let activeBackend = backend;
  let degraded = false;

  async function ensureBackend() {
    if (activeBackend) return activeBackend;
    try {
      const idb = createIndexedDbBackend();
      await idb.count(); // probe: throws when IDB is unusable
      activeBackend = idb;
    } catch {
      degraded = true;
      activeBackend = createMemoryBackend();
    }
    return activeBackend;
  }

  /** Insert events, skipping ids already recorded. Returns count of new events. */
  async function recordEvents(events) {
    const store = await ensureBackend();
    const fresh = [];
    for (const event of events) {
      if (!isAkashicEvent(event)) continue;
      if (await store.has(event.id)) continue;
      fresh.push(event);
    }
    if (fresh.length) await store.put(fresh);
    await prune(store);
    return fresh.length;
  }

  /** Drop oldest events beyond the cap. */
  async function prune(store) {
    const total = await store.count();
    if (total <= maxEvents) return 0;
    const all = await store.getAll();
    all.sort(compareEventsOldestFirst);
    const victims = all.slice(0, total - maxEvents).map((e) => e.id);
    await store.deleteIds(victims);
    return victims.length;
  }

  return {
    /** 'indexeddb' | 'memory' | 'unknown' (before first use). */
    get backendKind() {
      return activeBackend ? activeBackend.kind : 'unknown';
    },
    get degraded() {
      return degraded;
    },
    recordEvents,
    async getAll() {
      return ensureBackend().then((store) => store.getAll());
    },
    async getRange(startMs, endMs) {
      const all = await this.getAll();
      return all.filter((e) => e.time >= startMs && e.time <= endMs);
    },
    async count() {
      return ensureBackend().then((store) => store.count());
    },
    async clear() {
      return ensureBackend().then((store) => store.clear());
    },
    async exportJson() {
      const all = await this.getAll();
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          count: all.length,
          events: all,
        },
        null,
        2,
      );
    },
  };
}
