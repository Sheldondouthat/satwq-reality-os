import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNotebook,
  createMemoryBackend,
  createLocalStorageBackend,
  backendFromAsync,
  NOTEBOOK_STORAGE_KEY,
  NOTEBOOK_MAX_PINS,
} from './notebook.js';

const PIN = { lat: 40.0, lon: -121.0, title: 'Test note', body: 'hello' };

const mockStorage = () => {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
};

test('CRUD: add/list/update/remove with mock storage', () => {
  const nb = createNotebook({ backend: createLocalStorageBackend({ storage: mockStorage() }) });
  assert.deepEqual(nb.list(), []);
  const pin = nb.add(PIN);
  assert.ok(pin.id.startsWith('nb_'));
  assert.equal(pin.title, 'Test note');
  assert.equal(pin.kind, 'note');
  assert.equal(nb.list().length, 1);

  const updated = nb.update(pin.id, { title: 'Renamed', body: 'new body' });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.body, 'new body');
  assert.equal(updated.lat, 40.0, 'untouched fields survive');
  assert.ok(updated.updatedAt >= pin.createdAt);

  assert.equal(nb.remove(pin.id), true);
  assert.equal(nb.remove(pin.id), false, 'double remove is false');
  assert.deepEqual(nb.list(), []);
});

test('pins persist across backend instances (reload survival)', () => {
  const storage = mockStorage();
  const a = createNotebook({ backend: createLocalStorageBackend({ storage }) });
  a.add(PIN);
  a.add({ lat: 41, lon: -122, title: 'Second' });
  const b = createNotebook({ backend: createLocalStorageBackend({ storage }) });
  const pins = b.list();
  assert.equal(pins.length, 2);
  assert.ok(pins.some((p) => p.title === 'Second'), 'survives reload');
  assert.ok(storage._data.get(NOTEBOOK_STORAGE_KEY).includes('Test note'));
});

test('corrupt localStorage is quarantined, never crashes', () => {
  const storage = mockStorage();
  storage.setItem(NOTEBOOK_STORAGE_KEY, '{not json');
  const nb = createNotebook({ backend: createLocalStorageBackend({ storage }) });
  assert.deepEqual(nb.list(), [], 'starts empty');
  assert.equal(storage.getItem(NOTEBOOK_STORAGE_KEY), null, 'corrupt payload moved aside');
  const keys = [...storage._data.keys()].filter((k) => k.includes('.corrupt.'));
  assert.equal(keys.length, 1, 'corrupt payload preserved for forensics');
  // Notebook still works after quarantine.
  nb.add(PIN);
  assert.equal(nb.list().length, 1);
});

test('validation: garbage coordinates rejected, titles defaulted', () => {
  const nb = createNotebook({ backend: createMemoryBackend() });
  assert.throws(() => nb.add({ lat: 91, lon: 0 }), /invalid pin/);
  assert.throws(() => nb.add({ lat: 'x', lon: 0 }), /invalid pin/);
  const pin = nb.add({ lat: 0, lon: 0, title: '   ', body: 12345 });
  assert.equal(pin.title, 'Untitled note');
  assert.equal(pin.body, '', 'non-string body coerced');
  assert.equal(nb.update(pin.id, { lat: 999 }), null, 'invalid patch rejected');
});

test('pin limit is enforced', () => {
  const nb = createNotebook({ backend: createMemoryBackend() });
  assert.equal(NOTEBOOK_MAX_PINS, 500);
  for (let i = 0; i < NOTEBOOK_MAX_PINS; i++) {
    nb.add({ lat: 0, lon: (i % 360) - 180, title: `p${i}` });
  }
  assert.throws(() => nb.add({ lat: 0, lon: 0 }), /pin limit/);
});

test('export/import round-trips; duplicates and garbage skipped', () => {
  const a = createNotebook({ backend: createMemoryBackend() });
  a.add(PIN);
  const json = a.exportJSON();
  const doc = JSON.parse(json);
  assert.equal(doc.format, 'satwq-planetary-notebook');
  assert.equal(doc.version, 1);

  const b = createNotebook({ backend: createMemoryBackend() });
  const r1 = b.importJSON(json);
  assert.deepEqual(r1, { imported: 1, skipped: 0 });
  const r2 = b.importJSON(json);
  assert.deepEqual(r2, { imported: 0, skipped: 1 }, 'duplicate id skipped');

  const dirty = JSON.stringify({ pins: [{ lat: 10, lon: 10, title: 'ok' }, { lat: 999, lon: 0 }, 'junk'] });
  const r3 = b.importJSON(dirty);
  assert.deepEqual(r3, { imported: 1, skipped: 2 });

  assert.throws(() => b.importJSON('not json'), /not valid JSON/);
  assert.throws(() => b.importJSON('{"nope":true}'), /no pins array/);
});

test('onChange notifies; clear empties', () => {
  const nb = createNotebook({ backend: createMemoryBackend() });
  const events = [];
  const off = nb.onChange((e) => events.push(e.type));
  const pin = nb.add(PIN);
  nb.update(pin.id, { title: 'x' });
  nb.remove(pin.id);
  assert.deepEqual(events, ['add', 'update', 'remove']);
  nb.add(PIN);
  assert.equal(nb.clear(), 1);
  assert.deepEqual(nb.list(), []);
  off();
});

test('backendFromAsync wraps a KV-style promise backend with sync reads', async () => {
  const kv = new Map();
  const asyncBackend = {
    list: async () => [...kv.values()],
    add: async (pin) => kv.set(pin.id, pin),
    update: async (id, patch) => {
      const p = kv.get(id);
      if (p) kv.set(id, { ...p, ...patch });
    },
    remove: async (id) => kv.delete(id),
  };
  const nb = createNotebook({ backend: backendFromAsync(asyncBackend) });
  const pin = nb.add(PIN);
  assert.equal(nb.list().length, 1, 'synchronous read from cache');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(kv.has(pin.id), 'write flushed to async backend');
  const info = nb.getStorageInfo();
  assert.equal(info.kind, 'async-backed');
});
