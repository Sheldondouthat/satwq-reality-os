import { test } from 'node:test';
import assert from 'node:assert/strict';
import { railFixture } from '../ui/railTestFixture.mjs';
import {
  mountIndoorView,
  unmountIndoorView,
  createViewToggle,
  INDOOR_TOOLS,
} from './index.js';

function mockStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function pointerEvent(type, { clientX = 0, clientY = 0, button = 0 } = {}) {
  return Object.assign(new Event(type), { clientX, clientY, button });
}

function keyEvent(type, key) {
  return Object.assign(new Event(type), { key });
}

function mountFresh() {
  const f = railFixture();
  const storage = mockStorage();
  const handle = mountIndoorView(f.container, { document: f.document, storage });
  return { f, storage, handle };
}

/** Default view is pan (40,60) zoom 1, so client = world + (40,60). */
const C = (wx, wy) => ({ clientX: wx + 40, clientY: wy + 60 });

function drawRoom(handle, x1, y1, x2, y2) {
  handle.setTool('room');
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(x1, y1)));
  handle.canvas.dispatchEvent(pointerEvent('pointermove', C(x2, y2)));
  handle.canvas.dispatchEvent(pointerEvent('pointerup', C(x2, y2)));
}

test('mount renders into the container and tracks listeners', () => {
  const { f, handle } = mountFresh();
  assert.equal(f.container.children.length, 1);
  assert.equal(handle.el.getAttribute('role'), 'application');
  assert.ok(handle.listenerCount() > 0, 'expected tracked listeners');
  assert.deepEqual(handle.getState().rooms, []);
  unmountIndoorView(handle);
});

test('room tool draws a click-drag rectangle into state', () => {
  const { handle } = mountFresh();
  drawRoom(handle, 100, 100, 260, 200);
  const { rooms, selectedRoomId } = handle.getState();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].x, 100);
  assert.equal(rooms[0].y, 100);
  assert.equal(rooms[0].w, 160);
  assert.equal(rooms[0].h, 100);
  assert.equal(selectedRoomId, rooms[0].id);
  unmountIndoorView(handle);
});

test('tiny drags are discarded, not persisted as degenerate rooms', () => {
  const { handle } = mountFresh();
  drawRoom(handle, 100, 100, 105, 103);
  assert.equal(handle.getState().rooms.length, 0);
  unmountIndoorView(handle);
});

test('select tool moves and resizes rooms via handles', () => {
  const { handle } = mountFresh();
  drawRoom(handle, 100, 100, 260, 200);
  handle.setTool('select');

  // Move: grab interior, drag +20/+20.
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(200, 150)));
  handle.canvas.dispatchEvent(pointerEvent('pointermove', C(220, 170)));
  handle.canvas.dispatchEvent(pointerEvent('pointerup', C(220, 170)));
  let room = handle.getState().rooms[0];
  assert.deepEqual([room.x, room.y], [120, 120]);

  // Resize: grab the se handle at (280,220), drag +20/+20.
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(280, 220)));
  handle.canvas.dispatchEvent(pointerEvent('pointermove', C(300, 240)));
  handle.canvas.dispatchEvent(pointerEvent('pointerup', C(300, 240)));
  room = handle.getState().rooms[0];
  assert.deepEqual([room.x, room.y, room.w, room.h], [120, 120, 180, 120]);
  unmountIndoorView(handle);
});

test('Delete key removes the selected room', () => {
  const { f, handle } = mountFresh();
  drawRoom(handle, 100, 100, 260, 200);
  handle.setTool('select');
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(200, 150)));
  handle.el.dispatchEvent(keyEvent('keydown', 'Delete'));
  const state = handle.getState();
  assert.equal(state.rooms.length, 0);
  assert.equal(state.selectedRoomId, null);
  void f;
  unmountIndoorView(handle);
});

test('door tool adds a wall-gap door to the clicked room', () => {
  const { handle } = mountFresh();
  drawRoom(handle, 100, 100, 300, 200);
  handle.setTool('door');
  // Click just inside the north wall at world (200,103).
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(200, 103)));
  const room = handle.getState().rooms[0];
  assert.equal(room.doors.length, 1);
  assert.equal(room.doors[0].wall, 'n');
  assert.equal(room.doors[0].offset, 100);
  unmountIndoorView(handle);
});

test('device tools place labeled markers', () => {
  const { handle } = mountFresh();
  handle.setTool('device:camera');
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(100, 100)));
  let { devices, selectedDeviceId } = handle.getState();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].type, 'camera');
  assert.deepEqual([devices[0].x, devices[0].y], [100, 100]);
  assert.equal(selectedDeviceId, devices[0].id);

  handle.setTool('device:hub');
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(400, 300)));
  devices = handle.getState().devices;
  assert.equal(devices.length, 2);
  assert.equal(devices[1].type, 'hub');
  unmountIndoorView(handle);
});

test('toolbar buttons switch tools and reflect aria-pressed', () => {
  const { f, handle } = mountFresh();
  const find = (predicate) => f.find(predicate, handle.el);
  const roomBtn = find((n) => n.tagName === 'BUTTON' && n.dataset.tool === 'room');
  assert.ok(roomBtn, 'room tool button exists');
  roomBtn.click();
  assert.equal(handle.getTool(), 'room');
  assert.equal(roomBtn.getAttribute('aria-pressed'), 'true');
  const selectBtn = find((n) => n.tagName === 'BUTTON' && n.dataset.tool === 'select');
  assert.equal(selectBtn.getAttribute('aria-pressed'), 'false');
  assert.ok(INDOOR_TOOLS.includes('pan'));
  unmountIndoorView(handle);
});

test('state persists to storage and restores on a fresh mount', () => {
  const { f, storage } = mountFresh();
  const first = mountIndoorView(f.container, { document: f.document, storage });
  // Storage already holds the room drawn above via autosave-on-commit.
  void first;
  const f2 = railFixture();
  const second = mountIndoorView(f2.container, { document: f2.document, storage });
  // First mount saved nothing (no edits); draw now and re-mount.
  drawRoom(second, 50, 50, 150, 120);
  const f3 = railFixture();
  const third = mountIndoorView(f3.container, { document: f3.document, storage });
  const restored = third.getState();
  assert.equal(restored.rooms.length, 1);
  assert.equal(restored.rooms[0].x, 50);
  unmountIndoorView(second);
  unmountIndoorView(third);
});

test('createViewToggle switches modes and notifies', () => {
  const f = railFixture();
  const seen = [];
  const toggle = createViewToggle({
    document: f.document,
    onSwitch: (mode) => seen.push(mode),
  });
  assert.equal(toggle.getMode(), 'globe');
  const indoorBtn = f.find(
    (n) => n.tagName === 'BUTTON' && n.dataset.viewMode === 'indoor',
    toggle.el,
  );
  indoorBtn.click();
  assert.equal(toggle.getMode(), 'indoor');
  assert.deepEqual(seen, ['indoor']);
  assert.equal(indoorBtn.getAttribute('aria-pressed'), 'true');
  toggle.setMode('globe');
  assert.equal(toggle.getMode(), 'globe');
  assert.deepEqual(seen, ['indoor', 'globe']);
  toggle.setMode('bogus'); // ignored
  assert.equal(toggle.getMode(), 'globe');
});

test('unmount removes all listeners, detaches DOM, and is idempotent', () => {
  const { f, handle } = mountFresh();
  drawRoom(handle, 100, 100, 260, 200);
  const before = handle.listenerCount();
  assert.ok(before > 0);

  unmountIndoorView(handle);
  assert.equal(handle.listenerCount(), 0);
  assert.equal(f.container.children.length, 0);

  // Stale events on the detached canvas change nothing: no leaked handlers.
  const roomsBefore = handle.getState().rooms.length;
  handle.setTool('room');
  handle.canvas.dispatchEvent(pointerEvent('pointerdown', C(10, 10)));
  handle.canvas.dispatchEvent(pointerEvent('pointermove', C(200, 200)));
  handle.canvas.dispatchEvent(pointerEvent('pointerup', C(200, 200)));
  assert.equal(handle.getState().rooms.length, roomsBefore);

  // Second unmount is a safe no-op.
  unmountIndoorView(handle);
  unmountIndoorView(null);
  assert.equal(handle.listenerCount(), 0);
});
