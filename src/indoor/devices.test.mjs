import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDevice,
  moveDevice,
  updateDevice,
  deleteDevice,
  deviceAt,
  DEVICE_TYPES,
  DEVICE_TYPE_IDS,
} from './devices.js';

test('device type catalog covers camera/sensor/hub', () => {
  assert.deepEqual([...DEVICE_TYPE_IDS].sort(), ['camera', 'hub', 'sensor']);
  for (const id of DEVICE_TYPE_IDS) {
    assert.ok(DEVICE_TYPES[id].label);
    assert.ok(DEVICE_TYPES[id].glyph);
  }
});

test('createDevice defaults label to type label; rejects unknown types', () => {
  const cam = createDevice({ type: 'camera', x: 10, y: 20 });
  assert.equal(cam.label, 'Camera');
  assert.equal(cam.notes, '');
  assert.match(cam.id, /^dev-/);
  const named = createDevice({ type: 'hub', x: 0, y: 0, label: 'Main hub', notes: 'hallway' });
  assert.equal(named.label, 'Main hub');
  assert.equal(named.notes, 'hallway');
  assert.throws(() => createDevice({ type: 'toaster', x: 0, y: 0 }), /Unknown device type/);
});

test('moveDevice / updateDevice are immutable updates', () => {
  const d = createDevice({ type: 'sensor', x: 10, y: 20 });
  const moved = moveDevice(d, 5, -5);
  assert.deepEqual([moved.x, moved.y], [15, 15]);
  assert.deepEqual([d.x, d.y], [10, 20]);
  const renamed = updateDevice(d, { label: 'PIR' });
  assert.equal(renamed.label, 'PIR');
  assert.equal(renamed.notes, '');
  assert.equal(d.label, 'Sensor');
  const noted = updateDevice(d, { notes: 'corner' });
  assert.equal(noted.notes, 'corner');
  assert.equal(noted.label, 'Sensor'); // unspecified fields preserved
});

test('deviceAt returns the topmost marker within radius', () => {
  const a = createDevice({ type: 'camera', x: 100, y: 100 });
  const b = createDevice({ type: 'sensor', x: 105, y: 105 });
  assert.equal(deviceAt([a, b], 102, 102).id, b.id); // topmost wins
  assert.equal(deviceAt([a, b], 100, 100, 2).id, a.id); // radius respected
  assert.equal(deviceAt([a, b], 500, 500), null);
});

test('deleteDevice removes by id only', () => {
  const a = createDevice({ type: 'camera', x: 0, y: 0 });
  const b = createDevice({ type: 'hub', x: 0, y: 0 });
  const rest = deleteDevice([a, b], a.id);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].id, b.id);
});
