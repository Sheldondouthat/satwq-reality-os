/**
 * @module indoor/floorplan
 * @description Indoor-twin floor-plan model: rooms as axis-aligned rectangles
 * plus door markers. All geometry helpers are pure (no DOM) so they are
 * unit-testable; `renderFloorplan` takes a duck-typed 2D context.
 *
 * Coordinate system: plan pixels at zoom 1, origin top-left. The view layer
 * (index.js) applies pan/zoom before delegating hit-testing here.
 */

let roomSequence = 0;

/** Minimum room edge length in plan pixels; keeps degenerate drags out. */
export const MIN_ROOM_SIZE = 24;

/** Door placement tolerance: how close to a wall a click must be (px). */
export const DOOR_WALL_TOLERANCE = 10;

/** Valid door walls: north/south/east/west. */
export const DOOR_WALLS = Object.freeze(['n', 's', 'e', 'w']);

/**
 * Create a room record.
 * @param {object} rect - {x, y, w, h} (w/h may be negative from drags; normalized).
 * @param {string} [label] - Display label.
 * @returns {object} Room {id, x, y, w, h, label, doors:[]}.
 */
export function createRoom({ x, y, w, h }, label = '') {
  const nx = w < 0 ? x + w : x;
  const ny = h < 0 ? y + h : y;
  return {
    id: `room-${++roomSequence}-${Date.now().toString(36)}`,
    x: nx,
    y: ny,
    w: Math.max(Math.abs(w), 0),
    h: Math.max(Math.abs(h), 0),
    label,
    doors: [],
  };
}

/**
 * Translate a room.
 * @returns {object} New room (immutable update).
 */
export function moveRoom(room, dx, dy) {
  return { ...room, x: room.x + dx, y: room.y + dy };
}

const EDGE_HANDLES = new Set(['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']);

/**
 * Resize a room by dragging a handle.
 * @param {object} room - Room to resize.
 * @param {string} handle - One of n/s/e/w/nw/ne/sw/se.
 * @param {number} dx - Pointer delta x (plan px).
 * @param {number} dy - Pointer delta y (plan px).
 * @returns {object} New room, clamped to MIN_ROOM_SIZE.
 */
export function resizeRoom(room, handle, dx, dy) {
  if (!EDGE_HANDLES.has(handle)) return { ...room };
  let { x, y, w, h } = room;
  if (handle.includes('e')) w += dx;
  if (handle.includes('s')) h += dy;
  if (handle.includes('w')) {
    x += dx;
    w -= dx;
  }
  if (handle.includes('n')) {
    y += dy;
    h -= dy;
  }
  if (w < MIN_ROOM_SIZE) {
    if (handle.includes('w')) x -= MIN_ROOM_SIZE - w;
    w = MIN_ROOM_SIZE;
  }
  if (h < MIN_ROOM_SIZE) {
    if (handle.includes('n')) y -= MIN_ROOM_SIZE - h;
    h = MIN_ROOM_SIZE;
  }
  return { ...room, x, y, w, h };
}

/** True when point (px, py) is inside the room rect (edges inclusive). */
export function pointInRoom(room, px, py) {
  return (
    px >= room.x && px <= room.x + room.w && py >= room.y && py <= room.y + room.h
  );
}

/**
 * Topmost room containing the point (last in array = front).
 * @returns {object|null}
 */
export function roomAt(rooms, px, py) {
  for (let i = rooms.length - 1; i >= 0; i--) {
    if (pointInRoom(rooms[i], px, py)) return rooms[i];
  }
  return null;
}

/** Screen positions of the 8 resize handles for a room. */
export function roomHandles(room) {
  const { x, y, w, h } = room;
  const cx = x + w / 2;
  const cy = y + h / 2;
  return {
    nw: [x, y],
    n: [cx, y],
    ne: [x + w, y],
    e: [x + w, cy],
    se: [x + w, y + h],
    s: [cx, y + h],
    sw: [x, y + h],
    w: [x, cy],
  };
}

/**
 * Hit-test the resize handles / interior of a selected room.
 * @returns {'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'|'move'|null}
 */
export function hitHandle(room, px, py, tolerance = 8) {
  const handles = roomHandles(room);
  for (const [name, [hx, hy]] of Object.entries(handles)) {
    if (Math.abs(px - hx) <= tolerance && Math.abs(py - hy) <= tolerance) {
      return name;
    }
  }
  return pointInRoom(room, px, py) ? 'move' : null;
}

/** Remove a room by id. @returns {object[]} New array. */
export function deleteRoom(rooms, id) {
  return rooms.filter((room) => room.id !== id);
}

/**
 * Determine which wall of a room a point is nearest to (for door placement).
 * @returns {{wall: string, offset: number}|null} offset is px along the wall
 *   from the wall's start (x for n/s walls, y for e/w walls).
 */
export function nearestWall(room, px, py, tolerance = DOOR_WALL_TOLERANCE) {
  const candidates = [
    { wall: 'n', dist: Math.abs(py - room.y), offset: px - room.x, len: room.w },
    { wall: 's', dist: Math.abs(py - (room.y + room.h)), offset: px - room.x, len: room.w },
    { wall: 'w', dist: Math.abs(px - room.x), offset: py - room.y, len: room.h },
    { wall: 'e', dist: Math.abs(px - (room.x + room.w)), offset: py - room.y, len: room.h },
  ];
  let best = null;
  for (const c of candidates) {
    if (c.dist <= tolerance && c.offset >= 0 && c.offset <= c.len) {
      if (!best || c.dist < best.dist) best = c;
    }
  }
  return best ? { wall: best.wall, offset: best.offset } : null;
}

/**
 * Add a door marker to a room.
 * @param {object} room - Room to modify.
 * @param {string} wall - One of n/s/e/w.
 * @param {number} offset - Px along the wall from its start.
 * @param {number} [width=36] - Door opening width in plan px.
 * @returns {object} New room with the door appended.
 */
export function addDoor(room, wall, offset, width = 36) {
  if (!DOOR_WALLS.includes(wall)) throw new Error(`Invalid door wall: ${wall}`);
  const len = wall === 'n' || wall === 's' ? room.w : room.h;
  const clamped = Math.min(Math.max(offset, 0), len);
  return {
    ...room,
    doors: [...room.doors, { wall, offset: clamped, width }],
  };
}

/** Remove a door by index. @returns {object} New room. */
export function deleteDoor(room, index) {
  return { ...room, doors: room.doors.filter((_, i) => i !== index) };
}

/**
 * Absolute segment of a door opening in plan coordinates.
 * @returns {{x1:number,y1:number,x2:number,y2:number}}
 */
export function doorSegment(room, door) {
  const { x, y, w, h } = room;
  const half = door.width / 2;
  switch (door.wall) {
    case 'n':
      return { x1: x + door.offset - half, y1: y, x2: x + door.offset + half, y2: y };
    case 's':
      return {
        x1: x + door.offset - half,
        y1: y + h,
        x2: x + door.offset + half,
        y2: y + h,
      };
    case 'w':
      return { x1: x, y1: y + door.offset - half, x2: x, y2: y + door.offset + half };
    case 'e':
      return {
        x1: x + w,
        y1: y + door.offset - half,
        x2: x + w,
        y2: y + door.offset + half,
      };
    default:
      throw new Error(`Invalid door wall: ${door.wall}`);
  }
}

const GRID_MINOR = 20;
const GRID_MAJOR = 100;

function drawGrid(ctx, view, width, height) {
  const { panX, panY, zoom } = view;
  const minor = GRID_MINOR * zoom;
  const major = GRID_MAJOR * zoom;
  const startX = panX % minor;
  const startY = panY % minor;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.06)';
  ctx.beginPath();
  for (let x = startX; x <= width; x += minor) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = startY; y <= height; y += minor) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0, 255, 255, 0.14)';
  ctx.beginPath();
  const majorStartX = panX % major;
  const majorStartY = panY % major;
  for (let x = majorStartX; x <= width; x += major) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = majorStartY; y <= height; y += major) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** World-to-screen transform used by the renderer. */
export function worldToScreen(view, wx, wy) {
  return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
}

/** Screen-to-world (inverse). */
export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}

function strokeRoomWalls(ctx, room, view, selected, showDoors) {
  const p1 = worldToScreen(view, room.x, room.y);
  const p2 = worldToScreen(view, room.x + room.w, room.y + room.h);
  ctx.save();
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeStyle = selected ? 'rgba(0, 255, 255, 0.95)' : 'rgba(0, 255, 255, 0.55)';
  // Draw each wall as segments split around door gaps.
  const walls = [
    { wall: 'n', from: p1, to: { x: p2.x, y: p1.y } },
    { wall: 's', from: { x: p1.x, y: p2.y }, to: p2 },
    { wall: 'w', from: p1, to: { x: p1.x, y: p2.y } },
    { wall: 'e', from: { x: p2.x, y: p1.y }, to: p2 },
  ];
  for (const { wall, from, to } of walls) {
    const gaps = showDoors
      ? room.doors
          .filter((d) => d.wall === wall)
          .map((d) => doorSegment(room, d))
          .map((seg) => {
            const a = worldToScreen(view, seg.x1, seg.y1);
            const b = worldToScreen(view, seg.x2, seg.y2);
            return wall === 'n' || wall === 's'
              ? { a: a.x, b: b.x }
              : { a: a.y, b: b.y };
          })
          .sort((g1, g2) => g1.a - g2.a)
      : [];
    const along = wall === 'n' || wall === 's';
    const start = along ? from.x : from.y;
    const end = along ? to.x : to.y;
    let cursor = start;
    const drawSeg = (s0, s1) => {
      if (s1 <= s0) return;
      ctx.beginPath();
      if (along) {
        ctx.moveTo(s0, from.y);
        ctx.lineTo(s1, from.y);
      } else {
        ctx.moveTo(from.x, s0);
        ctx.lineTo(from.x, s1);
      }
      ctx.stroke();
    };
    for (const gap of gaps) {
      drawSeg(cursor, Math.max(gap.a, cursor));
      cursor = Math.max(cursor, gap.b);
    }
    drawSeg(cursor, end);
  }
  ctx.restore();
}

function drawDoors(ctx, room, view) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 200, 80, 0.9)';
  ctx.lineWidth = 3;
  for (const door of room.doors) {
    const seg = doorSegment(room, door);
    const a = worldToScreen(view, seg.x1, seg.y1);
    const b = worldToScreen(view, seg.x2, seg.y2);
    // Swing arc marker: quarter circle from the door start point.
    const r = door.width * view.zoom;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.beginPath();
    const dir = door.wall === 'n' ? 1 : door.wall === 's' ? -1 : 0;
    const dirX = door.wall === 'w' ? 1 : door.wall === 'e' ? -1 : 0;
    const startAngle = Math.atan2(dir, dirX || 1e-9);
    ctx.arc(a.x, a.y, Math.max(r, 4), startAngle, startAngle + Math.PI / 2, dirX < 0);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Render the floor plan onto a 2D context.
 * @param {CanvasRenderingContext2D} ctx - Duck-typed 2D context.
 * @param {object} state - {rooms, selectedRoomId}.
 * @param {object} view - {panX, panY, zoom}.
 * @param {number} width - Canvas CSS pixel width.
 * @param {number} height - Canvas CSS pixel height.
 */
export function renderFloorplan(ctx, state, view, width, height) {
  if (!ctx) return;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(2, 10, 14, 1)';
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, view, width, height);

  for (const room of state.rooms) {
    const p = worldToScreen(view, room.x, room.y);
    const w = room.w * view.zoom;
    const h = room.h * view.zoom;
    const selected = room.id === state.selectedRoomId;
    ctx.fillStyle = selected
      ? 'rgba(0, 255, 255, 0.10)'
      : 'rgba(0, 255, 255, 0.045)';
    ctx.fillRect(p.x, p.y, w, h);
    strokeRoomWalls(ctx, room, view, selected, true);
    drawDoors(ctx, room, view);
    if (room.label) {
      ctx.fillStyle = 'rgba(220, 255, 255, 0.85)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(room.label, p.x + 6, p.y + 18);
    }
    if (selected) {
      const handles = roomHandles(room);
      ctx.fillStyle = 'rgba(0, 255, 255, 0.95)';
      for (const [hx, hy] of Object.values(handles)) {
        const s = worldToScreen(view, hx, hy);
        ctx.fillRect(s.x - 4, s.y - 4, 8, 8);
      }
    }
  }
  ctx.restore();
}
