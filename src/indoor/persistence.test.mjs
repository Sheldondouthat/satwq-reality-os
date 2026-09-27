import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  saveIndoorState,
  loadIndoorState,
  clearIndoorState,
  serializeIndoorState,
  INDOOR_STORAGE_KEY,
  INDOOR_STATE_VERSION,
} from './persistence.js';

/** Minimal in-memory Storage double. */
function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: (k) => map.get(k),
  };
}

const SAMPLE = {
  rooms: [
    {
      id: 'room-1',
      x: 10,
      y: 20,
      w: 100,
      h: 80,
      label: 'Living',
      doors: [{ wall: 'n', offset: 50, width: 36 }],
    },
  ],
  devices: [
    { id: 'dev-1', type: 'camera', x: 30, y: 40, label: 'Porch cam', notes: 'night' },
  ],
  view: { panX: 5, panY: 6, zoom: 1.5 },
};

test('persistence round-trips rooms, devices, doors, and view', () => {
  const storage = mockStorage();
  assert.equal(saveIndoorState(SAMPLE, storage), true);
  const loaded = loadIndoorState(storage);
  assert.equal(loaded.version, INDOOR_STATE_VERSION);
  assert.deepEqual(loaded.rooms, SAMPLE.rooms);
  assert.deepEqual(loaded.devices, SAMPLE.devices);
  assert.deepEqual(loaded.view, SAMPLE.view);
  // Stored under the documented key as JSON.
  const raw = JSON.parse(storage._raw(INDOOR_STORAGE_KEY));
  assert.equal(raw.version, INDOOR_STATE_VERSION);
});

test('load returns null for empty, corrupt, or wrong-version records', () => {
  const storage = mockStorage();
  assert.equal(loadIndoorState(storage), null); // nothing stored
  storage.setItem(INDOOR_STORAGE_KEY, 'not-json{{{');
  assert.equal(loadIndoorState(storage), null); // corrupt: no throw
  storage.setItem(INDOOR_STORAGE_KEY, JSON.stringify({ version: 999, rooms: [] }));
  assert.equal(loadIndoorState(storage), null); // version mismatch
});

test('corrupt records are not wiped by a failed load', () => {
  const storage = mockStorage();
  storage.setItem(INDOOR_STORAGE_KEY, 'broken');
  assert.equal(loadIndoorState(storage), null);
  assert.equal(storage._raw(INDOOR_STORAGE_KEY), 'broken');
});

test('save/load fail soft when storage is unavailable', () => {
  assert.equal(saveIndoorState(SAMPLE, null), false);
  assert.equal(loadIndoorState(null), null);
  assert.equal(clearIndoorState(null), false);
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  assert.equal(saveIndoorState(SAMPLE, throwing), false);
  assert.equal(loadIndoorState(throwing), null);
});

test('clearIndoorState removes the record', () => {
  const storage = mockStorage();
  saveIndoorState(SAMPLE, storage);
  assert.equal(clearIndoorState(storage), true);
  assert.equal(loadIndoorState(storage), null);
});

test('serialize strips non-plain fields and defaults missing view', () => {
  const out = serializeIndoorState({ rooms: [], devices: [] });
  assert.deepEqual(out.view, { panX: 0, panY: 0, zoom: 1 });
  assert.deepEqual(out.rooms, []);
});
