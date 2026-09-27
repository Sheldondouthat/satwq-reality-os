import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRoom,
  moveRoom,
  resizeRoom,
  pointInRoom,
  roomAt,
  hitHandle,
  deleteRoom,
  nearestWall,
  addDoor,
  deleteDoor,
  doorSegment,
  worldToScreen,
  screenToWorld,
  MIN_ROOM_SIZE,
} from './floorplan.js';

test('createRoom normalizes negative drag deltas into x/y/w/h', () => {
  const room = createRoom({ x: 100, y: 100, w: -60, h: -40 }, 'Kitchen');
  assert.equal(room.x, 40);
  assert.equal(room.y, 60);
  assert.equal(room.w, 60);
  assert.equal(room.h, 40);
  assert.equal(room.label, 'Kitchen');
  assert.deepEqual(room.doors, []);
  assert.match(room.id, /^room-/);
});

test('moveRoom translates without mutating the original', () => {
  const room = createRoom({ x: 10, y: 20, w: 50, h: 60 });
  const moved = moveRoom(room, 5, -7);
  assert.equal(moved.x, 15);
  assert.equal(moved.y, 13);
  assert.equal(room.x, 10); // untouched
});

test('resizeRoom grows/shrinks from each corner handle', () => {
  const room = createRoom({ x: 100, y: 100, w: 80, h: 60 });
  const se = resizeRoom(room, 'se', 20, 10);
  assert.deepEqual([se.x, se.y, se.w, se.h], [100, 100, 100, 70]);
  const nw = resizeRoom(room, 'nw', 20, 10);
  assert.deepEqual([nw.x, nw.y, nw.w, nw.h], [120, 110, 60, 50]);
  const n = resizeRoom(room, 'n', 999, -15);
  assert.deepEqual([n.x, n.y, n.w, n.h], [100, 85, 80, 75]);
  const e = resizeRoom(room, 'e', -30, 0);
  assert.deepEqual([e.x, e.y, e.w, e.h], [100, 100, 50, 60]);
});

test('resizeRoom clamps to MIN_ROOM_SIZE and rejects bad handles', () => {
  const room = createRoom({ x: 100, y: 100, w: 80, h: 60 });
  const tiny = resizeRoom(room, 'nw', 1000, 1000);
  assert.equal(tiny.w, MIN_ROOM_SIZE);
  assert.equal(tiny.h, MIN_ROOM_SIZE);
  // West-edge anchor stays glued when clamped.
  assert.equal(tiny.x + tiny.w, 180);
  assert.equal(tiny.y + tiny.h, 160);
  const same = resizeRoom(room, 'bogus', 10, 10);
  assert.deepEqual([same.x, same.y, same.w, same.h], [100, 100, 80, 60]);
});

test('pointInRoom / roomAt: edges inclusive, last room is topmost', () => {
  const a = createRoom({ x: 0, y: 0, w: 100, h: 100 }, 'A');
  const b = createRoom({ x: 50, y: 50, w: 100, h: 100 }, 'B');
  assert.equal(pointInRoom(a, 0, 0), true);
  assert.equal(pointInRoom(a, 100, 100), true);
  assert.equal(pointInRoom(a, 101, 50), false);
  assert.equal(roomAt([a, b], 75, 75).label, 'B');
  assert.equal(roomAt([a, b], 25, 25).label, 'A');
  assert.equal(roomAt([a, b], 500, 500), null);
});

test('hitHandle finds corners, edges, interior, and misses', () => {
  const room = createRoom({ x: 100, y: 100, w: 80, h: 60 });
  assert.equal(hitHandle(room, 100, 100), 'nw');
  assert.equal(hitHandle(room, 180, 160), 'se');
  assert.equal(hitHandle(room, 140, 100), 'n');
  assert.equal(hitHandle(room, 180, 130), 'e');
  assert.equal(hitHandle(room, 140, 130), 'move');
  assert.equal(hitHandle(room, 10, 10), null);
  // Tolerance respected.
  assert.equal(hitHandle(room, 100, 100, 2), 'nw');
  assert.equal(hitHandle(room, 104, 104, 2), 'move');
});

test('deleteRoom removes by id only', () => {
  const a = createRoom({ x: 0, y: 0, w: 10, h: 10 });
  const b = createRoom({ x: 0, y: 0, w: 10, h: 10 });
  const rest = deleteRoom([a, b], a.id);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].id, b.id);
});

test('nearestWall identifies wall and offset for door placement', () => {
  const room = createRoom({ x: 100, y: 100, w: 200, h: 120 });
  assert.deepEqual(nearestWall(room, 150, 103), { wall: 'n', offset: 50 });
  assert.deepEqual(nearestWall(room, 297, 160), { wall: 'e', offset: 60 });
  assert.equal(nearestWall(room, 400, 400), null); // far from any wall
  assert.equal(nearestWall(room, 500, 103), null); // off the wall's span
});

test('addDoor clamps offset, doorSegment maps to plan coordinates', () => {
  const room = createRoom({ x: 100, y: 100, w: 200, h: 120 });
  const withDoor = addDoor(room, 'n', 50, 40);
  assert.equal(withDoor.doors.length, 1);
  assert.deepEqual(withDoor.doors[0], { wall: 'n', offset: 50, width: 40 });
  assert.equal(room.doors.length, 0); // immutable
  const seg = doorSegment(withDoor, withDoor.doors[0]);
  assert.deepEqual(seg, { x1: 130, y1: 100, x2: 170, y2: 100 });

  const south = doorSegment(withDoor, addDoor(room, 's', 10, 30).doors[0]);
  assert.deepEqual(south, { x1: 95, y1: 220, x2: 125, y2: 220 });
  const west = doorSegment(withDoor, addDoor(room, 'w', 60, 30).doors[0]);
  assert.deepEqual(west, { x1: 100, y1: 145, x2: 100, y2: 175 });

  // Offset clamped to wall length.
  const clamped = addDoor(room, 'n', 9999);
  assert.equal(clamped.doors[0].offset, 200);
  assert.throws(() => addDoor(room, 'roof', 10), /Invalid door wall/);

  const removed = deleteDoor(withDoor, 0);
  assert.equal(removed.doors.length, 0);
});

test('worldToScreen / screenToWorld are inverses', () => {
  const view = { panX: 40, panY: 60, zoom: 2 };
  const s = worldToScreen(view, 100, 50);
  assert.deepEqual(s, { x: 240, y: 160 });
  const w = screenToWorld(view, s.x, s.y);
  assert.ok(Math.abs(w.x - 100) < 1e-9 && Math.abs(w.y - 50) < 1e-9);
});
