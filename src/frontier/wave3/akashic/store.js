/**
 * Akashic Records — day-keyed store.
 *
 * Backend-agnostic: the store talks to a tiny {getItem,setItem,removeItem,keys}
 * adapter. `createLocalStorageBackend()` wraps window.localStorage;
 * `createMemoryBackend()` is the pure fallback (and what node tests use).
 * Records live under one key per day: `satwq.akashic.<YYYY-MM-DD>`.
 */
import { dayKey, validateRecord } from './schema.js';

export const STORAGE_PREFIX = 'satwq.akashic.';
export const META_KEY = `${STORAGE_PREFIX}meta`;

/** In-memory adapter with the same surface as the storage wrapper. */
export function createMemoryBackend() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
  };
}

/**
 * Wrap a Web Storage object (localStorage). Pass `null`/`undefined` to get a
 * memory backend instead — the store never throws on missing storage.
 */
export function createLocalStorageBackend(storage) {
  if (!storage || typeof storage.getItem !== 'function') return createMemoryBackend();
  return {
    getItem: (k) => {
      try {
        return storage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        storage.setItem(k, String(v));
      } catch {
        /* quota full or denied — archive degrades silently */
      }
    },
    removeItem: (k) => {
      try {
        storage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
    keys: () => {
      const out = [];
      try {
        for (let i = 0; i < storage.length; i += 1) {
          const k = storage.key(i);
          if (k) out.push(k);
        }
      } catch {
        /* ignore */
      }
      return out;
    },
  };
}

function dayStorageKey(day) {
  return `${STORAGE_PREFIX}${day}`;
}

function readDay(backend, day) {
  let raw = null;
  try {
    raw = backend.getItem(dayStorageKey(day));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((rec) => validateRecord(rec) === null);
  } catch {
    return [];
  }
}

function writeDay(backend, day, records) {
  try {
    backend.setItem(dayStorageKey(day), JSON.stringify(records));
  } catch {
    /* fail-soft */
  }
}

/**
 * Day-keyed event archive.
 *
 * @param {{backend?, maxDays?}} opts — maxDays caps retention (default 120).
 */
export function createAkashicStore({ backend, maxDays = 120 } = {}) {
  const store = backend || createMemoryBackend();

  function days() {
    const seen = new Set();
    for (const k of store.keys()) {
      if (k.startsWith(STORAGE_PREFIX) && k !== META_KEY) seen.add(k.slice(STORAGE_PREFIX.length));
    }
    return [...seen].sort();
  }

  /** Archive one record. Returns 'added' | 'duplicate' | 'invalid'. */
  function archive(rec) {
    const problem = validateRecord(rec);
    if (problem) return 'invalid';
    const list = readDay(store, rec.day);
    if (list.some((r) => r.id === rec.id)) return 'duplicate';
    list.push(rec);
    list.sort((a, b) => a.atMs - b.atMs);
    writeDay(store, rec.day, list);
    return 'added';
  }

  function eventsForDay(day) {
    return readDay(store, day);
  }

  /** Drop days older than maxDays. Returns the number of days removed. */
  function prune(nowMs = Date.now()) {
    const today = dayKey(nowMs);
    if (!today) return 0;
    let removed = 0;
    for (const day of days()) {
      if (day < todayMinus(maxDays, today)) {
        store.removeItem(dayStorageKey(day));
        removed += 1;
      }
    }
    return removed;
  }

  function todayMinus(n, today) {
    const start = Date.parse(`${today}T00:00:00.000Z`);
    return new Date(start - n * 86_400_000).toISOString().slice(0, 10);
  }

  function clear() {
    for (const day of days()) store.removeItem(dayStorageKey(day));
  }

  return { days, archive, eventsForDay, prune, clear };
}
