/**
 * @module indoor/persistence
 * @description localStorage persistence for the indoor twin. Storage is
 * duck-typed ({getItem,setItem,removeItem}) and injected so the module works
 * headless in tests. Zero infra: no server, no keys, the plan lives in the
 * browser that mapped it.
 */

/** localStorage key for the indoor twin state. */
export const INDOOR_STORAGE_KEY = 'satwq.indoor.v1';

/** Schema version; bump when the persisted shape changes. */
export const INDOOR_STATE_VERSION = 1;

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return globalThis.localStorage;
    }
  } catch {
    // localStorage access can throw (private mode); treat as absent.
  }
  return null;
}

/**
 * Serialize indoor state for storage. Only plain-data fields are kept so the
 * record survives JSON round-trips.
 */
export function serializeIndoorState(state) {
  return {
    version: INDOOR_STATE_VERSION,
    rooms: (state.rooms || []).map((room) => ({
      id: room.id,
      x: room.x,
      y: room.y,
      w: room.w,
      h: room.h,
      label: room.label || '',
      doors: (room.doors || []).map((d) => ({
        wall: d.wall,
        offset: d.offset,
        width: d.width,
      })),
    })),
    devices: (state.devices || []).map((device) => ({
      id: device.id,
      type: device.type,
      x: device.x,
      y: device.y,
      label: device.label || '',
      notes: device.notes || '',
    })),
    view: {
      panX: state.view?.panX ?? 0,
      panY: state.view?.panY ?? 0,
      zoom: state.view?.zoom ?? 1,
    },
  };
}

/** Save state; returns true on success, false when storage is unavailable. */
export function saveIndoorState(state, storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(
      INDOOR_STORAGE_KEY,
      JSON.stringify(serializeIndoorState(state)),
    );
    return true;
  } catch {
    return false; // Quota exceeded, etc. — fail soft, the editor keeps running.
  }
}

/**
 * Load state; returns null when nothing is stored or the record is corrupt.
 * Corrupt records are left in place (never silently wiped); the caller may
 * offer a reset via clearIndoorState().
 */
export function loadIndoorState(storage) {
  const store = resolveStorage(storage);
  if (!store) return null;
  let raw = null;
  try {
    raw = store.getItem(INDOOR_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.version !== INDOOR_STATE_VERSION
    ) {
      return null;
    }
    return {
      version: parsed.version,
      rooms: Array.isArray(parsed.rooms) ? parsed.rooms : [],
      devices: Array.isArray(parsed.devices) ? parsed.devices : [],
      view: {
        panX: Number(parsed.view?.panX) || 0,
        panY: Number(parsed.view?.panY) || 0,
        zoom: Number(parsed.view?.zoom) > 0 ? Number(parsed.view.zoom) : 1,
      },
    };
  } catch {
    return null;
  }
}

/** Remove the stored state. Returns true on success. */
export function clearIndoorState(storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.removeItem(INDOOR_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
